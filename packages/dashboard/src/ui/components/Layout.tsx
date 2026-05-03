// Application chrome: top bar + sidebar + main + status bar.
//
// Layout philosophy
// -----------------
//
// The chrome is "terminal-pure": typographic, structural, no
// brain/memory iconography. Brain/memory motifs live exclusively
// in data visualisations downstream (decay curves, supersession
// chains, scope trees). Here we want the panes to feel like a
// well-set-up tmux: a top status row, a left command palette,
// a main content pane, and a bottom telemetry strip.
//
// Mobile (< md): sidebar collapses into a header-toggled
// drawer. The drawer is the same nav, same labels, just stacked.
//
// The sidebar nav uses the `term-prompt` class — lowercase,
// monospace, mirroring Memento's command namespaces. That naming
// choice reads as "this came from a terminal-comfortable mind"
// rather than "this is a marketing-styled product UI."

import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';

import { useSystemInfo } from '../hooks/useSystemInfo.js';
import { cn } from '../lib/cn.js';

const NAV_ITEMS: ReadonlyArray<{ readonly to: string; readonly label: string }> = [
  { to: '/', label: 'overview' },
  { to: '/memory', label: 'memory' },
  { to: '/conflicts', label: 'conflicts' },
  { to: '/audit', label: 'audit' },
  { to: '/config', label: 'config' },
  { to: '/system', label: 'system' },
];

export function Layout({ children }: { readonly children: ReactNode }): JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <TopBar onMenuClick={() => setDrawerOpen((v) => !v)} drawerOpen={drawerOpen} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar drawerOpen={drawerOpen} onNavigate={() => setDrawerOpen(false)} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">{children}</div>
        </main>
      </div>
      <StatusBar />
    </div>
  );
}

function TopBar({
  onMenuClick,
  drawerOpen,
}: {
  readonly onMenuClick: () => void;
  readonly drawerOpen: boolean;
}): JSX.Element {
  // Pull the user's preferred name from `system.info.user.preferredName`
  // (config key `user.preferredName`). When set, the wordmark renders
  // shell-prompt style — `<name>@memento_` — to match the dashboard's
  // terminal aesthetic. When null (default), falls back to plain
  // `memento_`. We tolerate the loading state with the same fallback;
  // the wordmark must paint instantly on first render.
  const { data: info } = useSystemInfo();
  const preferredName = info?.user.preferredName ?? null;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg px-3 sm:px-4">
      {/* Wordmark with blinking-cursor caret. The caret is
          purely decorative; it is not the actual focus indicator.
          Hidden on widths below 320px (impossibly narrow) only. */}
      <Link to="/" className="flex items-center gap-1 font-mono text-sm">
        {preferredName !== null ? (
          <>
            <span className="text-muted">{preferredName.toLowerCase()}</span>
            <span className="text-muted">@</span>
          </>
        ) : null}
        <span className="font-semibold tracking-widish">memento</span>
        <span className="text-muted">_</span>
        <span aria-hidden className="inline-block h-3 w-1.5 animate-pulse bg-fg" />
      </Link>

      <div className="flex-1" />

      {/* Command palette trigger. The keyboard shortcut (⌘K /
          Ctrl-K) is the canonical entry; the visible button is
          a discoverability fallback for pointer users. The
          actual palette is mounted at the app root and listens
          for the global keydown — clicking the button just
          synthesises the same event. */}
      <button
        type="button"
        onClick={() => {
          // Re-emit ⌘K so the palette's global listener handles
          // it the same way as a real keypress, keeping the
          // open/close path in one place.
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true }),
          );
        }}
        className={cn(
          'hidden items-center gap-2 rounded border border-border px-2 py-1',
          'font-mono text-xs text-muted hover:border-fg hover:text-fg',
          'sm:flex',
        )}
        title="Command palette (⌘K)"
      >
        <span>⌘K</span>
        <span>search…</span>
      </button>

      {/* Mobile drawer toggle. Hidden at md+. */}
      <button
        type="button"
        onClick={onMenuClick}
        aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={drawerOpen}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded',
          'border border-border font-mono text-xs',
          'hover:border-fg md:hidden',
        )}
      >
        <span aria-hidden>{drawerOpen ? '✕' : '≡'}</span>
      </button>
    </header>
  );
}

function Sidebar({
  drawerOpen,
  onNavigate,
}: {
  readonly drawerOpen: boolean;
  readonly onNavigate: () => void;
}): JSX.Element {
  return (
    <>
      {/* Mobile drawer overlay. Tap to close. */}
      {drawerOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onNavigate}
          className="fixed inset-0 z-30 bg-bg/70 backdrop-blur-sm md:hidden"
        />
      ) : null}

      <nav
        className={cn(
          'z-40 w-56 shrink-0 border-r border-border bg-bg',
          // Desktop: always visible.
          'md:block',
          // Mobile: full-height drawer below the top bar.
          drawerOpen ? 'fixed inset-y-12 left-0 block' : 'hidden',
        )}
      >
        <ul className="flex flex-col gap-px py-3">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                onClick={onNavigate}
                className={cn(
                  'block px-4 py-1.5 term-prompt text-muted',
                  'hover:bg-border/40 hover:text-fg',
                  'aria-[current=page]:bg-border/30 aria-[current=page]:text-accent',
                )}
                activeProps={{ 'aria-current': 'page' }}
              >
                <span className="text-muted">~/</span>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

function StatusBar(): JSX.Element {
  const info = useSystemInfo();
  const dbPath = info.data?.dbPath ?? '…';
  const active = info.data?.counts.active;
  const version = info.data?.version ?? '…';
  const vector = info.data?.vectorEnabled;

  return (
    <footer
      className={cn(
        'shrink-0 border-t border-border bg-bg',
        'px-3 py-1 sm:px-4',
        'flex items-center gap-3 overflow-x-auto whitespace-nowrap',
        'font-mono text-[11px] text-muted',
      )}
      aria-label="Status bar"
    >
      <span className="hidden truncate sm:inline" title={dbPath}>
        db: <span className="text-fg/80">{dbPath}</span>
      </span>
      <span className="hidden sm:inline" aria-hidden>
        ·
      </span>
      <span>
        {active === undefined ? '…' : active.toLocaleString()}{' '}
        <span className="text-muted/80">active</span>
      </span>
      <span aria-hidden>·</span>
      <span>
        vec:{' '}
        <span className={vector ? 'text-synapse' : 'text-muted/80'}>
          {vector === undefined ? '…' : vector ? 'on' : 'off'}
        </span>
      </span>
      <span className="flex-1" />
      <span className="text-muted/80">v{version}</span>
    </footer>
  );
}
