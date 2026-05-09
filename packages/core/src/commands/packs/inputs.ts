// `pack.*` command inputs — Zod schemas.
//
// These describe the wire shapes of the four pack commands
// (`install`, `preview`, `uninstall`, `list`) plus their
// outputs. Shared between the registry command factory and any
// adapter (CLI, MCP, dashboard) that calls them.

import {
  MemoryIdSchema,
  PackIdSchema,
  PackVersionSchema,
  ScopeSchema,
} from '@psraghuveer/memento-schema';
import { z } from 'zod';

import { confirmGate } from '../confirm-gate.js';

// — `pack.install` & `pack.preview` —

/**
 * Discriminated union over the three install-time sources. The
 * CLI lifecycle command translates `<id>` / `--from-file` /
 * `--from-url` into one of these; the MCP surface accepts the
 * same shape verbatim.
 */
export const PackSourceInputSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('bundled'),
      id: PackIdSchema.describe('Pack id resolved against `packs.bundledRegistryPath`.'),
      version: PackVersionSchema.optional().describe(
        'Optional explicit version. When omitted the bundled resolver picks the highest semver under `packs/<id>/`.',
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal('file'),
      path: z.string().min(1).describe('Filesystem path to a `memento-pack/v1` YAML file.'),
    })
    .strict(),
  z
    .object({
      type: z.literal('url'),
      url: z
        .string()
        .url()
        .describe('HTTPS URL of a `memento-pack/v1` YAML file. Gated by `packs.allowRemoteUrls`.'),
    })
    .strict(),
]);
export type PackSourceInput = z.infer<typeof PackSourceInputSchema>;

export const PackInstallInputSchema = z
  .object({
    source: PackSourceInputSchema,
    scope: ScopeSchema.optional().describe(
      "Optional scope override. When supplied, takes precedence over the manifest's `defaults.scope`. Defaults to `{type:'global'}` when neither is set.",
    ),
    dryRun: z
      .boolean()
      .optional()
      .default(false)
      .describe('When true, return what would be written without persisting.'),
  })
  .strict();
export type PackInstallInput = z.infer<typeof PackInstallInputSchema>;

export const PackPreviewInputSchema = z
  .object({
    source: PackSourceInputSchema,
    scope: ScopeSchema.optional(),
  })
  .strict();
export type PackPreviewInput = z.infer<typeof PackPreviewInputSchema>;

// — `pack.uninstall` —

export const PackUninstallInputSchema = z
  .object({
    id: PackIdSchema,
    version: PackVersionSchema.optional().describe(
      'Specific version to uninstall. Omit and pass `allVersions: true` to remove every version.',
    ),
    allVersions: z
      .boolean()
      .optional()
      .default(false)
      .describe('When true, every version of the pack is uninstalled. `version` must be omitted.'),
    scope: ScopeSchema.optional().describe(
      'Scope to clean. When omitted, every scope is searched (rare; usually you want to pass the same scope you installed into).',
    ),
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        'Dry-run defaults to true (rehearsal). Set to false to actually forget. Per ADR-0014.',
      ),
    confirm: confirmGate().describe(
      'Required `true`. Per ADR-0014: destructive verbs require explicit acknowledgement even in dry-run.',
    ),
  })
  .strict()
  .refine((v) => !(v.allVersions === true && v.version !== undefined), {
    message: 'pack.uninstall: cannot pass both `allVersions: true` and an explicit `version`',
    path: ['version'],
  })
  .refine((v) => v.allVersions === true || v.version !== undefined, {
    message: 'pack.uninstall: pass either `version` or `allVersions: true`',
    path: ['version'],
  });
export type PackUninstallInput = z.infer<typeof PackUninstallInputSchema>;

// — `pack.list` —

export const PackListInputSchema = z
  .object({
    scope: ScopeSchema.optional().describe(
      'Optional scope filter. When omitted, lists installed packs across every scope.',
    ),
  })
  .strict();
export type PackListInput = z.infer<typeof PackListInputSchema>;

// — Outputs —

const PackPreviewItemSchema = z
  .object({
    kind: z.enum(['fact', 'preference', 'decision', 'todo', 'snippet']),
    content: z.string(),
    summary: z.string().nullable(),
    tags: z.array(z.string()),
    pinned: z.boolean(),
    rationale: z.string().nullable().optional(),
    due: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
  })
  .strict();

const PackPreviewBaseShape = {
  packId: PackIdSchema,
  version: PackVersionSchema,
  title: z.string(),
  description: z.string().optional(),
  scope: ScopeSchema,
  itemCount: z.number().int().nonnegative(),
  items: z.array(PackPreviewItemSchema),
  warnings: z.array(z.string()),
  state: z.enum(['fresh', 'idempotent', 'drift']),
  driftReason: z.string().optional(),
} as const;

export const PackPreviewOutputSchema = z.object(PackPreviewBaseShape).strict();
export type PackPreviewOutput = z.infer<typeof PackPreviewOutputSchema>;

export const PackInstallOutputSchema = z
  .object({
    ...PackPreviewBaseShape,
    dryRun: z.boolean(),
    /** Memory ids written by this install. Empty in dry-run; empty when the install was idempotent. */
    written: z.array(MemoryIdSchema),
    /** True when the install was a no-op because the manifest matched the existing memories byte-for-byte (per drift check). */
    alreadyInstalled: z.boolean(),
  })
  .strict();
export type PackInstallOutput = z.infer<typeof PackInstallOutputSchema>;

export const PackUninstallOutputSchema = z
  .object({
    dryRun: z.boolean(),
    matched: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    ids: z.array(MemoryIdSchema),
    packId: PackIdSchema,
    /** Specific version uninstalled, or null when `allVersions: true`. */
    version: PackVersionSchema.nullable(),
  })
  .strict();
export type PackUninstallOutput = z.infer<typeof PackUninstallOutputSchema>;

export const PackListOutputSchema = z
  .object({
    packs: z.array(
      z
        .object({
          id: PackIdSchema,
          version: PackVersionSchema,
          scope: ScopeSchema,
          /** Active memories carrying this pack's tag in the named scope. */
          count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
export type PackListOutput = z.infer<typeof PackListOutputSchema>;
