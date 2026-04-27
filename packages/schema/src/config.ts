import { z } from 'zod';
import { ActorRefSchema } from './actors.js';
import { EventIdSchema, TimestampSchema } from './primitives.js';

/**
 * `ConfigSource` mirrors the layering documented in
 * `docs/architecture/config.md`. Order is **lowest precedence first**:
 * a value from a higher-index source overrides a lower one for the
 * same key. The order is also the one persisted in `ConfigEvent`,
 * so historical queries can answer "was this set by CLI or MCP?".
 */
export const CONFIG_SOURCES = [
  'default',
  'user-file',
  'workspace-file',
  'env',
  'cli',
  'mcp',
] as const;
export const ConfigSourceSchema = z.enum(CONFIG_SOURCES);
export type ConfigSource = z.infer<typeof ConfigSourceSchema>;

/**
 * Every behavior knob in Memento is addressable by a dotted
 * `ConfigKey` (e.g. `retrieval.vector.enabled`). The exhaustive list
 * lives in `@psraghuveer/memento-schema/config-keys` (generated reference) and
 * is validated against a per-key Zod schema before merging.
 *
 * At this layer we only enforce structural shape — non-empty,
 * dotted segments of `[a-z][a-z0-9-]*`. The set of *valid* keys is
 * a higher-level concern.
 */
export const ConfigKeySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z][A-Za-z0-9-]*(\.[a-z0-9][A-Za-z0-9-]*)+$/, {
    message: 'config key must be dot-separated identifiers',
  });

/**
 * A `ConfigValue` is any JSON-serialisable value. Per-key value
 * schemas constrain this further; here we only assert that the
 * value can round-trip through the persistence layer.
 */
export const ConfigValueSchema: z.ZodType<unknown> = z.unknown().refine((v) => v !== undefined, {
  message: 'value is required (use null for unset)',
});
export type ConfigValue = z.infer<typeof ConfigValueSchema>;

/**
 * `ConfigEntry` is the resolved value for a key, with provenance.
 * It is what callers see after layering: the winning source, the
 * actor who set it (when applicable), and when.
 *
 * `setBy` is nullable because defaults and file-sourced values are
 * not associated with an actor — only `cli` and `mcp` writes are.
 */
export const ConfigEntrySchema = z
  .object({
    key: ConfigKeySchema,
    value: ConfigValueSchema,
    source: ConfigSourceSchema,
    setAt: TimestampSchema,
    setBy: ActorRefSchema.nullable(),
  })
  .strict();
export type ConfigEntry = z.infer<typeof ConfigEntrySchema>;

/**
 * `ConfigEvent` is an entry in the configuration audit log. Every
 * `config.set` and `config.unset` produces one; they are append-only
 * and queryable via `memento config history --key=<key>`.
 *
 * `oldValue` is `null` for the first set of a key from a runtime
 * source (`cli`, `mcp`); `newValue` is `null` for an unset.
 */
export const ConfigEventSchema = z
  .object({
    id: EventIdSchema,
    key: ConfigKeySchema,
    oldValue: ConfigValueSchema.nullable(),
    newValue: ConfigValueSchema.nullable(),
    source: ConfigSourceSchema,
    actor: ActorRefSchema,
    at: TimestampSchema,
  })
  .strict();
export type ConfigEvent = z.infer<typeof ConfigEventSchema>;
