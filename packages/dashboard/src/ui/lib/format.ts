// Display formatters for dashboard data.
//
// Kept centralised so the same number/timestamp/scope formats
// appear consistently across stat tiles, lists, and detail
// views.

const RELATIVE_THRESHOLDS: ReadonlyArray<{ readonly ms: number; readonly label: string }> = [
  { ms: 60_000, label: 's' },
  { ms: 3_600_000, label: 'm' },
  { ms: 86_400_000, label: 'h' },
  { ms: 604_800_000, label: 'd' },
  { ms: 2_629_800_000, label: 'w' },
  { ms: 31_557_600_000, label: 'mo' },
];

/**
 * Compact relative-time label: "3s ago", "12m ago", "4d ago",
 * "2mo ago". Past timestamps only — future timestamps return
 * "in <unit>". Used in status bar, activity feed, stat tiles.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (iso === null || iso === undefined) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = now - t;
  const abs = Math.abs(diff);
  if (abs < 1_000) return diff >= 0 ? 'just now' : 'now';
  // Pick the smallest unit where the value is >= 1.
  for (let i = 0; i < RELATIVE_THRESHOLDS.length; i += 1) {
    const next = RELATIVE_THRESHOLDS[i];
    if (next === undefined) break;
    const value = Math.floor(abs / (i === 0 ? 1_000 : (RELATIVE_THRESHOLDS[i - 1]?.ms ?? 1_000)));
    if (abs < next.ms) {
      const suffix = diff >= 0 ? ' ago' : ' from now';
      return `${value}${next.label}${suffix}`;
    }
  }
  // Older than ~1 year — show year count.
  const years = Math.floor(abs / 31_557_600_000);
  return `${years}y${diff >= 0 ? ' ago' : ' from now'}`;
}

/**
 * Subset of the `Scope` discriminated union used by display
 * formatters. Pins the per-variant fields with named properties
 * (rather than the bag-of-string-keys shape the dashboard's API
 * client returns) so dot-access works under strict TS — and so
 * Biome's `useLiteralKeys` rule does not flag what would otherwise
 * be unavoidable index-signature reads.
 *
 * The union mirrors `Scope` from `@psraghuveer/memento-schema`;
 * we keep a local copy rather than importing because the schema
 * package's `Scope` carries Zod-branded `Path` / `RepoRemote`
 * types that the API client erases on the wire.
 */
export type ScopeForDisplay =
  | { readonly type: 'global' }
  | { readonly type: 'workspace'; readonly path: string }
  | { readonly type: 'repo'; readonly remote: string }
  | { readonly type: 'branch'; readonly remote: string; readonly branch: string }
  | { readonly type: 'session'; readonly id: string };

/**
 * Render a `Scope` as a single readable string. Mirrors the
 * write-time canonical form Memento uses internally; it is what
 * the user sees in CLI output and in the dashboard's drill-ins.
 *
 * Accepts a permissive shape (any object carrying `.type`) at
 * the call boundary — the API client returns scopes typed as
 * `{ type: string; [k: string]: unknown }` — and narrows
 * internally to the strongly-typed union per discriminator.
 */
export function formatScope(scope: {
  readonly type: string;
  readonly [k: string]: unknown;
}): string {
  // Re-typing here is sound: the wire shape carries the same
  // fields the schema requires, just with looser typing.
  const s = scope as ScopeForDisplay;
  switch (s.type) {
    case 'global':
      return 'global';
    case 'workspace':
      return `workspace:${s.path}`;
    case 'repo':
      return `repo:${s.remote}`;
    case 'branch':
      return `branch:${s.remote}@${s.branch}`;
    case 'session':
      return `session:${s.id}`;
    default:
      // Unknown variants — fall back to the discriminator alone
      // so a future server-side scope type rendered in an older
      // dashboard at least shows something meaningful.
      return scope.type;
  }
}

/**
 * Compact integer formatter. 1234 → "1.2k", 1_500_000 → "1.5M".
 * Used on stat tiles where vertical alignment matters more than
 * digit-by-digit precision; locale-formatted numbers are used in
 * tables and detail views.
 */
export function compactNumber(n: number): string {
  if (n < 1_000) return n.toString();
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}
