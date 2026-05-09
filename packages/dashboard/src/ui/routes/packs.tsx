// `/packs` — installed packs and a thin install affordance.
//
// The dashboard's Packs tab is a thin projection of the registry
// commands per ADR-0018. Reads `pack.list` for the installed
// table; mutates via `pack.install` (bundled id or HTTPS URL) and
// `pack.uninstall`. No new commands or schema added here.
//
// CLI is the primary authoring path (`memento pack create`); this
// page exposes the install + uninstall surface that's most useful
// from a browser — the read state plus point-and-click cleanup.

import { useState } from 'react';

import {
  type InstalledPack,
  type PackInstallSource,
  useInstallPack,
  useInstalledPacks,
  useUninstallPack,
} from '../hooks/usePacks.js';

export function PacksPage(): JSX.Element {
  const installed = useInstalledPacks();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">~/packs</span>
        <h1 className="font-sans text-xl font-semibold tracking-tight">Packs</h1>
        <p className="font-mono text-xs text-muted">
          A pack is a curated YAML file of memories you can install in one step — typically a stack
          guide (Rust + Axum, TypeScript + pnpm…) or a personal set of conventions you want to seed
          a fresh assistant with. Installing adds memories with a{' '}
          <code>pack:&lt;id&gt;:&lt;version&gt;</code> tag; uninstalling removes every memory
          carrying that tag.
        </p>
      </header>

      <InstallSection />

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-xs uppercase tracking-widish text-muted">Installed</h2>
        {installed.isLoading ? (
          <p className="font-mono text-xs text-muted">loading pack.list…</p>
        ) : installed.error !== null && installed.error !== undefined ? (
          <p className="font-mono text-xs text-warn">
            failed: {(installed.error as { message?: string })?.message ?? String(installed.error)}
          </p>
        ) : !installed.data || installed.data.packs.length === 0 ? (
          <p className="font-mono text-xs text-muted">no packs installed yet.</p>
        ) : (
          <InstalledPackTable packs={installed.data.packs} />
        )}
      </section>

      <AuthoringCallout />
    </div>
  );
}

function AuthoringCallout(): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5 rounded border border-border p-3">
      <h2 className="font-mono text-xs uppercase tracking-widish text-muted">
        Bundle your own memories into a pack
      </h2>
      <p className="font-mono text-xs text-muted">
        The dashboard installs and uninstalls packs; authoring is a CLI flow. Run the command below
        in your terminal to walk through your existing memories and save the kept set to a YAML file
        you can share or check into a repo.
      </p>
      <pre className="overflow-x-auto rounded bg-border/30 px-2 py-1.5 font-mono text-xs text-fg">
        {`memento pack create my-stack \\
  --version 0.1.0 \\
  --title "My stack conventions" \\
  --out ./my-stack.yaml`}
      </pre>
      <p className="font-mono text-[11px] text-muted/80">
        Add <code>--scope-global</code>, <code>--kind=preference</code>, or{' '}
        <code>--tag=&lt;t&gt;</code> to filter non-interactively; omit them on a TTY to step through
        each memory keep/skip.
      </p>
    </section>
  );
}

