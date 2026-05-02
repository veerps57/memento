// `<StatTile>` — the canonical "one number, one label" tile.
//
// Visual rules
// ------------
//
// - Thin border (single faint divider, terminal-style; never a
//   heavy boxed look).
// - Label above the number, mono, uppercase, slightly tracked.
// - Number large, mono, tabular nums so consecutive stat tiles
//   line up vertically.
// - Optional sub-line below the number for context (e.g. "of
//   last 1000" when an aggregate is approximate).
// - Optional accent: when `accent="on"` the number is rendered
//   in the warm-amber theme accent. Used for "active" stats so
//   the eye lands on the most-important number first.

import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';

export function StatTile({
  label,
  value,
  sub,
  accent = 'off',
  className,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly sub?: ReactNode;
  readonly accent?: 'on' | 'synapse' | 'warn' | 'destructive' | 'conflict' | 'off';
  readonly className?: string;
}): JSX.Element {
  const valueColor =
    accent === 'on'
      ? 'text-accent'
      : accent === 'synapse'
        ? 'text-synapse'
        : accent === 'warn'
          ? 'text-warn'
          : accent === 'destructive'
            ? 'text-destructive'
            : accent === 'conflict'
              ? 'text-conflict'
              : 'text-fg';

  return (
    <div
      className={cn('rounded border border-border bg-bg p-4', 'flex flex-col gap-1.5', className)}
    >
      <div className="font-mono text-[11px] uppercase tracking-widish text-muted">{label}</div>
      <div className={cn('term-stat', valueColor)}>{value}</div>
      {sub === undefined ? null : <div className="font-mono text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
