import type { ReactNode } from 'react';

import { COMPARISON } from './comparison.js';
import { CodeBlock } from './components/CodeBlock.js';
import { JsonBlock } from './components/JsonBlock.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { Wordmark } from './components/Wordmark.js';
import { FAQ_ITEMS } from './faq.js';

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
        <Packs />
        <DashboardPreview />
        <Features />
        <Comparison />
        <Faq />
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
    <section id="top" aria-labelledby="hero-h1" className="scroll-mt-20 border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 md:px-8 md:py-16">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">~/memento</p>
        <h1
          id="hero-h1"
          className="max-w-4xl text-4xl font-medium leading-tight tracking-tight text-fg md:text-6xl"
        >
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
        <p className="mt-4 max-w-prose font-mono text-sm uppercase tracking-widish text-accent">
          Local. Typed. Audited. Yours.
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
    <section aria-labelledby="pain-h2" className="scroll-mt-20 border-b border-border bg-bg/40">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8 md:py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">~/the_pain</p>
        <h2 id="pain-h2" className="max-w-3xl text-3xl font-medium tracking-tight md:text-4xl">
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
    <section
      id="how-it-works"
      aria-labelledby="how-it-works-h2"
      className="scroll-mt-20 border-b border-border"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8 md:py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">
          ~/how_it_works
        </p>
        <h2 id="how-it-works-h2" className="text-3xl font-medium tracking-tight md:text-4xl">
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
    <section
      id="quickstart"
      aria-labelledby="quickstart-h2"
      className="scroll-mt-20 border-b border-border bg-bg/40"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8 md:py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">~/quickstart</p>
        <h2 id="quickstart-h2" className="text-3xl font-medium tracking-tight md:text-4xl">
          Three steps, then you're done.
        </h2>
        {/* `minmax(0, 1fr)` clamps each column's min-content so a long
            unbreakable token in a step's CodeBlock (e.g. the package
            name + serve args) cannot push the grid past the viewport
            on mobile. Standard CSS-grid mobile trap. */}
        <ol className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-3">
          <Step
            n={1}
            title="Run init"
            body="Creates the SQLite database under the XDG default, runs migrations, and prints copy-paste MCP setup for every supported client."
            command="npx @psraghuveer/memento init"
          />
          <Step
            n={2}
            title="Connect your AI client"
            body="Paste the JSON snippet into your client's MCP config (Claude Desktop, Cursor, Cline, OpenCode, VS Code Agent…) — or use the one-line subcommand init prints for Claude Code. Restart the client."
            command={null}
            preview={<SnippetPreview />}
          />
          <Step
            n={3}
            title="Install the skill (or paste persona)"
            body="If your client loads Anthropic-format skills, copy the bundled Memento skill into ~/.claude/skills/ — most skill-capable clients read from there. (A few use a client-specific path; check your client's skill docs.) If your client doesn't load skills, copy the persona snippet below into your client's persona file."
            command={'cp -R "$(npx -y @psraghuveer/memento skill-path)" ~/.claude/skills/'}
          />
        </ol>
        <PersonaSnippet />
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
   * Optional visual rendered when `command` is null. Used by the
   * "connect your client" step (no command — paste a JSON snippet
   * from `init`'s output) to keep card heights visually balanced
   * with the surrounding command-bearing cards.
   */
  readonly preview?: ReactNode;
}): JSX.Element {
  return (
    <li
      id={`quickstart-step-${n}`}
      className="flex min-w-0 scroll-mt-20 flex-col gap-3 rounded-md border border-border bg-bg/60 p-5"
    >
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

/**
 * Persona snippet — the generic fallback for clients that don't
 * load Anthropic-format skills. Surfaced inline so first-time
 * users on those clients don't have to leave the page to reach
 * a copyable block. Intentionally not enumerating which clients
 * fall in this bucket: the list drifts as the ecosystem moves
 * and is the user's concern, not ours.
 *
 * Source of truth (do not drift): the "A minimal end-to-end
 * persona snippet" section in `docs/guides/teach-your-assistant.md`.
 * Keep this verbatim with that file; cosmetic edits are fine,
 * semantic edits should land in the doc first and be mirrored here.
 */
const PERSONA_SNIPPET = `## Memory (Memento)

You have a local memory store via MCP. Use it as your durable
memory; treat chat as ephemeral.

- Memory ops are silent background plumbing. Don't preface them
  ("let me check memory") and don't report results ("saved",
  "memory was empty"). The UI shows the tool call; layering prose
  on top pollutes the conversation. Speak only when the user
  asked a question whose answer is in memory, a write surfaced a
  conflict, or the user explicitly said "remember this" — and
  then one word ("noted") is enough.
- At the start of a task, call \`get_memory_context\` to load relevant
  memories for this session. If context looks thin, call
  \`search_memory\` with specific terms.
- When you actually use a memory, call \`confirm_memory\` with its id.
- Write durable user statements (preferences, decisions, facts,
  todos, snippets) via \`write_memory\` with an explicit \`kind\`.
- Before ending a session, call \`extract_memory\` with a batch of
  candidates for anything worth remembering that wasn't written
  explicitly during the conversation. The server deduplicates
  automatically — when in doubt, include it. The default
  configuration is async: the response will be \`{written:[],
  skipped:[], superseded:[], mode:"async", batchId, hint, status:
  "accepted"}\` — that is the receipt, not a failure. Writes land
  as memories within seconds; do not retry.
- For preferences and decisions, start \`content\` with a single
  \`topic: value\` line followed by prose. Conflict detection
  parses that line; without it, contradictory preferences
  silently coexist.
- Use the user's preferred name from \`info_system.user.preferredName\`
  when authoring memory content; fall back to "The user" when
  that field is null.
- For changes of mind, use \`supersede_memory\`, not \`update_memory\`.
- Never write secrets, tokens, or credentials.`;

function PersonaSnippet(): JSX.Element {
  return (
    <div className="mt-10 rounded-md border border-border bg-bg/40 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-base font-medium text-fg">
          Persona snippet — for clients without skill support
        </h3>
        <a
          href={`${GITHUB_URL}/blob/main/docs/guides/teach-your-assistant.md`}
          className="font-mono text-xs uppercase tracking-widish text-muted underline decoration-border underline-offset-4 hover:text-fg hover:decoration-fg"
        >
          Full guide →
        </a>
      </div>
      <p className="mt-2 max-w-prose text-sm text-muted">
        Paste this near the top of your client's persona file. It tells the assistant when to call
        Memento's MCP tools — without it, the assistant has the tools but no instinct to use them.
      </p>
      <div className="mt-4">
        <JsonBlock json={PERSONA_SNIPPET} />
      </div>
    </div>
  );
}

function Packs(): JSX.Element {
  const cards = [
    {
      label: 'install',
      title: "Don't start from empty.",
      body: 'One command installs a curated bundle. Bundled ids, local files, or HTTPS URLs all route through the same install path. `pack preview` rehearses without writing.',
    },
    {
      label: 'author',
      title: 'Bundle what you already have.',
      body: '`memento pack create` builds a YAML from memories already in your store. Filter by scope, kind, or tag — or pick interactively. The output is human-readable and `git diff`-friendly.',
    },
    {
      label: 'share',
      title: 'Distribute a stack guide in one file.',
      body: 'Email a YAML, drop a GitHub raw URL, or contribute to the community registry. Recipients install with one command. Reserved `pack:<id>:<version>` tags keep provenance honest.',
    },
    {
      label: 'audit',
      title: "It's still your store.",
      body: 'Pack-installed memories are normal memories — they decay, conflict-detect, and supersede like any other. Uninstall is dry-run by default. Re-install is idempotent.',
    },
  ];

  return (
    <section id="packs" aria-labelledby="packs-h2" className="scroll-mt-20 border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8 md:py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">~/packs</p>
        <h2 id="packs-h2" className="max-w-3xl text-3xl font-medium tracking-tight md:text-4xl">
          Seed your store with a pack.
        </h2>
        <p className="mt-6 max-w-prose text-muted">
          A fresh Memento install is empty. Packs are curated YAML bundles of memories you can
          install in one step — a stack guide (Rust + Axum, TypeScript + pnpm, Python + uv…), a
          team's conventions, or a personal set you authored on another machine.
        </p>
        <div className="mt-10 grid max-w-2xl gap-3">
          <CodeBlock command="memento pack install engineering-simplicity" />
          <p className="font-mono text-xs text-muted">
            installs eleven memories distilled from John Maeda's <em>The Laws of Simplicity</em>
          </p>
        </div>
        <ul className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
          {cards.map((c) => (
            <li
              key={c.label}
              className="flex flex-col gap-3 rounded-md border border-border bg-bg/60 p-5"
            >
              <p className="font-mono text-xs uppercase tracking-widish text-accent">{c.label}</p>
              <h3 className="text-lg font-medium text-fg">{c.title}</h3>
              <p className="text-sm text-muted">{c.body}</p>
            </li>
          ))}
        </ul>
        <div className="mt-8 flex flex-wrap gap-3">
          <a
            href={`${GITHUB_URL}/blob/main/docs/guides/packs.md`}
            className="inline-flex items-center rounded-md border border-border px-4 py-2 text-sm text-fg transition-colors hover:border-fg"
          >
            Packs guide
          </a>
          <a
            href={`${GITHUB_URL}/blob/main/docs/adr/0020-memento-packs.md`}
            className="inline-flex items-center rounded-md border border-border px-4 py-2 text-sm text-fg transition-colors hover:border-fg"
          >
            ADR-0020
          </a>
        </div>
      </div>
    </section>
  );
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
    <section aria-labelledby="dashboard-h2" className="scroll-mt-20 border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8 md:py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">~/your_store</p>
        <h2 id="dashboard-h2" className="max-w-3xl text-3xl font-medium tracking-tight md:text-4xl">
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
  // Four pillars + Packs + a universal-compatibility chip. The
  // pillars (Local / Typed / Audited / Yours) are the moat; the
  // last two cards are the "and also" supporting facts. Order is
  // deliberate — pillars first.
  const items = [
    {
      title: 'Local',
      body: 'One SQLite file under your home directory. No cloud, no telemetry, no outbound network calls by default. Fully offline.',
    },
    {
      title: 'Typed',
      body: "Five memory kinds — fact, preference, decision, todo, snippet — with kind-specific fields. Reason about what's still true, not just retrieve text blobs.",
    },
    {
      title: 'Audited',
      body: "Every write produces an event in an append-only log. Conflicts surface for triage. Memories decay if you don't confirm them.",
    },
    {
      title: 'Yours',
      body: 'Configurable behavior, JSONL export, Apache-2.0. Carry your memory between machines, leave any time. No vendor lock-in.',
    },
    {
      title: 'Packs',
      body: 'Curated YAML bundles of memories. Install with one command; share by file, URL, or community registry. Provenance tagged automatically.',
    },
    {
      title: 'Universal',
      body: 'MCP-native and LLM-agnostic. Plugs into Claude Desktop, Claude Code, Cursor, Copilot, Cline, OpenCode, Aider, custom agents — works with whatever model your client talks to.',
    },
  ];
  return (
    <section aria-labelledby="features-h2" className="scroll-mt-20 border-b border-border bg-bg/40">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8 md:py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">~/principles</p>
        <h2 id="features-h2" className="text-3xl font-medium tracking-tight md:text-4xl">
          What Memento is.
        </h2>
        <p className="mt-4 font-mono text-sm uppercase tracking-widish text-accent">
          Local. Typed. Audited. Yours.
        </p>
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

/**
 * "Memento vs alternatives" comparison.
 *
 * Renders a wide table on md+ and a stacked card-per-tool layout
 * on small screens, since 5-column tables don't fit on phones.
 * Both views read the same data from `comparison.ts`, so a row
 * change updates both. The point of this section is GEO: AI
 * search engines surface comparison-shaped content for "X vs Y"
 * queries when the contrast is concrete (yes/no), not hand-wavy.
 */
function Comparison(): JSX.Element {
  const { columns, rows } = COMPARISON;
  return (
    <section
      id="compared-to"
      aria-labelledby="comparison-h2"
      className="scroll-mt-20 border-b border-border"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8 md:py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">~/compared_to</p>
        <h2
          id="comparison-h2"
          className="max-w-3xl text-3xl font-medium tracking-tight md:text-4xl"
        >
          Memento vs the alternatives.
        </h2>
        <p className="mt-6 max-w-prose text-muted">
          The closest comparable tools are vendor-specific: ChatGPT Memory (OpenAI), Claude Projects
          (Anthropic), and the per-client config files most coding assistants ship with (
          <code className="font-mono text-fg">CLAUDE.md</code>,{' '}
          <code className="font-mono text-fg">.cursorrules</code>,{' '}
          <code className="font-mono text-fg">copilot-instructions.md</code>). They each solve one
          slice of the problem; Memento is the only one that's local-first and works across every AI
          tool you use.
        </p>
        <div className="mt-12 hidden overflow-x-auto md:block">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="py-3 pr-4 text-left font-mono text-xs uppercase tracking-widish text-muted">
                  Property
                </th>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className="px-3 py-3 text-left font-mono text-xs uppercase tracking-widish text-muted"
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.property} className="border-b border-border/60 align-top">
                  <th scope="row" className="py-3 pr-4 text-left font-medium text-fg">
                    {row.property}
                  </th>
                  {columns.map((c) => {
                    const value = row[c.key];
                    const isMemento = c.key === 'memento';
                    return (
                      <td
                        key={c.key}
                        className={`px-3 py-3 text-muted ${isMemento ? 'font-medium text-fg' : ''}`}
                      >
                        {value}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Mobile: one card per tool, with rows listed underneath. */}
        <div className="mt-12 grid gap-6 md:hidden">
          {columns.map((c) => (
            <div key={c.key} className="rounded-md border border-border bg-bg/60 p-5">
              <h3
                className={`font-mono text-sm uppercase tracking-widish ${
                  c.key === 'memento' ? 'text-accent' : 'text-muted'
                }`}
              >
                {c.label}
              </h3>
              <dl className="mt-4 grid gap-2 text-sm">
                {rows.map((row) => (
                  <div key={row.property} className="grid grid-cols-2 gap-2">
                    <dt className="text-muted">{row.property}</dt>
                    <dd className={c.key === 'memento' ? 'font-medium text-fg' : 'text-fg/80'}>
                      {row[c.key]}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Faq(): JSX.Element {
  return (
    <section id="faq" aria-labelledby="faq-h2" className="scroll-mt-20 border-b border-border">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8 md:py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widish text-muted">~/faq</p>
        <h2 id="faq-h2" className="text-3xl font-medium tracking-tight md:text-4xl">
          Frequently asked.
        </h2>
        <dl className="mt-12 grid gap-8 md:grid-cols-2">
          {FAQ_ITEMS.map((item) => (
            <div key={item.question} className="flex flex-col gap-3">
              <dt className="text-lg font-medium text-fg">{item.question}</dt>
              <dd className="max-w-prose whitespace-pre-line text-sm text-muted md:text-base">
                {item.answer}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Footer(): JSX.Element {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted md:flex-row md:items-center md:justify-between md:px-8">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <Wordmark className="text-sm" />
            <span className="font-mono text-xs">Apache-2.0 · local-first · no telemetry</span>
          </div>
          {/* Visible freshness signal so LLMs reading body text
              (not just JSON-LD) can cite a "Last updated" date. The
              <time dateTime> uses the ISO timestamp; the display
              text is the human-readable form. */}
          <p className="font-mono text-xs">
            Last updated{' '}
            <time dateTime={__MEMENTO_LAST_MODIFIED_ISO__}>{__MEMENTO_LAST_MODIFIED_HUMAN__}</time>
            {' · '}
            <a className="hover:text-fg" href="/llms.txt">
              llms.txt
            </a>
          </p>
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
