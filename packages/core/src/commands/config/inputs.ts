// Wire-shape input schemas for the `config.*` command set.
//
// Per-key value validation happens inside the handlers, against
// `CONFIG_KEYS[key].schema`. The structural input schema only
// asserts that the key is a registered name and (for `config.set`)
// that some `value` was supplied. `value` is `z.unknown()` —
// the registry's per-key schema is the real validator.

import { CONFIG_KEY_NAMES, type ConfigKey } from '@psraghuveer/memento-schema';
import { z } from 'zod';

const KNOWN_KEYS = new Set<string>(CONFIG_KEY_NAMES);

/** Accepts only keys registered in `CONFIG_KEYS`. */
const ConfigKeyArgSchema = z
  .string()
  .describe(
    'A registered config key name (dotted path). Examples: "retrieval.decay.halfLifeDays", "scrubber.enabled", "privacy.redactSensitiveSnippets". Use config.list to see all available keys.',
  )
  .refine((k): k is ConfigKey => KNOWN_KEYS.has(k), {
    message: 'unknown config key',
  });

/** `config.get`, `config.unset`. */
export const ConfigKeyInputSchema = z
  .object({
    key: ConfigKeyArgSchema,
  })
  .strict();

/**
 * `config.list`. Optional dotted prefix filter (e.g. `'retrieval.'`).
 * No pagination — the registry is small (~tens of keys).
 */
export const ConfigListInputSchema = z
  .object({
    prefix: z
      .string()
      .optional()
      .describe(
        'Optional dotted prefix to filter keys. Example: "retrieval." returns all retrieval.* keys. Omit for all keys.',
      ),
  })
  .strict();

/**
 * `config.set`. The structural schema is intentionally
 * permissive on `value`; the handler runs the per-key Zod
 * schema and surfaces failures as `INVALID_INPUT`.
 */
export const ConfigSetInputSchema = z
  .object({
    key: ConfigKeyArgSchema,
    value: z.unknown().describe('The value to set. Type depends on the key — use config.get to see the current value and infer the expected type.'),
  })
  .strict();

/**
 * `config.history`. Returns events oldest-first; `limit` caps
 * the row count when supplied.
 */
export const ConfigHistoryInputSchema = z
  .object({
    key: ConfigKeyArgSchema,
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum number of history entries to return.'),
  })
  .strict();
