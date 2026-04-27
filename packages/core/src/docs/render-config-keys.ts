// Renders `docs/reference/config-keys.md` from `CONFIG_KEYS` in
// `@psraghuveer/memento-schema`.
//
// `CONFIG_KEYS` is a frozen registry of dotted config keys with
// per-key Zod schema, default, mutability, and one-sentence
// description. The renderer projects it into a Markdown table
// ordered by namespace (registry insertion order). The default
// is rendered through `JSON.stringify` so callers can see the
// exact value the runtime starts with — including object-shaped
// defaults like `scrubber.rules`.

import type { ConfigKeyDefinition } from '@psraghuveer/memento-schema';
import { renderHeader } from './shared.js';

const DEFAULT_PREVIEW_LIMIT = 80;

function namespaceOf(key: string): string {
  const dot = key.indexOf('.');
  return dot === -1 ? key : key.slice(0, dot);
}

function renderDefault(value: unknown): string {
  // JSON.stringify of `undefined` is `undefined` (not a string);
  // CONFIG_KEYS does not allow undefined defaults but we guard
  // anyway so the renderer is total over `unknown`.
  if (value === undefined) return '`undefined`';
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length > DEFAULT_PREVIEW_LIMIT) {
    text = `${text.slice(0, DEFAULT_PREVIEW_LIMIT - 1)}…`;
  }
  // Backticks inside the value would break the Markdown code
  // span; escape by switching to a HTML-safe span. CONFIG_KEYS
  // values are JSON-shaped so this is a defensive guard.
  if (text.includes('`')) {
    return `<code>${text.replace(/`/g, '\\`')}</code>`;
  }
  return `\`${text}\``;
}

export function renderConfigKeysDoc(
  keys: Readonly<Record<string, ConfigKeyDefinition<unknown>>>,
): string {
  const entries = Object.entries(keys);
  const lines: string[] = [];
  lines.push(
    renderHeader('Config Keys', '@psraghuveer/memento-schema/config-keys', [
      'Every behavioural knob in Memento is addressable by a dotted `ConfigKey` and validated by a per-key Zod schema.',
      'The defaults below are the values the runtime starts with when no override is provided by user, workspace, env, CLI, or MCP.',
      'Keys marked **immutable** may not be changed after server start — `config.set` against them returns an `IMMUTABLE` error.',
    ]),
  );
  lines.push('');
  lines.push(`Total: ${entries.length} key${entries.length === 1 ? '' : 's'}.`);
  lines.push('');

  // Group by namespace, preserving registry order.
  const byNamespace = new Map<string, [string, ConfigKeyDefinition<unknown>][]>();
  const order: string[] = [];
  for (const [name, def] of entries) {
    const ns = namespaceOf(name);
    let bucket = byNamespace.get(ns);
    if (bucket === undefined) {
      bucket = [];
      byNamespace.set(ns, bucket);
      order.push(ns);
    }
    bucket.push([name, def]);
  }

  for (const ns of order) {
    lines.push(`## \`${ns}.*\``);
    lines.push('');
    lines.push('| Key | Default | Mutable | Description |');
    lines.push('| --- | --- | --- | --- |');
    const bucket = byNamespace.get(ns);
    if (bucket === undefined) continue;
    for (const [name, def] of bucket) {
      const mutable = def.mutable ? 'yes' : 'no';
      const description = def.description.replace(/\|/g, '\\|');
      lines.push(`| \`${name}\` | ${renderDefault(def.default)} | ${mutable} | ${description} |`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
