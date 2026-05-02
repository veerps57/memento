import type { ReactNode } from 'react';

import { CodeBlock } from './components/CodeBlock.js';
import { JsonBlock } from './components/JsonBlock.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { Wordmark } from './components/Wordmark.js';

const GITHUB_URL = 'https://github.com/veerps57/memento';
const NPM_URL = 'https://www.npmjs.com/package/@psraghuveer/memento';
const DOCS_URL = `${GITHUB_URL}#getting-started`;
const ARCH_URL = `${GITHUB_URL}/blob/main/ARCHITECTURE.md`;

export default function App(): JSX.Element {
  return (
    <div className="min-h-full bg-bg text-fg">
      <TopBar />
      <main>
        <Hero />
        <Pain />
        <HowItWorks />
        <Quickstart />
        <DashboardPreview />
        <Features />
      </main>
      <Footer />
    </div>
  );
}

function TopBar(): JSX.Element {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 md:px-8">
        <a href="#top" className="inline-flex items-baseline">
          <Wordmark className="text-base" />
        </a>
        <nav className="flex items-center gap-3 md:gap-4">
          <a href={GITHUB_URL} className="text-sm text-muted transition-colors hover:text-fg">
            GitHub
          </a>
          <a href={NPM_URL} className="text-sm text-muted transition-colors hover:text-fg">
            npm
          </a>
          <a href={DOCS_URL} className="text-sm text-muted transition-colors hover:text-fg">
            docs
          </a>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}

function Hero(): JSX.Element {
  return (
    <section id="top" className="scroll-mt-20 border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 md:px-8 md:py-16">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">~/memento</p>
        <h1 className="max-w-4xl text-4xl font-medium leading-tight tracking-tight text-fg md:text-6xl">
          One memory layer for every AI assistant you use.
        </h1>
        <p className="mt-6 max-w-prose text-lg text-fg/80">
          Memento is a local-first, LLM-agnostic memory layer. It runs an{' '}
          <a
            href="https://modelcontextprotocol.io"
            className="text-fg underline decoration-border underline-offset-4 hover:decoration-accent"
          >
            MCP
          </a>{' '}
          server over a single SQLite file on your machine, so any MCP-capable AI assistant — Claude
          Desktop, Claude Code, Cursor, GitHub Copilot, Cline, OpenCode, Aider, a custom agent — can
          read and write durable, structured memory about you, your work, and your decisions.
        </p>
        <div className="mt-10 grid max-w-2xl gap-3">
          <CodeBlock command="npx @psraghuveer/memento init" />
          <p className="font-mono text-xs text-muted">
            creates the database, runs migrations, prints copy-paste MCP snippets for your client
          </p>
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a
            href="#quickstart"
            className="inline-flex items-center rounded-md border border-accent bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent/90"
          >
            Get started
          </a>
          <a
            href={GITHUB_URL}
            className="inline-flex items-center rounded-md border border-border px-4 py-2 text-sm text-fg transition-colors hover:border-fg"
          >
            View on GitHub
          </a>
          <a
            href="#how-it-works"
            className="text-sm text-muted underline decoration-border underline-offset-4 hover:text-fg hover:decoration-fg sm:ml-2"
          >
            How it works
          </a>
        </div>
      </div>
    </section>
  );
}

function Pain(): JSX.Element {
  return (
    <section className="scroll-mt-20 border-b border-border bg-bg/40">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8 md:py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">~/the_pain</p>
        <h2 className="max-w-3xl text-3xl font-medium tracking-tight md:text-4xl">
          Every AI session starts the same way.
        </h2>
        <p className="mt-6 max-w-prose text-base text-muted md:text-lg">
          Re-explaining your preferences. Re-stating your project's conventions. Re-listing the
          decisions you made last week and the dead-ends to avoid. Each tool solves this in its own
          siloed way — <code className="font-mono text-fg">CLAUDE.md</code>,{' '}
          <code className="font-mono text-fg">.cursorrules</code>,{' '}
          <code className="font-mono text-fg">copilot-instructions.md</code>, ChatGPT Memory — but
          you, the human, are the one constant.
        </p>
        <p className="mt-4 max-w-prose text-base text-muted md:text-lg">
          Your memory shouldn't fragment across vendors.
        </p>
      </div>
    </section>
  );
}

function HowItWorks(): JSX.Element {
  return (
    <section id="how-it-works" className="scroll-mt-20 border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8 md:py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">
          ~/how_it_works
        </p>
        <h2 className="text-3xl font-medium tracking-tight md:text-4xl">
          One place where memory lives.
        </h2>
        <p className="mt-6 max-w-prose text-muted">
          Memento sits between your AI clients and a SQLite file on your machine. Clients talk to it
          over MCP; you read and curate via the dashboard or the CLI. The memory model is structured
          (typed kinds, scopes, audit log, decay), so the assistant can reason about what's still
          true — not just retrieve text blobs.
        </p>
        <div className="mt-12 flex flex-col items-stretch gap-3 md:flex-row md:items-stretch">
          <FlowCard
            label="AI clients"
            body="Claude Desktop · Claude Code · Cursor · GitHub Copilot · Cline · OpenCode · Aider · custom agents"
          />
          <FlowArrow caption="MCP over stdio" />
          <FlowCard
            label="memento serve"
            body="Typed command registry · scope resolver · scrubber · decay engine · conflict detector"
          />
          <FlowArrow />
          <FlowCard
            label="One SQLite file"
            body="Under your home directory · FTS5 + optional vector retrieval · append-only audit log"
          />
        </div>
      </div>
    </section>
  );
}