function InstallSection(): JSX.Element {
  const install = useInstallPack();
  const [bundledId, setBundledId] = useState('');
  const [bundledVersion, setBundledVersion] = useState('');
  const [url, setUrl] = useState('');
  const [tab, setTab] = useState<'bundled' | 'url'>('bundled');

  const submitting = install.isPending;
  const lastError = install.error as { message?: string } | null | undefined;
  const lastSuccess = install.data;

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    let source: PackInstallSource | null = null;
    if (tab === 'bundled' && bundledId.trim() !== '') {
      source = {
        type: 'bundled',
        id: bundledId.trim(),
        ...(bundledVersion.trim() !== '' ? { version: bundledVersion.trim() } : {}),
      };
    } else if (tab === 'url' && url.trim() !== '') {
      source = { type: 'url', url: url.trim() };
    }
    if (source === null) return;
    install.mutate({ source });
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-xs uppercase tracking-widish text-muted">Install a pack</h2>
      <div className="flex gap-2 font-mono text-xs">
        <button
          type="button"
          onClick={() => setTab('bundled')}
          className={`rounded border px-2 py-1 ${
            tab === 'bundled'
              ? 'border-fg text-fg'
              : 'border-border text-muted hover:border-fg hover:text-fg'
          }`}
        >
          bundled id
        </button>
        <button
          type="button"
          onClick={() => setTab('url')}
          className={`rounded border px-2 py-1 ${
            tab === 'url'
              ? 'border-fg text-fg'
              : 'border-border text-muted hover:border-fg hover:text-fg'
          }`}
        >
          https url
        </button>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        {tab === 'bundled' ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={bundledId}
              onChange={(e) => setBundledId(e.target.value)}
              placeholder="ts-monorepo-pnpm"
              className="flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-xs"
              disabled={submitting}
            />
            <input
              value={bundledVersion}
              onChange={(e) => setBundledVersion(e.target.value)}
              placeholder="1.0.0 (optional)"
              className="rounded border border-border bg-bg px-2 py-1 font-mono text-xs sm:w-40"
              disabled={submitting}
            />
            <button
              type="submit"
              disabled={submitting || bundledId.trim() === ''}
              className="rounded border border-border px-3 py-1 font-mono text-xs hover:border-fg hover:text-fg disabled:opacity-50"
            >
              {submitting ? 'installing…' : 'install'}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/pack.yaml"
              className="flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-xs"
              disabled={submitting}
            />
            <button
              type="submit"
              disabled={submitting || url.trim() === ''}
              className="rounded border border-border px-3 py-1 font-mono text-xs hover:border-fg hover:text-fg disabled:opacity-50"
            >
              {submitting ? 'installing…' : 'install'}
            </button>
          </div>
        )}
      </form>
      {lastError ? (
        <p className="font-mono text-xs text-warn">install failed: {lastError.message}</p>
      ) : null}
      {lastSuccess ? (
        <p className="font-mono text-xs text-synapse">
          installed {lastSuccess.packId}@{lastSuccess.version} — state: {lastSuccess.state} ·
          written: {lastSuccess.written.length}
        </p>
      ) : null}
    </section>
  );
}

function InstalledPackTable({ packs }: { readonly packs: readonly InstalledPack[] }): JSX.Element {
  return (
    <table className="w-full font-mono text-xs">
      <thead>
        <tr className="text-left text-muted">
          <th className="border-b border-border py-1.5 font-normal uppercase tracking-widish">
            id
          </th>
          <th className="border-b border-border py-1.5 font-normal uppercase tracking-widish">
            version
          </th>
          <th className="border-b border-border py-1.5 font-normal uppercase tracking-widish">
            scope
          </th>
          <th className="border-b border-border py-1.5 font-normal uppercase tracking-widish">
            memories
          </th>
          <th className="border-b border-border py-1.5 font-normal uppercase tracking-widish">
            actions
          </th>
        </tr>
      </thead>
      <tbody>
        {packs.map((pack) => (
          <PackRow key={`${pack.id}@${pack.version}@${JSON.stringify(pack.scope)}`} pack={pack} />
        ))}
      </tbody>
    </table>
  );
}

function PackRow({ pack }: { readonly pack: InstalledPack }): JSX.Element {
  const uninstall = useUninstallPack();
  const submitting = uninstall.isPending;
  const lastError = uninstall.error as { message?: string } | null | undefined;
  const onUninstall = (): void => {
    if (
      typeof window === 'undefined' ||
      !window.confirm(
        `Uninstall ${pack.id}@${pack.version}? This forgets ${pack.count} memor${pack.count === 1 ? 'y' : 'ies'}.`,
      )
    ) {
      return;
    }
    uninstall.mutate({ id: pack.id, version: pack.version });
  };
  return (
    <>
      <tr>
        <td className="py-1.5 text-fg">{pack.id}</td>
        <td className="py-1.5 text-muted">{pack.version}</td>
        <td className="py-1.5 text-muted">{renderScope(pack.scope)}</td>
        <td className="py-1.5 text-muted">{pack.count}</td>
        <td className="py-1.5">
          <button
            type="button"
            onClick={onUninstall}
            disabled={submitting}
            className="rounded border border-border px-2 py-0.5 text-xs text-muted hover:border-destructive hover:text-destructive disabled:opacity-50"
          >
            {submitting ? '…' : 'uninstall'}
          </button>
        </td>
      </tr>
      {lastError ? (
        <tr>
          <td colSpan={5} className="pb-1.5 text-warn">
            uninstall failed: {lastError.message}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function renderScope(scope: { readonly type: string; readonly [k: string]: unknown }): string {
  switch (scope.type) {
    case 'global':
      return 'global';
    case 'workspace':
      return `workspace:${(scope as { path?: string }).path ?? '?'}`;
    case 'repo':
      return `repo:${(scope as { remote?: string }).remote ?? '?'}`;
    case 'branch':
      return `branch:${(scope as { branch?: string }).branch ?? '?'}`;
    case 'session':
      return 'session';
    default:
      return scope.type;
  }
}
