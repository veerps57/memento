// `memento pack <action>` — lifecycle wrapper around the
// `pack.*` registered command set.
//
// Five actions:
//   memento pack install <id-or-path> [--from-file=<path>] [--from-url=<url>] [--dry-run]
//   memento pack preview <id-or-path> [--from-file=<path>] [--from-url=<url>]
//   memento pack uninstall <id>       [--version=<v> | --all-versions] [--dry-run] [--confirm]
//   memento pack list
//   memento pack create --out <path> --id <id> --version <v> --title <t>
//                       [--description <d>] [--author <a>] [--license <l>] [--homepage <u>]
//                       [--scope-global | --scope-workspace=<path> | --scope-repo=<remote>]
//                       [--kind <k>] [--tag <t> ...] [--pinned]
//
// `pack install` / `pack preview` accept either a bare bundled id
// (looked up against `packs.bundledRegistryPath`) or one of
// `--from-file=<path>` / `--from-url=<url>`. When a positional is
// supplied AND a flag is supplied, the flag wins (so the caller
// can pass `--from-file=./local.yaml` even if a directory in the
// bundled registry shares a name).
//
// `pack create` runs the read-only `pack.export` registry command
// over a `MemoryListFilter` and writes the resulting YAML to
// `--out` (or to stdout when `--out=-`). The CLI's scope/kind/tag/
// pinned flags map to the same `MemoryListFilter` shape that
// `memory.list` uses — assistants and dashboard callers pass the
// structured `filter` object directly.

import { writeFile } from 'node:fs/promises';

import {
  type MementoApp,
  buildManifestFromMemories,
  executeCommand,
} from '@psraghuveer/memento-core';
import { type Result, type Scope, err, ok } from '@psraghuveer/memento-schema';

import { resolveVersion } from '../version.js';

import type { PackCreatePrompter } from './pack-prompts.js';
import type { ReviewMemoryItem } from './pack-types.js';
import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

export type PackAction = 'install' | 'preview' | 'uninstall' | 'list' | 'create';

interface PackArgs {
  readonly action: PackAction;
  readonly positional: string | null;
  readonly fromFile: string | null;
  readonly fromUrl: string | null;
  readonly version: string | null;
  readonly allVersions: boolean;
  readonly dryRun: boolean;
  readonly confirm: boolean;
  // create-specific
  readonly out: string | null;
  readonly id: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly author: string | null;
  readonly license: string | null;
  readonly homepage: string | null;
  readonly filterKind: string | null;
  readonly filterTags: readonly string[];
  readonly filterPinned: boolean;
  readonly filterScope: Scope | null;
}

const KNOWN_ACTIONS: readonly PackAction[] = ['install', 'preview', 'uninstall', 'list', 'create'];

function isPackAction(value: string): value is PackAction {
  return (KNOWN_ACTIONS as readonly string[]).includes(value);
}

export const packCommand: LifecycleCommand = {
  name: 'pack',
  description:
    'Install, preview, uninstall, list, or author memento packs (curated YAML bundles, ADR-0020).',
  run: runPack,
};