function FlowCard({ label, body }: { readonly label: string; readonly body: string }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-md border border-border bg-bg/60 p-5">
      <p className="font-mono text-xs uppercase tracking-widish text-accent">{label}</p>
      <p className="text-sm text-muted">{body}</p>
    </div>
  );
}

/**
 * Visual connector between two FlowCards. Renders ↓ on mobile
 * (cards stack vertically) and → on md+ (cards sit side-by-side).
 * The optional caption sits next to the arrow on the same axis as
 * the flow, so "MCP over stdio" reads naturally either way.
 */
function FlowArrow({ caption }: { readonly caption?: string }): JSX.Element {
  return (
    <div className="flex shrink-0 items-center justify-center gap-2 py-2 font-mono text-xs uppercase tracking-widish text-muted md:flex-col md:py-0">
      <span aria-hidden className="text-3xl leading-none text-accent md:hidden">
        ↓
      </span>
      <span aria-hidden className="hidden text-3xl leading-none text-accent md:inline">
        →
      </span>
      {caption !== undefined ? <span>{caption}</span> : null}
    </div>
  );
}

function Quickstart(): JSX.Element {
  return (
    <section id="quickstart" className="scroll-mt-20 border-b border-border bg-bg/40">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8 md:py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">~/quickstart</p>
        <h2 className="text-3xl font-medium tracking-tight md:text-4xl">
          Three commands, then you're done.
        </h2>
        {/* `minmax(0, 1fr)` clamps each column's min-content so a long
            unbreakable token in a step's CodeBlock (e.g. the
            `MEMENTO_DB=~/.local/...` path) cannot push the grid past
            the viewport on mobile. Standard CSS-grid mobile trap. */}
        <ol className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-3">
          <Step
            n={1}
            title="Pick a database location"
            body="A stable absolute path so every client points at the same store."
            command="export MEMENTO_DB=~/.local/share/memento/memento.db"
          />
          <Step
            n={2}
            title="Run init"
            body="Creates the database, runs migrations, prints a snippet for every supported MCP client."
            command="npx @psraghuveer/memento init"
          />
          <Step
            n={3}
            title="Paste the snippet"
            body="Drop it into your AI client's MCP config (Claude Desktop, Cursor, Cline, OpenCode, VS Code Agent…) and restart the client."
            command={null}
            preview={<SnippetPreview />}
          />
        </ol>
        <p className="mt-12 max-w-prose text-muted">
          Then start a fresh session and tell your assistant something durable —{' '}
          <em className="text-fg">"Remember that I prefer pnpm over npm for Node projects."</em> In
          the next session, ask <em className="text-fg">"What's my preferred package manager?"</em>{' '}
          and watch the assistant recall it without you re-explaining.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a
            href={DOCS_URL}
            className="inline-flex items-center rounded-md border border-border px-4 py-2 text-sm text-fg transition-colors hover:border-fg"
          >
            Full setup guide
          </a>
          <a
            href={`${GITHUB_URL}/blob/main/docs/guides/teach-your-assistant.md`}
            className="inline-flex items-center rounded-md border border-border px-4 py-2 text-sm text-fg transition-colors hover:border-fg"
          >
            Teach your assistant
          </a>
        </div>
      </div>
    </section>
  );
}

function Step({
  n,
  title,
  body,
  command,
  preview,
}: {
  readonly n: number;
  readonly title: string;
  readonly body: string;
  /** Show a copy-pasteable command. Mutually exclusive with `preview`. */
  readonly command: string | null;
  /**
   * Optional visual rendered when `command` is null. Used by
   * step 3 (no command — paste a JSON snippet from `init`'s
   * output) to keep card heights visually balanced with the
   * earlier two cards.
   */
  readonly preview?: ReactNode;
}): JSX.Element {
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-bg/60 p-5">
      <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-widish text-muted">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-accent text-accent">
          {n}
        </span>
        step
      </div>
      <h3 className="text-lg font-medium text-fg">{title}</h3>
      <p className="text-sm text-muted">{body}</p>
      {command !== null ? <CodeBlock command={command} compact /> : (preview ?? null)}
    </li>
  );
}

/**
 * Real, copyable MCP-server snippet shown in step 3 of the
 * quickstart. The shape mirrors what `memento init` prints for
 * Claude Desktop / Claude Code / Cursor / VS Code Agent — same
 * `mcpServers` envelope, same `command` + `args` + `env` triple.
 * The default DB path is the canonical XDG location; users who
 * want a different file edit MEMENTO_DB before pasting.
 *
 * Source of truth (do not drift): the snippet generator in
 * `packages/cli/src/lifecycle/init.ts`.
 */
