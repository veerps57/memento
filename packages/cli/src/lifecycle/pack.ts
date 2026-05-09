// `memento pack <action>` — lifecycle wrapper around the
// `pack.*` registered command set.
//
// Four actions:
//   memento pack install <id-or-path> [--from-file=<path>] [--from-url=<url>] [--dry-run]
//   memento pack preview <id-or-path> [--from-file=<path>] [--from-url=<url>]
//   memento pack uninstall <id>       [--version=<v> | --all-versions] [--dry-run] [--confirm]
//   memento pack list
//
// `pack install` / `pack preview` accept either a bare bundled id
// (looked up against `packs.bundledRegistryPath`) or one of
// `--from-file=<path>` / `--from-url=<url>`. When a positional is
// supplied AND a flag is supplied, the flag wins (so the caller
// can pass `--from-file=./local.yaml` even if a directory in the
// bundled registry shares a name).
//
// CLI scope override is intentionally not exposed in v1 — the
// MCP and dashboard surfaces accept structured `Scope` inputs;
// CLI users get the manifest's `defaults.scope` (typically
// global). A future flag set (`--scope-global` /
// `--scope-workspace` / `--scope-repo`) lands without breaking
// existing callers.

import { executeCommand } from '@psraghuveer/memento-core';
import { type Result, err, ok } from '@psraghuveer/memento-schema';

import { resolveVersion } from '../version.js';

import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

export type PackAction = 'install' | 'preview' | 'uninstall' | 'list';

interface PackArgs {
  readonly action: PackAction;
  readonly positional: string | null;
  readonly fromFile: string | null;
  readonly fromUrl: string | null;
  readonly version: string | null;
  readonly allVersions: boolean;
  readonly dryRun: boolean;
  readonly confirm: boolean;
}

const KNOWN_ACTIONS: readonly PackAction[] = ['install', 'preview', 'uninstall', 'list'];

function isPackAction(value: string): value is PackAction {
  return (KNOWN_ACTIONS as readonly string[]).includes(value);
}

export const packCommand: LifecycleCommand = {
  name: 'pack',
  description:
    'Install, preview, uninstall, or list memento packs (curated YAML bundles, ADR-0020).',
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
  });
}