export async function runPack(
  deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<unknown>> {
  const args = parsePackArgs(input.subargs);
  if (!args.ok) return args;
  const a = args.value;

  const app = await deps.createApp({
    dbPath: input.env.dbPath,
    appVersion: resolveVersion(),
  });

  try {
    switch (a.action) {
      case 'install':
        return await runInstall(app, a);
      case 'preview':
        return await runPreview(app, a);
      case 'uninstall':
        return await runUninstall(app, a);
      case 'list':
        return await runList(app);
      case 'create':
        return await runCreate(app, a, input.io.isTTY === true, deps.createPackPrompter);
    }
  } finally {
    app.close();
  }
}

async function runInstall(
  app: Awaited<ReturnType<LifecycleDeps['createApp']>>,
  a: PackArgs,
): Promise<Result<unknown>> {
  const source = buildSourceFromArgs(a);
  if (!source.ok) return source;
  const command = app.registry.get('pack.install');
  if (!command) {
    return err({ code: 'INTERNAL', message: 'pack.install command is not registered' });
  }
  return executeCommand(
    command,
    {
      source: source.value,
      dryRun: a.dryRun,
    },
    { actor: { type: 'cli' } },
  );
}

async function runPreview(
  app: Awaited<ReturnType<LifecycleDeps['createApp']>>,
  a: PackArgs,
): Promise<Result<unknown>> {
  const source = buildSourceFromArgs(a);
  if (!source.ok) return source;
  const command = app.registry.get('pack.preview');
  if (!command) {
    return err({ code: 'INTERNAL', message: 'pack.preview command is not registered' });
  }
  return executeCommand(command, { source: source.value }, { actor: { type: 'cli' } });
}

async function runUninstall(
  app: Awaited<ReturnType<LifecycleDeps['createApp']>>,
  a: PackArgs,
): Promise<Result<unknown>> {
  if (a.positional === null) {
    return err({ code: 'INVALID_INPUT', message: 'pack uninstall requires a pack id' });
  }
  if (!a.allVersions && a.version === null) {
    return err({
      code: 'INVALID_INPUT',
      message: 'pack uninstall requires either --version=<v> or --all-versions',
    });
  }
  const command = app.registry.get('pack.uninstall');
  if (!command) {
    return err({ code: 'INTERNAL', message: 'pack.uninstall command is not registered' });
  }
  return executeCommand(
    command,
    {
      id: a.positional,
      ...(a.allVersions ? { allVersions: true } : { version: a.version }),
      dryRun: a.dryRun,
      confirm: a.confirm,
    },
    { actor: { type: 'cli' } },
  );
}

async function runList(
  app: Awaited<ReturnType<LifecycleDeps['createApp']>>,
): Promise<Result<unknown>> {
  const command = app.registry.get('pack.list');
  if (!command) {
    return err({ code: 'INTERNAL', message: 'pack.list command is not registered' });
  }
  return executeCommand(command, {}, { actor: { type: 'cli' } });
}

async function runCreate(
  app: MementoApp,
  a: PackArgs,
  stdinIsTty: boolean,
  prompterFactory: (() => PackCreatePrompter) | undefined,
): Promise<Result<unknown>> {
  const required: ReadonlyArray<readonly [keyof PackArgs, string]> = [
    ['out', '--out'],
    ['version', '--version'],
    ['title', '--title'],
  ];
  // `id` is taken from positional for symmetry with install/preview;
  // accept --id=<id> as an alternative for scriptability.
  const id = a.id ?? a.positional;
  if (id === null) {
    return err({
      code: 'INVALID_INPUT',
      message: 'pack create requires <id> (positional) or --id=<id>',
    });
  }
  for (const [key, flagName] of required) {
    if (a[key] === null) {
      return err({
        code: 'INVALID_INPUT',
        message: `pack create requires ${flagName}=<value>`,
      });
    }
  }

  // Interactive review triggers when stdin is a TTY AND no
  // filter flags were supplied. ADR-0020 §Authoring: passing any
  // `--filter` makes the command non-interactive (so scripted
  // pipelines stay deterministic).
  const hasFilterFlags =
    a.filterKind !== null || a.filterTags.length > 0 || a.filterPinned || a.filterScope !== null;
  if (stdinIsTty && !hasFilterFlags) {
    return runCreateInteractive(app, a, id, prompterFactory);
  }

  return runCreateNonInteractive(app, a, id);
}

async function runCreateNonInteractive(
  app: MementoApp,
  a: PackArgs,
  id: string,
): Promise<Result<unknown>> {
  const command = app.registry.get('pack.export');
  if (!command) {
    return err({ code: 'INTERNAL', message: 'pack.export command is not registered' });
  }

  const exportInput = {
    packId: id,
    version: a.version,
    title: a.title,
    ...(a.description !== null ? { description: a.description } : {}),
    ...(a.author !== null ? { author: a.author } : {}),
    ...(a.license !== null ? { license: a.license } : {}),
    ...(a.homepage !== null ? { homepage: a.homepage } : {}),
    filter: {
      ...(a.filterScope !== null ? { scope: a.filterScope } : {}),
      ...(a.filterKind !== null ? { kind: a.filterKind } : {}),
      ...(a.filterTags.length > 0 ? { tags: [...a.filterTags] } : {}),
      ...(a.filterPinned ? { pinned: true } : {}),
    },
  };

  const result = await executeCommand(command, exportInput, { actor: { type: 'cli' } });
  if (!result.ok) return result;

  const value = result.value as { yaml: string; exported: number; warnings: string[] };
  return await writeOrStdout(a.out, value.yaml, {
    out: a.out,
    packId: id,
    version: a.version,
    exported: value.exported,
    warnings: value.warnings,
  });
}

async function runCreateInteractive(
  app: MementoApp,
  a: PackArgs,
  id: string,
  prompterFactory: (() => PackCreatePrompter) | undefined,
): Promise<Result<unknown>> {
  if (!prompterFactory) {
    return err({
      code: 'INTERNAL',
      message:
        'pack create: interactive mode required but no prompter factory was wired in LifecycleDeps',
    });
  }
  const prompter = prompterFactory();

  prompter.intro?.('memento pack create');

  // List every active memory in the user's store. The
  // interactive review handles narrowing — no scope filter
  // applies because the user picks per-memory.
  let memories: Awaited<ReturnType<typeof app.memoryRepository.list>>;
  try {
    memories = await app.memoryRepository.list({ status: 'active' });
  } catch (cause) {
    return err({
      code: 'STORAGE_ERROR',
      message: `pack create: failed to list memories: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  if (memories.length === 0) {
    return err({
      code: 'INVALID_INPUT',
      message: 'pack create: no active memories to review.',
    });
  }

  const reviewItems: ReviewMemoryItem[] = memories.map((m) => ({
    id: m.id,
    kind: m.kind.type,
    content: m.content,
    tags: [...m.tags],
  }));
  const review = await prompter.reviewMemories(reviewItems);
  if (review.kind === 'cancelled') {
    return err({ code: 'INVALID_INPUT', message: 'pack create: cancelled by user.' });
  }
  const kept = review.kept ?? [];
  if (kept.length === 0) {
    return err({
      code: 'INVALID_INPUT',
      message: 'pack create: no memories kept; a pack must include at least one.',
    });
  }

  // Build the manifest directly via the engine so we can pass
  // an explicit subset (the registry's pack.export takes a
  // filter, not an id list).
  const keptIdSet = new Set(kept.map((k) => k.id));
  const keptMemories = memories.filter((m) => keptIdSet.has(m.id));
  const outcome = buildManifestFromMemories(keptMemories, {
    packId: id as never,
    version: a.version as never,
    title: a.title as string,
    ...(a.description !== null ? { description: a.description } : {}),
    ...(a.author !== null ? { author: a.author } : {}),
    ...(a.license !== null ? { license: a.license } : {}),
    ...(a.homepage !== null ? { homepage: a.homepage } : {}),
  });
  if (!outcome.ok) {
    if (outcome.error.kind === 'MULTI_SCOPE') {
      return err({
        code: 'INVALID_INPUT',
        message: `pack create: kept memories span ${outcome.error.scopeCount} scopes; pack manifests are single-scope. Cancel and re-run with a narrower selection.`,
      });
    }
    if (outcome.error.kind === 'INVALID_MANIFEST') {
      return err({
        code: 'INVALID_INPUT',
        message: `pack create: rendered manifest failed validation: ${outcome.error.issues.join('; ')}`,
      });
    }
    // EMPTY case is covered above; this branch is exhaustive.
    return err({
      code: 'INVALID_INPUT',
      message: 'pack create: nothing to write.',
    });
  }

  const confirm = await prompter.confirmWrite({
    keptCount: outcome.value.exported,
    outPath: a.out as string,
  });
  if (confirm.kind === 'cancelled' || confirm.confirmed === false) {
    return err({ code: 'INVALID_INPUT', message: 'pack create: cancelled by user.' });
  }

  prompter.outro?.(
    `wrote ${outcome.value.exported} memor${outcome.value.exported === 1 ? 'y' : 'ies'} to ${a.out}`,
  );

  return await writeOrStdout(a.out, outcome.value.yaml, {
    out: a.out,
    packId: id,
    version: a.version,
    exported: outcome.value.exported,
    warnings: [...outcome.value.warnings],
  });
}

/**
 * Write the rendered YAML to `out` (or stdout when `out === '-'`)
 * and return the supplied snapshot wrapped in `ok`. Surface IO
 * errors as `STORAGE_ERROR` rather than throwing.
 */
async function writeOrStdout(
  out: string | null,
  yaml: string,
  snapshot: Record<string, unknown>,
): Promise<Result<unknown>> {
  if (out === '-') {
    process.stdout.write(yaml);
  } else if (out !== null) {
    try {
      await writeFile(out, yaml, 'utf8');
    } catch (cause) {
      return err({
        code: 'STORAGE_ERROR',
        message: `pack create: failed to write to '${out}': ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }
  return ok(snapshot);
}

function buildSourceFromArgs(a: PackArgs): Result<unknown> {
  if (a.fromFile !== null) {
    return ok({ type: 'file', path: a.fromFile });
  }
  if (a.fromUrl !== null) {
    return ok({ type: 'url', url: a.fromUrl });
  }
  if (a.positional !== null) {
    return ok({
      type: 'bundled',
      id: a.positional,
      ...(a.version !== null ? { version: a.version } : {}),
    });
  }
  return err({
    code: 'INVALID_INPUT',
    message: `pack ${a.action} requires either a bundled <id>, --from-file=<path>, or --from-url=<url>`,
  });
}

function parsePackArgs(subargs: readonly string[]): Result<PackArgs> {
  const args = [...subargs];
  if (args.length === 0) {
    return err({
      code: 'INVALID_INPUT',
      message: `pack: action required. Valid actions: ${KNOWN_ACTIONS.join(', ')}.`,
    });
  }
  const head = args.shift() as string;
  if (!isPackAction(head)) {
    return err({
      code: 'INVALID_INPUT',
      message: `pack: unknown action '${head}'. Valid actions: ${KNOWN_ACTIONS.join(', ')}.`,
    });
  }

  let positional: string | null = null;
  let fromFile: string | null = null;
  let fromUrl: string | null = null;
  let version: string | null = null;
  let allVersions = false;
  let dryRun = false;
  let confirm = false;
  let out: string | null = null;
  let id: string | null = null;
  let title: string | null = null;
  let description: string | null = null;
  let author: string | null = null;
  let license: string | null = null;
  let homepage: string | null = null;
  let filterKind: string | null = null;
  const filterTags: string[] = [];
  let filterPinned = false;
  let filterScope: Scope | null = null;

  while (args.length > 0) {
    const arg = args.shift() as string;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--confirm' || arg === '--yes') {
      confirm = true;
      continue;
    }
    if (arg === '--all-versions') {
      allVersions = true;
      continue;
    }
    if (arg === '--pinned') {
      filterPinned = true;
      continue;
    }
    if (arg === '--scope-global') {
      if (filterScope !== null) {
        return err({
          code: 'INVALID_INPUT',
          message: 'pack create: --scope-* flags are mutually exclusive',
        });
      }
      filterScope = { type: 'global' };
      continue;
    }

    const flagWithValue = (name: string): string | null => {
      if (arg === `--${name}`) {
        const next = args.shift();
        if (next === undefined) {
          return null;
        }
        return next;
      }
      if (arg.startsWith(`--${name}=`)) {
        return arg.slice(`--${name}=`.length);
      }
      return null;
    };

    const fromFileValue = flagWithValue('from-file');
    if (fromFileValue !== null) {
      fromFile = fromFileValue;
      continue;
    }
    const fromUrlValue = flagWithValue('from-url');
    if (fromUrlValue !== null) {
      fromUrl = fromUrlValue;
      continue;
    }
    const versionValue = flagWithValue('version');
    if (versionValue !== null) {
      version = versionValue;
      continue;
    }
    const outValue = flagWithValue('out');
    if (outValue !== null) {
      out = outValue;
      continue;
    }
    const idValue = flagWithValue('id');
    if (idValue !== null) {
      id = idValue;
      continue;
    }
    const titleValue = flagWithValue('title');
    if (titleValue !== null) {
      title = titleValue;
      continue;
    }
    const descriptionValue = flagWithValue('description');
    if (descriptionValue !== null) {
      description = descriptionValue;
      continue;
    }
    const authorValue = flagWithValue('author');
    if (authorValue !== null) {
      author = authorValue;
      continue;
    }
    const licenseValue = flagWithValue('license');
    if (licenseValue !== null) {
      license = licenseValue;
      continue;
    }
    const homepageValue = flagWithValue('homepage');
    if (homepageValue !== null) {
      homepage = homepageValue;
      continue;
    }
    const kindValue = flagWithValue('kind');
    if (kindValue !== null) {
      filterKind = kindValue;
      continue;
    }
    const tagValue = flagWithValue('tag');
    if (tagValue !== null) {
      filterTags.push(tagValue);
      continue;
    }
    const repoScope = flagWithValue('scope-repo');
    if (repoScope !== null) {
      if (filterScope !== null) {
        return err({
          code: 'INVALID_INPUT',
          message: 'pack create: --scope-* flags are mutually exclusive',
        });
      }
      filterScope = { type: 'repo', remote: repoScope as never };
      continue;
    }
    const wsScope = flagWithValue('scope-workspace');
    if (wsScope !== null) {
      if (filterScope !== null) {
        return err({
          code: 'INVALID_INPUT',
          message: 'pack create: --scope-* flags are mutually exclusive',
        });
      }
      filterScope = { type: 'workspace', path: wsScope as never };
      continue;
    }

    if (arg.startsWith('--')) {
      return err({
        code: 'INVALID_INPUT',
        message: `pack ${head}: unknown flag '${arg}'`,
      });
    }
    if (positional !== null) {
      return err({
        code: 'INVALID_INPUT',
        message: `pack ${head}: too many positional arguments`,
      });
    }
    positional = arg;
  }

  return ok({
    action: head,
    positional,
    fromFile,
    fromUrl,
    version,
    allVersions,
    dryRun,
    confirm,
    out,
    id,
    title,
    description,
    author,
    license,
    homepage,
    filterKind,
    filterTags,
    filterPinned,
    filterScope,
  });
}