const MCP_SNIPPET = `{
  "mcpServers": {
    "memento": {
      "command": "npx",
      "args": ["-y", "@psraghuveer/memento", "serve"],
      "env": {
        "MEMENTO_DB": "~/.local/share/memento/memento.db"
      }
    }
  }
}`;

function SnippetPreview(): JSX.Element {
  return <JsonBlock json={MCP_SNIPPET} />;
}

function DashboardPreview(): JSX.Element {
  const cards = [
    {
      route: '~/overview',
      title: 'See your store at a glance',
      bullets: [
        'Active / archived / forgotten / superseded counts',
        'Distribution by kind (fact, preference, decision, todo, snippet) and by scope',
        'Last write across all scopes',
        'Vector retrieval status + open-conflict count',
      ],
    },
    {
      route: '~/memory/$id',
      title: 'Drill into any memory',
      bullets: [
        'Full content, tags, supersession chain',
        'Provenance: stored confidence, decay-adjusted effective confidence',
        'Append-only audit timeline — every event since creation',
        'One-click confirm / unpin / forget — destructive actions gated',
      ],
    },
    {
      route: '⌘K  command palette',
      title: 'Search and navigate from anywhere',
      bullets: [
        'Live full-text + paraphrase search as you type',
        'Type `>` for ranked route navigation',
        'Type `:` plus a ULID to open a memory by id',
        'Read-only by design — write verbs stay on detail pages',
      ],
    },
  ];

  return (
    <section className="scroll-mt-20 border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8 md:py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">~/your_store</p>
        <h2 className="max-w-3xl text-3xl font-medium tracking-tight md:text-4xl">
          See what your assistants remember. Curate it in a browser.
        </h2>
        <p className="mt-6 max-w-prose text-muted">
          Run <code className="font-mono text-fg">npx @psraghuveer/memento dashboard</code> for a
          local-first web UI against your store: search, audit, conflict triage, config inspection.
          Localhost-only. No auth. No telemetry. Same trust model as the CLI.
        </p>
        <ul className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => (
            <li
              key={c.route}
              className="flex flex-col gap-3 rounded-md border border-border bg-bg/60 p-5"
            >
              <p className="font-mono text-xs uppercase tracking-widish text-accent">{c.route}</p>
              <h3 className="text-lg font-medium text-fg">{c.title}</h3>
              <ul className="mt-1 space-y-2 text-sm text-muted">
                {c.bullets.map((b) => (
                  <li key={b} className="flex gap-2">
                    <span
                      aria-hidden
                      className="mt-[0.5em] inline-block h-px w-3 shrink-0 bg-muted"
                    />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Features(): JSX.Element {
  const items = [
    {
      title: 'Local-first',
      body: 'One SQLite file under your home directory. No outbound network calls by default.',
    },
    {
      title: 'LLM-agnostic',
      body: 'No model dependencies. No proprietary APIs. Works with whatever LLM your tools use.',
    },
    {
      title: 'MCP-native',
      body: 'Plugs into Claude Desktop, Claude Code, Cursor, Copilot, Cline, OpenCode, and any MCP client.',
    },
    {
      title: 'Privacy-conscious',
      body: 'A regex-based scrubber strips secrets before they are persisted. Patterns are user-configurable.',
    },
    {
      title: 'Auditable',
      body: 'Every write produces an event in an append-only log. Answer "why is this here?" any time.',
    },
    {
      title: 'Portable',
      body: 'JSONL export / import. Carry your memory between machines. Leave at any time.',
    },
  ];
  return (
    <section className="scroll-mt-20 border-b border-border bg-bg/40">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8 md:py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">~/principles</p>
        <h2 className="text-3xl font-medium tracking-tight md:text-4xl">What Memento is.</h2>
        <ul className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((it) => (
            <li key={it.title} className="rounded-md border border-border bg-bg/60 p-5">
              <h3 className="font-mono text-sm uppercase tracking-widish text-accent">
                {it.title}
              </h3>
              <p className="mt-3 text-sm text-muted">{it.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Footer(): JSX.Element {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted md:flex-row md:items-center md:justify-between md:px-8">
        <div className="flex items-center gap-3">
          <Wordmark className="text-sm" />
          <span className="font-mono text-xs">Apache-2.0 · local-first · no telemetry</span>
        </div>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <a className="hover:text-fg" href={GITHUB_URL}>
            GitHub
          </a>
          <a className="hover:text-fg" href={NPM_URL}>
            npm
          </a>
          <a className="hover:text-fg" href={DOCS_URL}>
            docs
          </a>
          <a className="hover:text-fg" href={ARCH_URL}>
            architecture
          </a>
          <a className="hover:text-fg" href={`${GITHUB_URL}/tree/main/docs/adr`}>
            ADRs
          </a>
          <a className="hover:text-fg" href={`${GITHUB_URL}/discussions`}>
            discussions
          </a>
        </nav>
      </div>
    </footer>
  );
}
