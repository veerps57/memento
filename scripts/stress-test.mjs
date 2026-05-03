#!/usr/bin/env node
// scripts/stress-test.mjs — Memento stress-test runner.
//
// Exercises the engine end-to-end in a single command: correctness probes
// over the public command surface, write throughput at scale, search and
// list latency at multiple corpus sizes, recall on planted needles, vector
// retrieval, and `compact.run`. Emits a markdown report with thresholded
// pass/fail and warning markers.
//
// Usage:
//   node scripts/stress-test.mjs                              # standard mode (50k)
//   node scripts/stress-test.mjs --mode=quick                 # 5k, ~5s
//   node scripts/stress-test.mjs --mode=full                  # 200k, ~3 min
//   node scripts/stress-test.mjs --target=20000               # custom corpus size
//   node scripts/stress-test.mjs --no-vector                  # skip vector phase
//   node scripts/stress-test.mjs --out=./custom-report.md     # custom report path
//   node scripts/stress-test.mjs --db=/path/to/test.db        # custom DB path (caller-managed)
//
// Environment overrides (same as flags, useful for CI):
//   MEMENTO_STRESS_MODE, MEMENTO_STRESS_TARGET, MEMENTO_STRESS_OUT,
//   MEMENTO_STRESS_DB, MEMENTO_STRESS_NO_VECTOR
//
// Defaults:
//   - Test DB:  /tmp/memento-stress-test-<timestamp>.db   (timestamped, always
//               a fresh file; the user's real Memento DB is never touched)
//   - Report:   ./memento-stress-<timestamp>.md           (in the directory you
//               run the command from)
//
// Each invocation creates a NEW DB file. There is no `--reuse` mode: a stress
// test must run on an empty database to be meaningful. If you pass `--db=<path>`
// explicitly, you take responsibility for the contents of that path.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createMementoApp, executeCommand } from '../packages/core/dist/index.js';

// ----- Config -----

function parseArgs() {
  const args = new Map();
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) args.set(a.slice(2, eq), a.slice(eq + 1));
      else args.set(a.slice(2), 'true');
    }
  }
  const mode = args.get('mode') ?? process.env.MEMENTO_STRESS_MODE ?? 'standard';
  const presets = {
    quick: { target: 5_000, vectorSubset: 500, searchSamples: 20, snapshots: [5_000] },
    standard: {
      target: 50_000,
      vectorSubset: 2_000,
      searchSamples: 50,
      snapshots: [10_000, 50_000],
    },
    full: {
      target: 200_000,
      vectorSubset: 5_000,
      searchSamples: 50,
      snapshots: [10_000, 50_000, 100_000, 200_000],
    },
  };
  const preset = presets[mode] ?? presets.standard;
  const target = Number(args.get('target') ?? process.env.MEMENTO_STRESS_TARGET ?? preset.target);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Default DB lives under /tmp with the timestamp baked in so every run is on
  // a fresh, empty file. Default report lives in pwd so the artifact is easy
  // to find next to whatever you ran from.
  const defaultDbPath = `/tmp/memento-stress-test-${ts}.db`;
  const defaultOutPath = resolve(process.cwd(), `memento-stress-${ts}.md`);
  const dbPath = args.get('db') ?? process.env.MEMENTO_STRESS_DB ?? defaultDbPath;
  const callerProvidedDb = dbPath !== defaultDbPath;
  return {
    mode,
    target,
    ts,
    vectorSubset: Math.min(Number(args.get('vector-subset') ?? preset.vectorSubset), target),
    searchSamples: Number(args.get('search-samples') ?? preset.searchSamples),
    snapshots: preset.snapshots
      .filter((n) => n <= target)
      .concat(target)
      .filter((n, i, a) => a.indexOf(n) === i)
      .sort((a, b) => a - b),
    skipVector: (args.get('no-vector') ?? process.env.MEMENTO_STRESS_NO_VECTOR) === 'true',
    dbPath,
    callerProvidedDb,
    outPath: args.get('out') ?? process.env.MEMENTO_STRESS_OUT ?? defaultOutPath,
  };
}

// ----- Targets / thresholds (warning levels — values above turn the row yellow ⚠) -----

const THRESHOLDS = {
  writeThroughput: 5_000, // writes/sec, lower bound
  searchFtsP50: 20, // ms, upper bound
  searchFtsP95: 50,
  searchFtsP99: 150,
  listLimit10: 100, // ms upper bound at any corpus
  listLimit100: 200,
  listLimit1000: 400,
  contextP50: 200,
  contextP95: 300,
  vectorSearchP50: 600,
  vectorSearchP95: 1_000,
  compactBatchMs: 2_000,
};

const ACTOR = { type: 'cli' };
const OWNER = { type: 'local', id: 'self' };

// ----- Helpers -----

const ms = (start) => Number((performance.now() - start).toFixed(2));
const fileSizeMb = (p) => {
  try {
    return Number((statSync(p).size / 1024 / 1024).toFixed(1));
  } catch {
    return 0;
  }
};
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const stat = (lats) => ({
  p50: pct(lats, 50),
  p95: pct(lats, 95),
  p99: pct(lats, 99),
  n: lats.length,
});

async function exec(app, name, input) {
  const cmd = app.registry.get(name);
  if (!cmd) throw new Error(`No command registered: ${name}`);
  const r = await executeCommand(cmd, input, { actor: ACTOR });
  if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

async function timeMany(n, fn) {
  const lats = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn(i);
    lats.push(ms(t0));
  }
  return stat(lats);
}

function appVersion() {
  try {
    const pkgPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../packages/cli/package.json',
    );
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function gitInfo() {
  // stdio: ['pipe', 'pipe', 'ignore'] silences the "fatal: not a git repository"
  // stderr noise when the script runs outside a git checkout (e.g. CI artefact).
  const opts = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] };
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
    const sha = execSync('git rev-parse --short HEAD', opts).trim();
    const dirty = execSync('git status --porcelain', opts).trim() !== '';
    return { branch, sha, dirty };
  } catch {
    return { branch: 'unknown', sha: 'unknown', dirty: false };
  }
}

// ----- Synthetic content generator -----

const TOPICS = [
  'authentication',
  'database',
  'logging',
  'caching',
  'rate-limiting',
  'observability',
  'feature-flags',
  'migrations',
  'testing',
  'deployment',
  'security',
  'cryptography',
  'networking',
  'storage',
  'queueing',
  'streaming',
  'batch-jobs',
  'analytics',
  'billing',
  'notifications',
  'permissions',
  'audit',
  'compliance',
  'localization',
  'accessibility',
];
const ACTIONS = ['uses', 'prefers', 'rejected', 'evaluated', 'migrated to', 'deprecated'];
const TOOLS = [
  'PostgreSQL',
  'MySQL',
  'SQLite',
  'Redis',
  'Memcached',
  'Kafka',
  'RabbitMQ',
  'NATS',
  'Elasticsearch',
  'OpenSearch',
  'Prometheus',
  'Grafana',
  'Jaeger',
  'OpenTelemetry',
  'Sentry',
  'Datadog',
  'New Relic',
  'Honeycomb',
  'Vercel',
  'Netlify',
  'AWS Lambda',
  'Cloudflare Workers',
  'Fly.io',
  'Docker',
  'Kubernetes',
  'Nomad',
  'Terraform',
  'Pulumi',
  'Ansible',
  'Node.js',
  'Bun',
  'Deno',
  'pnpm',
  'npm',
  'yarn',
  'TypeScript',
  'JavaScript',
  'Rust',
  'Go',
  'Python',
  'Ruby',
];
const KINDS = [
  { type: 'fact' },
  { type: 'fact' },
  { type: 'fact' },
  { type: 'preference' },
  { type: 'preference' },
  { type: 'decision', rationale: 'team alignment + ecosystem fit' },
  { type: 'todo', due: null },
  { type: 'snippet', language: 'typescript' },
];

let prng = 1337;
const rand = () => {
  prng = (prng * 1103515245 + 12345) & 0x7fffffff;
  return prng / 0x7fffffff;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (min, max) => Math.floor(rand() * (max - min)) + min;

function genScope(i) {
  const r = rand();
  if (r < 0.6) return { type: 'global' };
  if (r < 0.85) return { type: 'repo', remote: `github.com/bench/repo-${i % 50}` };
  if (r < 0.95) return { type: 'workspace', path: `/Users/bench/work/proj-${i % 30}` };
  return { type: 'global' };
}

function genTags(i) {
  const tags = ['stress-corpus'];
  const pool = ['important', 'review', 'verified', 'draft', `bucket-${i % 100}`];
  const n = randInt(1, 4);
  for (let j = 0; j < n; j++) tags.push(pick(pool));
  return Array.from(new Set(tags));
}

function genContent(i) {
  const topic = pick(TOPICS);
  const tool = pick(TOOLS);
  const action = pick(ACTIONS);
  const variants = [
    `${topic}: We ${action} ${tool} for ${topic} because of latency profile and operational simplicity. Memo #${i}.`,
    `In project context, ${tool} ${action.replace('ed', '')} as the choice for ${topic}; revisit in Q4. Item #${i}.`,
    `User mentioned ${topic} approach with ${tool}; team consensus pending. Note ${i}.`,
    `Decision log entry: ${topic}/${tool} pairing — ${action} after spike. Reference ${i}.`,
  ];
  return pick(variants);
}

function genMemory(i) {
  const kind = pick(KINDS);
  const content =
    kind.type === 'preference' || kind.type === 'decision'
      ? `${pick(TOPICS)}-tool: ${pick(TOOLS).toLowerCase()}\n\n${genContent(i)}`
      : genContent(i);
  return {
    scope: genScope(i),
    owner: OWNER,
    kind,
    tags: genTags(i),
    pinned: rand() < 0.02,
    content,
    summary: null,
    storedConfidence: rand() < 0.1 ? rand() : 1,
  };
}

const NEEDLES = [
  {
    id: 'N1',
    query: 'Project Glacier Geneva launch',
    marker: 'STRESS-NEEDLE-001',
    content:
      'STRESS-NEEDLE-001 Project Glacier launches on 2027-03-14 in the Geneva region with strict latency budgets.',
  },
  {
    id: 'N2',
    query: '47 days retention analytics',
    marker: 'STRESS-NEEDLE-002',
    content:
      'STRESS-NEEDLE-002 The retention period for raw analytics is exactly 47 days, not 30 or 90.',
  },
  {
    id: 'N3',
    query: 'Honeycomb Prometheus traces metrics',
    marker: 'STRESS-NEEDLE-003',
    content:
      'STRESS-NEEDLE-003 Team agreed to use Honeycomb for traces and Prometheus for metrics — no Datadog.',
  },
  {
    id: 'N4',
    query: 'XChaCha20 Poly1305 KMS rotation',
    marker: 'STRESS-NEEDLE-004',
    content:
      'STRESS-NEEDLE-004 Encryption-at-rest uses XChaCha20-Poly1305 with KMS-managed keys and 30-day rotation.',
  },
  {
    id: 'N5',
    query: 'postmortem Thursdays Linear 72',
    marker: 'STRESS-NEEDLE-005',
    content:
      'STRESS-NEEDLE-005 Postmortem cadence: weekly on Thursdays, owners write-up in Linear within 72 hours.',
  },
];

const genNeedle = (n) => ({
  scope: { type: 'global' },
  owner: OWNER,
  kind: { type: 'fact' },
  tags: ['stress-corpus', 'needle'],
  pinned: false,
  content: n.content,
  summary: null,
  storedConfidence: 1,
});

// ----- Correctness suite -----
//
// Each test returns { pass, expected, actual, notes? }. The test ID is a
// stable identifier that survives across runs, so reports diffed over time
// stay aligned even as the engine evolves.

function makeCorrectnessTests() {
  return [
    // Conflict detection on opposing preferences with the same topic line.
    {
      id: 'CONFLICT-pref-detection',
      name: 'Conflict detection: opposing preferences on same topic',
      run: async (app) => {
        const scope = { type: 'repo', remote: 'github.com/stress-test/conflicts' };
        await exec(app, 'memory.write', {
          scope,
          kind: { type: 'preference' },
          tags: ['stress-correctness', 'conflict-pref'],
          content: 'package-manager: pnpm\n\nUser prefers pnpm.',
        });
        const second = await exec(app, 'memory.write', {
          scope,
          kind: { type: 'preference' },
          tags: ['stress-correctness', 'conflict-pref'],
          content: 'package-manager: yarn\n\nUser prefers yarn.',
        });
        // Give async post-write hook a brief moment
        await new Promise((r) => setTimeout(r, 200));
        // Then explicit scan to be sure
        const scan = await exec(app, 'conflict.scan', { mode: 'memory', memoryId: second.id });
        const list = await exec(app, 'conflict.list', { open: true });
        const total = scan.opened.length + list.length;
        return {
          pass: total >= 1,
          expected: '≥1 open conflict',
          actual: `${total} open (scan opened: ${scan.opened.length}, list returned: ${list.length})`,
        };
      },
    },
    // Within-batch dedup: byte-identical candidates submitted together
    // should collapse to a single memory once async extraction settles.
    {
      id: 'EXTRACT-batch-dedup',
      name: 'Extract in-batch dedup (3 byte-identical candidates)',
      run: async (app) => {
        const phrase = `STRESS-DEDUP-${Date.now()} the bench dedup probe phrase.`;
        const candidates = [
          { kind: 'fact', content: phrase, tags: ['stress-correctness', 'extract-dedup'] },
          { kind: 'fact', content: phrase, tags: ['stress-correctness', 'extract-dedup'] },
          { kind: 'fact', content: phrase, tags: ['stress-correctness', 'extract-dedup'] },
        ];
        await exec(app, 'memory.extract', { candidates, scope: { type: 'global' } });
        // Async extraction (default `extraction.processing: 'async'`). Poll until
        // at least one matching row appears, with a 5s budget — slow CI machines
        // can take longer than a fixed sleep would tolerate.
        let matching = [];
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const list = await exec(app, 'memory.list', { tags: ['extract-dedup'], limit: 10 });
          matching = list.filter((m) => m.content === phrase);
          if (matching.length >= 1) {
            // Give the extractor a moment to finish writing duplicates if the
            // bug is present. If dedup works we still see exactly 1; if broken
            // we see 3. Either way the assertion below is meaningful.
            await new Promise((r) => setTimeout(r, 500));
            const after = await exec(app, 'memory.list', { tags: ['extract-dedup'], limit: 10 });
            matching = after.filter((m) => m.content === phrase);
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        return {
          pass: matching.length === 1,
          expected: '1 memory written (deduped)',
          actual: `${matching.length} memories written`,
        };
      },
    },
    // Scrubber: standard catches
    {
      id: 'SCR-jwt',
      name: 'Scrubber catches JWT-shaped tokens',
      run: async (app) => {
        const r = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'scrubber'],
          content: 'Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.signature_8chars_extra',
        });
        return {
          pass: r.content.includes('<redacted:jwt>'),
          expected: '<redacted:jwt> present',
          actual: r.content,
        };
      },
    },
    {
      id: 'SCR-aws',
      name: 'Scrubber catches AWS access key id (AKIA)',
      run: async (app) => {
        const r = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'scrubber'],
          content: 'Access: AKIAIOSFODNN7EXAMPLE',
        });
        return {
          pass: r.content.includes('<redacted:aws-access-key>'),
          expected: '<redacted:aws-access-key>',
          actual: r.content,
        };
      },
    },
    {
      id: 'SCR-bearer',
      name: 'Scrubber catches Authorization: Bearer header',
      run: async (app) => {
        const r = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'scrubber'],
          content: 'Header: Authorization: Bearer abcdefghijklmnop1234567890XYZW',
        });
        return {
          pass: r.content.includes('<redacted:bearer-token>'),
          expected: '<redacted:bearer-token>',
          actual: r.content,
        };
      },
    },
    // Scrubber: secret patterns that have proven hard to catch in practice
    // (DB connection strings, compound variable names, query-string secrets).
    {
      id: 'SCR-conn-string',
      name: 'Scrubber redacts password in DB connection string',
      run: async (app) => {
        const r = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'scrubber'],
          content: 'DB: postgres://admin:hunter2secret@db.example.com:5432/main',
        });
        // Three things must hold for a proper fix:
        //   (a) password is gone
        //   (b) host (db.example.com) is preserved (the email rule currently eats it)
        //   (c) the redaction is NOT mislabeled as <email-redacted>
        // Host check anchored on the surrounding URL chars so the
        // substring can only match at its exact post-credentials
        // position (silences CodeQL's URL-substring sanitization rule).
        const passwordGone = !r.content.includes('hunter2secret');
        const hostPreserved = r.content.includes('@db.example.com:5432/');
        const notMislabeled = !r.content.includes('<email-redacted>');
        return {
          pass: passwordGone && hostPreserved && notMislabeled,
          expected: 'password gone, host preserved, not mislabeled as <email-redacted>',
          actual: r.content,
        };
      },
    },
    {
      id: 'SCR-mysql-host',
      name: 'Scrubber redacts mysql:// password (no FQDN host)',
      run: async (app) => {
        const r = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'scrubber'],
          content: 'DB: mysql://root:rootpw_secret@mysql-host/sales',
        });
        return {
          pass: !r.content.includes('rootpw_secret'),
          expected: 'rootpw_secret not present',
          actual: r.content,
        };
      },
    },
    {
      id: 'SCR-underscore-name',
      name: 'Scrubber catches underscore-bound secret names',
      run: async (app) => {
        const r = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'scrubber'],
          content:
            'Config: secret_token: foobar_value AND access_token: snake.case.token AND aws_session_token: FQoG/abc',
        });
        const leaked =
          r.content.includes('foobar_value') ||
          r.content.includes('snake.case.token') ||
          r.content.includes('FQoG/abc');
        return {
          pass: !leaked,
          expected: 'no compound-name secrets leaked',
          actual: r.content,
        };
      },
    },
    {
      id: 'SCR-url-greedy',
      name: 'Scrubber URL ?secret= regex does not eat trailing params',
      run: async (app) => {
        const r = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'scrubber'],
          content:
            'Link: https://app.example.com/reset?secret=abc123longSecretValue&user=42&campaign=launch',
        });
        return {
          pass: r.content.includes('user=42') && r.content.includes('campaign=launch'),
          expected: 'user=42 and campaign=launch preserved',
          actual: r.content,
        };
      },
    },
    // Embedding-store invariant: caller-supplied vectors must match the
    // configured embedder's model and dimension.
    {
      id: 'EMBED-dim-mismatch',
      name: 'set_memory_embedding rejects dim mismatch with configured model',
      run: async (app) => {
        const m = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'embedding-mismatch'],
          content: 'Embedding mismatch probe.',
        });
        // Configured embedder is bge-base-en-v1.5/768. Try to set a 3-dim vector under the same model name.
        let result;
        try {
          await exec(app, 'memory.set_embedding', {
            id: m.id,
            model: 'bge-base-en-v1.5',
            dimension: 3,
            vector: [1, 2, 3],
          });
          result = {
            pass: false,
            expected: 'rejected with dim-mismatch error',
            actual: 'accepted',
          };
        } catch (e) {
          result = { pass: true, expected: 'rejected', actual: e.message.slice(0, 80) };
        }
        // Always clean up so the bad embedding doesn't poison vector search later
        try {
          await exec(app, 'memory.forget', { id: m.id, reason: 'C6 cleanup', confirm: true });
        } catch {}
        return result;
      },
    },
    // Update contract: `update_memory` must reject content/scope changes
    // (those route through `supersede` to preserve audit history).
    {
      id: 'UPD-content',
      name: 'update_memory rejects content patches',
      run: async (app) => {
        const m = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'update-contract'],
          content: 'Original content.',
        });
        try {
          await exec(app, 'memory.update', { id: m.id, patch: { content: 'New content!' } });
          return { pass: false, expected: 'rejected', actual: 'accepted' };
        } catch (e) {
          return {
            pass: e.message.includes('supersede') || e.message.includes('cannot update'),
            expected: 'rejected with supersede pointer',
            actual: e.message.slice(0, 80),
          };
        }
      },
    },
    {
      id: 'UPD-scope',
      name: 'update_memory rejects scope patches',
      run: async (app) => {
        const m = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'update-contract'],
          content: 'Scope-immutable probe.',
        });
        try {
          await exec(app, 'memory.update', { id: m.id, patch: { scope: { type: 'global' } } });
          return { pass: false, expected: 'rejected', actual: 'accepted' };
        } catch (e) {
          return {
            pass: e.message.includes('immutable') || e.message.includes('supersede'),
            expected: 'rejected as immutable',
            actual: e.message.slice(0, 80),
          };
        }
      },
    },
    // State machine
    {
      id: 'SM-restore-active',
      name: 'restore on active memory rejected',
      run: async (app) => {
        const m = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'state-machine'],
          content: 'State-machine probe.',
        });
        try {
          await exec(app, 'memory.restore', { id: m.id });
          return { pass: false, expected: 'CONFLICT', actual: 'accepted' };
        } catch (e) {
          return {
            pass: e.message.includes('CONFLICT') || e.message.includes('not in'),
            expected: 'CONFLICT',
            actual: e.message.slice(0, 80),
          };
        }
      },
    },
    {
      id: 'SM-double-forget',
      name: 'double-forget rejected',
      run: async (app) => {
        const m = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'state-machine'],
          content: 'Double-forget probe.',
        });
        await exec(app, 'memory.forget', { id: m.id, reason: 'first', confirm: true });
        try {
          await exec(app, 'memory.forget', { id: m.id, reason: 'second', confirm: true });
          return { pass: false, expected: 'CONFLICT', actual: 'accepted' };
        } catch (e) {
          return {
            pass: e.message.includes('CONFLICT') || e.message.includes('not in'),
            expected: 'CONFLICT',
            actual: e.message.slice(0, 80),
          };
        }
      },
    },
    // Idempotency
    {
      id: 'IDEM-clientToken',
      name: 'clientToken dedupe returns existing id on repeat write',
      run: async (app) => {
        const scope = { type: 'global' };
        const token = `stress-idem-${Date.now()}`;
        const a = await exec(app, 'memory.write', {
          scope,
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'idempotency'],
          content: 'Idempotency probe A.',
          clientToken: token,
        });
        const b = await exec(app, 'memory.write', {
          scope,
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'idempotency'],
          content: 'Idempotency probe B (different content).',
          clientToken: token,
        });
        return {
          pass: a.id === b.id && b.content === a.content,
          expected: 'same id, content stays as A',
          actual: `a.id=${a.id.slice(-6)} b.id=${b.id.slice(-6)} contentMatch=${a.content === b.content}`,
        };
      },
    },
    // Schema validation
    {
      id: 'SCHEMA-content-empty',
      name: 'Empty content rejected',
      run: async (app) => {
        try {
          await exec(app, 'memory.write', {
            scope: { type: 'global' },
            kind: { type: 'fact' },
            tags: ['stress-correctness', 'schema'],
            content: '',
          });
          return { pass: false, expected: 'rejected', actual: 'accepted' };
        } catch (e) {
          return {
            pass: e.message.includes('INVALID'),
            expected: 'INVALID_INPUT',
            actual: e.message.slice(0, 80),
          };
        }
      },
    },
    {
      id: 'SCHEMA-tag-count',
      name: 'tag count enforcement (default cap 64)',
      run: async (app) => {
        const tags = ['stress-correctness', 'schema'];
        for (let i = 0; i < 65; i++) tags.push(`tag-${i}`);
        try {
          await exec(app, 'memory.write', {
            scope: { type: 'global' },
            kind: { type: 'fact' },
            tags,
            content: 'Tag count probe.',
          });
          return { pass: false, expected: 'rejected (>64 tags)', actual: 'accepted' };
        } catch (e) {
          return {
            pass: e.message.includes('INVALID') || e.message.includes('schema'),
            expected: 'INVALID_INPUT',
            actual: e.message.slice(0, 80),
          };
        }
      },
    },
    // Vendor secret rules — each new pattern must be caught by its labeled placeholder.
    ...['stripe-key', 'google-api-key', 'sendgrid-key', 'discord-token'].map((ruleId) => ({
      id: `SCR-${ruleId}`,
      name: `Scrubber catches ${ruleId}`,
      run: async (app) => {
        // Synthetic vendor-key shapes — assembled at runtime so source-level
        // secret scanners (GitHub push-protection, etc.) don't flag the
        // literal. None of these are real secrets; they exercise the regex
        // shape only.
        const samples = {
          'stripe-key': `pay ${'sk_'}live_51H${'x'.repeat(24)}LkvLbW today`,
          'google-api-key': `maps ${'AI'}za${'SyD'}${'x'.repeat(32)} end`,
          'sendgrid-key': `api SG.${'a'.repeat(22)}.${'b'.repeat(43)} end`,
          'discord-token': `bot ${'M'}${'A'.repeat(25)}.${'b'.repeat(6)}.${'C'.repeat(38)} end`,
        };
        const r = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'scrubber'],
          content: samples[ruleId],
        });
        return {
          pass: r.content.includes(`<redacted:${ruleId}>`),
          expected: `<redacted:${ruleId}>`,
          actual: r.content.slice(0, 80),
        };
      },
    })),
    {
      id: 'SCR-auth-basic',
      name: 'Scrubber catches Authorization: Basic / Digest',
      run: async (app) => {
        const r = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'scrubber'],
          content: 'header Authorization: Basic dXNlcjpzZWNyZXRwYXNzd29yZA==',
        });
        return {
          pass: r.content.includes('<redacted:basic-auth>'),
          expected: '<redacted:basic-auth>',
          actual: r.content,
        };
      },
    },
    {
      id: 'SCR-credit-card',
      name: 'Scrubber catches credit-card numbers (Visa 4-4-4-4 + AmEx 4-6-5)',
      run: async (app) => {
        const r = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'scrubber'],
          content: 'card 4111-1111-1111-1111 and amex 3782-822463-10005 today',
        });
        return {
          pass:
            !r.content.includes('4111-1111-1111-1111') && !r.content.includes('3782-822463-10005'),
          expected: 'both card numbers redacted',
          actual: r.content,
        };
      },
    },
    {
      id: 'SCR-ssn',
      name: 'Scrubber catches US Social Security numbers',
      run: async (app) => {
        const r = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'scrubber'],
          content: 'ssn 123-45-6789 today',
        });
        return {
          pass: !r.content.includes('123-45-6789'),
          expected: 'SSN redacted',
          actual: r.content,
        };
      },
    },
    // Cross-type kind change rejected.
    {
      id: 'UPD-kind-metadata-loss',
      name: 'update_memory rejects cross-type kind changes (snippet → fact)',
      run: async (app) => {
        const m = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'snippet', language: 'typescript' },
          tags: ['stress-correctness', 'kind-change'],
          content: 'function probe() { return true; }',
        });
        try {
          await exec(app, 'memory.update', { id: m.id, patch: { kind: { type: 'fact' } } });
          return { pass: false, expected: 'rejected', actual: 'accepted' };
        } catch (e) {
          return {
            pass:
              e.message.includes('cannot change memory kind') || e.message.includes('supersede'),
            expected: 'rejected with supersede pointer',
            actual: e.message.slice(0, 80),
          };
        }
      },
    },
    // forget_many tags filter.
    {
      id: 'BULK-forget-tags-filter',
      name: 'forget_many supports a `tags` filter',
      run: async (app) => {
        const tag = `bulk-tag-${Date.now()}`;
        for (let i = 0; i < 3; i++) {
          await exec(app, 'memory.write', {
            scope: { type: 'global' },
            kind: { type: 'fact' },
            tags: ['stress-correctness', tag],
            content: `bulk-tag-target-${i}`,
          });
        }
        const result = await exec(app, 'memory.forget_many', {
          filter: { tags: [tag] },
          dryRun: false,
          confirm: true,
        });
        return {
          pass: result.matched === 3 && result.applied === 3,
          expected: '3 matched, 3 applied',
          actual: `matched=${result.matched} applied=${result.applied}`,
        };
      },
    },
    // forget_many dryRun without reason.
    {
      id: 'BULK-forget-dryrun-no-reason',
      name: 'forget_many({dryRun: true, confirm: true}) accepts no `reason`',
      run: async (app) => {
        const tag = `bulk-noreason-${Date.now()}`;
        await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', tag],
          content: 'no-reason probe',
        });
        try {
          const result = await exec(app, 'memory.forget_many', {
            filter: { tags: [tag] },
            dryRun: true,
            confirm: true,
          });
          return {
            pass: result.dryRun === true && result.matched === 1,
            expected: 'dryRun result with matched=1, no `reason` required',
            actual: JSON.stringify(result),
          };
        } catch (e) {
          return { pass: false, expected: 'no error', actual: e.message.slice(0, 120) };
        }
      },
    },
    // schema-error UX uniformity.
    {
      id: 'SCHEMA-error-uniformity',
      name: 'Schema-validation errors include the field path + detail (no terse fallback)',
      run: async (app) => {
        try {
          await exec(app, 'memory.write', {
            scope: { type: 'global' },
            kind: { type: 'fact' },
            tags: ['stress-correctness', 'schema-uniformity'],
            content: '',
          });
          return { pass: false, expected: 'rejected', actual: 'accepted' };
        } catch (e) {
          // Old behaviour: `INVALID_INPUT: <op>: input failed schema validation`.
          // New behaviour: `INVALID_INPUT: ...\n  - content: ...detail...`.
          return {
            pass:
              !e.message.includes('input failed schema validation') &&
              /\bcontent\b/i.test(e.message),
            expected:
              'message includes "content" field detail, not "input failed schema validation"',
            actual: e.message.slice(0, 120),
          };
        }
      },
    },
    // session scope id error.
    {
      id: 'SCOPE-session-id-helpful',
      name: 'Invalid session scope id surfaces a ULID-formatted error',
      run: async (app) => {
        try {
          await exec(app, 'memory.write', {
            scope: { type: 'session', id: 'not-a-ulid' },
            kind: { type: 'fact' },
            tags: ['stress-correctness'],
            content: 'session id probe',
          });
          return { pass: false, expected: 'rejected', actual: 'accepted' };
        } catch (e) {
          return {
            pass: /26-character/iu.test(e.message) && /ULID|Crockford/iu.test(e.message),
            expected: 'message references the 26-char ULID format',
            actual: e.message.slice(0, 120),
          };
        }
      },
    },
    // whitespace-only search.
    {
      id: 'SEARCH-whitespace-rejected',
      name: 'memory.search rejects whitespace-only text',
      run: async (app) => {
        try {
          await exec(app, 'memory.search', { text: '   \t \n ', limit: 5 });
          return { pass: false, expected: 'rejected', actual: 'accepted' };
        } catch (e) {
          return {
            pass: /non-whitespace/iu.test(e.message),
            expected: 'message references non-whitespace requirement',
            actual: e.message.slice(0, 120),
          };
        }
      },
    },
    // NFC normalization.
    {
      id: 'WRITE-nfc-normalized',
      name: 'Stored content is NFC-normalized on write',
      run: async (app) => {
        const nfd = 'café'; // 'café' decomposed
        const nfc = 'café'; // 'café' precomposed
        const m = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'nfc'],
          content: nfd,
        });
        return {
          pass: m.content === nfc,
          expected: 'content normalized to NFC',
          actual: `length=${m.content.length} content=${JSON.stringify(m.content)}`,
        };
      },
    },
    // zero-width strip + bidi reject.
    {
      id: 'WRITE-zero-width-stripped',
      name: 'Zero-width chars stripped on write; bidi-override rejected',
      run: async (app) => {
        const m = await exec(app, 'memory.write', {
          scope: { type: 'global' },
          kind: { type: 'fact' },
          tags: ['stress-correctness', 'unicode'],
          content: 'pa​ss‌wo‍rd﻿leak',
        });
        const stripped = m.content === 'passwordleak';
        let bidiRejected = false;
        try {
          await exec(app, 'memory.write', {
            scope: { type: 'global' },
            kind: { type: 'fact' },
            tags: ['stress-correctness', 'unicode'],
            content: 'normal text ‮ reversed evil',
          });
        } catch (e) {
          bidiRejected = /U\+202E|bidirectional/iu.test(e.message);
        }
        return {
          pass: stripped && bidiRejected,
          expected: 'zero-width stripped AND bidi-override rejected',
          actual: `stripped=${stripped} bidiRejected=${bidiRejected} content=${JSON.stringify(m.content)}`,
        };
      },
    },
  ];
}

async function runCorrectnessSuite(app) {
  const tests = makeCorrectnessTests();
  const results = [];
  for (const t of tests) {
    const t0 = performance.now();
    try {
      const r = await t.run(app);
      results.push({
        id: t.id,
        name: t.name,
        pass: r.pass,
        expected: r.expected,
        actual: r.actual,
        durationMs: ms(t0),
      });
    } catch (e) {
      results.push({
        id: t.id,
        name: t.name,
        pass: false,
        expected: '(test error)',
        actual: e.message.slice(0, 120),
        durationMs: ms(t0),
      });
    }
  }
  return results;
}

// ----- Performance suite -----

const QUERY_BANK = [
  'PostgreSQL',
  'authentication',
  'caching strategy',
  'feature flag',
  'observability',
  'latency profile',
  'kubernetes deployment',
  'logging stack',
  'rate limit',
  'analytics retention',
  'STRESS-NEEDLE-001',
  'STRESS-NEEDLE-003',
  'Geneva region',
  'XChaCha20',
  'Honeycomb',
  'pnpm',
  'TypeScript',
  'Rust queueing',
  'team consensus',
  'spike',
  'kafka streaming',
  'cryptography',
  'compliance audit',
  'docker swarm',
  'session storage',
  'redis cache',
];

async function snapshotPerf(app, count, searchSamples) {
  const sampleQueries = [];
  while (sampleQueries.length < searchSamples)
    sampleQueries.push(QUERY_BANK[sampleQueries.length % QUERY_BANK.length]);

  const search = await timeMany(searchSamples, async (i) =>
    exec(app, 'memory.search', { text: sampleQueries[i], limit: 10 }),
  );
  const listLats = {};
  for (const limit of [10, 100, 1000]) {
    const t = await timeMany(3, async () => exec(app, 'memory.list', { limit }));
    listLats[limit] = t;
  }
  const context = await timeMany(5, async () => exec(app, 'memory.context', {}));

  // Needle recall
  const needles = [];
  for (const n of NEEDLES) {
    const t0 = performance.now();
    const r = await exec(app, 'memory.search', { text: n.query, limit: 10 });
    const lat = ms(t0);
    const rank = r.results?.findIndex((h) => h.memory.content.includes(n.marker)) ?? -1;
    needles.push({
      id: n.id,
      query: n.query,
      rank: rank >= 0 ? rank + 1 : null,
      top1: rank === 0,
      top10: rank >= 0,
      latencyMs: lat,
    });
  }

  return { count, dbSizeMb: 0, search, list: listLats, context, needles };
}

async function runScopeFilterBench(app) {
  const unfiltered = await timeMany(5, async () => exec(app, 'memory.list', { limit: 10 }));
  const repoScoped = await timeMany(5, async () =>
    exec(app, 'memory.list', {
      limit: 10,
      scope: { type: 'repo', remote: 'github.com/bench/repo-10' },
    }),
  );
  const globalScoped = await timeMany(5, async () =>
    exec(app, 'memory.list', { limit: 10, scope: { type: 'global' } }),
  );
  const searchUnfiltered = await timeMany(10, async () =>
    exec(app, 'memory.search', { text: 'PostgreSQL', limit: 10 }),
  );
  const searchRepo = await timeMany(10, async () =>
    exec(app, 'memory.search', {
      text: 'PostgreSQL',
      limit: 10,
      scopes: [{ type: 'repo', remote: 'github.com/bench/repo-10' }],
    }),
  );
  return {
    listUnfiltered: unfiltered,
    listRepo: repoScoped,
    listGlobal: globalScoped,
    searchUnfiltered,
    searchRepo,
  };
}

const ADVERSARIAL_QUERIES = {
  short: ['k', 'a', 'i'],
  common: ['the', 'is', 'and'],
  rare: ['XChaCha20', 'Honeycomb', 'Glacier'],
  multi: ['authentication latency', 'kubernetes deployment strategy', 'PostgreSQL JSONB'],
  noMatch: ['absolutely-no-such-token-zzzzz', 'flying-purple-elephant-9999'],
};

async function runAdversarialBench(app) {
  const out = {};
  for (const [label, queries] of Object.entries(ADVERSARIAL_QUERIES)) {
    out[label] = await timeMany(queries.length * 3, async (i) =>
      exec(app, 'memory.search', { text: queries[i % queries.length], limit: 10 }),
    );
  }
  return out;
}

// ----- Vector phase -----

async function injectFakeEmbeddings(app, n) {
  const DIM = 768;
  const ids = await app.db.db
    .selectFrom('memories')
    .select('id')
    .where('status', '=', 'active')
    .where('embedding_json', 'is', null)
    .limit(n)
    .execute();
  if (ids.length === 0) return 0;
  const baseVec = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) baseVec[i] = Math.random() - 0.5;
  let mag = 0;
  for (let i = 0; i < DIM; i++) mag += baseVec[i] * baseVec[i];
  mag = Math.sqrt(mag);
  for (let i = 0; i < DIM; i++) baseVec[i] /= mag;
  const BATCH = 1000;
  const now = new Date().toISOString();
  for (let off = 0; off < ids.length; off += BATCH) {
    await app.db.db.transaction().execute(async (trx) => {
      for (const row of ids.slice(off, off + BATCH)) {
        const v = new Array(DIM);
        for (let i = 0; i < DIM; i++) v[i] = baseVec[i] + (Math.random() - 0.5) * 0.02;
        const json = JSON.stringify({
          model: 'bge-base-en-v1.5',
          dimension: DIM,
          vector: v,
          createdAt: now,
        });
        await trx
          .updateTable('memories')
          .set({ embedding_json: json })
          .where('id', '=', row.id)
          .execute();
      }
    });
  }
  return ids.length;
}

async function runVectorBench(_app, dbPath, _vectorSubset) {
  // Try to load the real embedder
  let embeddingProvider = null;
  let embedderError = null;
  try {
    const mod = await import('../packages/embedder-local/dist/index.js');
    if (typeof mod.createLocalEmbedder === 'function') {
      embeddingProvider = await mod.createLocalEmbedder({
        model: 'bge-base-en-v1.5',
        dimension: 768,
      });
      await embeddingProvider.embed('warmup');
    }
  } catch (e) {
    embedderError = e.message;
  }
  if (!embeddingProvider)
    return { skipped: true, reason: embedderError ?? 'embedder not available' };

  const app2 = await createMementoApp({
    dbPath,
    embeddingProvider,
    configOverrides: {
      'conflict.enabled': false,
      'retrieval.vector.enabled': true,
      'storage.busyTimeoutMs': 30_000,
    },
  });

  // Embed the needles with the real embedder so vector recall is meaningful
  const needleRows = await app2.db.db
    .selectFrom('memories')
    .select(['id', 'content'])
    .where('content', 'like', 'STRESS-NEEDLE-%')
    .execute();
  for (const row of needleRows) {
    const vec = await embeddingProvider.embed(row.content);
    await app2.memoryRepository.setEmbedding(
      row.id,
      {
        model: embeddingProvider.model,
        dimension: embeddingProvider.dimension,
        vector: vec,
      },
      { actor: ACTOR },
    );
  }

  const rare = await timeMany(QUERY_BANK.slice(13, 16).length * 3, async (i) =>
    exec(app2, 'memory.search', { text: QUERY_BANK[13 + (i % 3)], limit: 10 }),
  );
  const multi = await timeMany(3 * 3, async (i) =>
    exec(app2, 'memory.search', { text: ADVERSARIAL_QUERIES.multi[i % 3], limit: 10 }),
  );

  // Recall on a needle (with vector enabled)
  const r = await exec(app2, 'memory.search', { text: NEEDLES[0].query, limit: 10 });
  const rank = r.results?.findIndex((h) => h.memory.content.includes(NEEDLES[0].marker)) ?? -1;

  app2.close();
  return {
    skipped: false,
    rare,
    multi,
    needleRank: rank >= 0 ? rank + 1 : null,
    needlesEmbedded: needleRows.length,
  };
}

// ----- Compact phase -----

async function runCompactBench(app) {
  const t0 = performance.now();
  const r = await exec(app, 'compact.run', { confirm: true });
  return { durationMs: ms(t0), scanned: r.scanned ?? 0, archived: r.archived ?? 0 };
}

// ----- Report rendering -----

// Markdown table-cell escape. Order matters: backslashes are
// escaped FIRST so a subsequent `\|` substitution does not turn an
// already-doubled `\\` into the wrong sequence. Newlines collapse
// to spaces because table cells must stay on a single line — a
// `\n` mid-cell breaks the row in every renderer. Truncates AFTER
// escaping so the final length cap is honoured even when the input
// was bumped up by escape sequences.
function mdCell(value, maxLen) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .slice(0, maxLen);
}

function fmtThreshold(value, threshold, type = 'upper') {
  if (threshold === undefined) return '—';
  const ok = type === 'upper' ? value <= threshold : value >= threshold;
  const op = type === 'upper' ? '≤' : '≥';
  return `${ok ? '✅' : '⚠'} (target ${op} ${threshold})`;
}

function buildReport(data) {
  const {
    config,
    git,
    info,
    correctness,
    snapshots,
    scopeFilter,
    adversarial,
    vector,
    compact,
    durationMs,
  } = data;
  const lines = [];

  lines.push('# Memento stress test report');
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Mode:** ${config.mode} (target ${config.target.toLocaleString()} memories)`);
  lines.push(`**Memento version:** ${info.version}`);
  lines.push(
    `**Embedder:** ${info.embedder.configured ? `${info.embedder.model} / ${info.embedder.dimension}d` : 'not configured'}`,
  );
  lines.push(`**Git:** \`${git.branch}\` @ \`${git.sha}\`${git.dirty ? ' (dirty)' : ''}`);
  lines.push(`**DB:** \`${config.dbPath}\``);
  lines.push(`**Total duration:** ${(durationMs / 1000).toFixed(1)}s`);
  lines.push('');

  // Summary
  const cPass = correctness.filter((c) => c.pass).length;
  const cFail = correctness.length - cPass;
  lines.push('## Summary');
  lines.push('');
  lines.push('| Suite | Result |');
  lines.push('|---|---|');
  lines.push(
    `| Correctness | ${cPass}/${correctness.length} pass${cFail > 0 ? ` ⚠ **${cFail} FAIL**` : ' ✅'} |`,
  );
  if (snapshots.length > 0) {
    const last = snapshots[snapshots.length - 1];
    lines.push(
      `| Performance @ ${last.count.toLocaleString()} | search p50 ${last.search.p50}ms · list[10] ${last.list[10].p50}ms · context p50 ${last.context.p50}ms |`,
    );
    lines.push(
      `| Recall @ ${last.count.toLocaleString()} | ${last.needles.filter((n) => n.top1).length}/${last.needles.length} needles top-1 |`,
    );
  }
  if (vector && !vector.skipped) {
    lines.push(
      `| Vector + FTS hybrid | rare p50 ${vector.rare.p50}ms · multi p50 ${vector.multi.p50}ms · needle rank ${vector.needleRank ?? '∞'} |`,
    );
  }
  if (compact) {
    lines.push(
      `| compact.run | scanned ${compact.scanned}, archived ${compact.archived} in ${compact.durationMs}ms |`,
    );
  }
  lines.push('');

  // Correctness table
  lines.push('## Correctness suite');
  lines.push('');
  lines.push(
    "Each test has a stable ID so reports diffed over time stay aligned. ⚠ rows mark a probe that didn't pass on this run — they're the most useful place to start when triaging a regression.",
  );
  lines.push('');
  lines.push('| ID | Test | Result | Expected | Actual |');
  lines.push('|---|---|---|---|---|');
  for (const c of correctness) {
    const status = c.pass ? '✅' : '⚠';
    const actual = mdCell(c.actual, 80);
    const expected = mdCell(c.expected, 60);
    lines.push(`| \`${c.id}\` | ${c.name} | ${status} | ${expected} | ${actual} |`);
  }
  lines.push('');

  // Perf snapshots
  lines.push('## Performance snapshots');
  lines.push('');
  if (snapshots.length === 0) {
    lines.push('_No snapshots taken — corpus stayed below the smallest snapshot threshold._');
  } else {
    lines.push('### Write throughput');
    lines.push('');
    lines.push('| Corpus | DB size | Bytes/memory | Avg writes/sec | vs target |');
    lines.push('|---|---|---|---|---|');
    for (const s of snapshots) {
      const bpm = s.dbSizeMb && s.count ? Math.round((s.dbSizeMb * 1024 * 1024) / s.count) : '—';
      lines.push(
        `| ${s.count.toLocaleString()} | ${s.dbSizeMb}MB | ${bpm} | ${s.avgWritesPerSec ?? '—'} | ${s.avgWritesPerSec ? fmtThreshold(Number(s.avgWritesPerSec), THRESHOLDS.writeThroughput, 'lower') : '—'} |`,
      );
    }
    lines.push('');

    lines.push('### Search latency (FTS-only)');
    lines.push('');
    lines.push('| Corpus | p50 | p95 | p99 | p50 vs target | p95 vs target |');
    lines.push('|---|---|---|---|---|---|');
    for (const s of snapshots) {
      lines.push(
        `| ${s.count.toLocaleString()} | ${s.search.p50}ms | ${s.search.p95}ms | ${s.search.p99}ms | ${fmtThreshold(s.search.p50, THRESHOLDS.searchFtsP50)} | ${fmtThreshold(s.search.p95, THRESHOLDS.searchFtsP95)} |`,
      );
    }
    lines.push('');

    lines.push('### memory.list latency (unfiltered)');
    lines.push('');
    lines.push('| Corpus | limit=10 | limit=100 | limit=1000 | limit=10 vs target |');
    lines.push('|---|---|---|---|---|');
    for (const s of snapshots) {
      lines.push(
        `| ${s.count.toLocaleString()} | ${s.list[10].p50}ms | ${s.list[100].p50}ms | ${s.list[1000].p50}ms | ${fmtThreshold(s.list[10].p50, THRESHOLDS.listLimit10)} |`,
      );
    }
    lines.push('');

    lines.push('### get_memory_context latency');
    lines.push('');
    lines.push('| Corpus | p50 | p95 | p50 vs target |');
    lines.push('|---|---|---|---|');
    for (const s of snapshots) {
      lines.push(
        `| ${s.count.toLocaleString()} | ${s.context.p50}ms | ${s.context.p95}ms | ${fmtThreshold(s.context.p50, THRESHOLDS.contextP50)} |`,
      );
    }
    lines.push('');

    lines.push('### Needle recall (top-1 / top-10)');
    lines.push('');
    const last = snapshots[snapshots.length - 1];
    lines.push(`At ${last.count.toLocaleString()} memories:`);
    lines.push('');
    lines.push('| Needle | Query | Top-1 | Top-10 | Rank | Latency |');
    lines.push('|---|---|---|---|---|---|');
    for (const n of last.needles) {
      lines.push(
        `| ${n.id} | \`${n.query}\` | ${n.top1 ? '✅' : '❌'} | ${n.top10 ? '✅' : '❌'} | ${n.rank ?? '∞'} | ${n.latencyMs}ms |`,
      );
    }
    lines.push('');
  }

  if (scopeFilter) {
    lines.push('### Scope filter speedup');
    lines.push('');
    lines.push('| Operation | Unfiltered p50 | Repo-scoped p50 | Global-scoped p50 |');
    lines.push('|---|---|---|---|');
    lines.push(
      `| list limit=10 | ${scopeFilter.listUnfiltered.p50}ms | ${scopeFilter.listRepo.p50}ms | ${scopeFilter.listGlobal.p50}ms |`,
    );
    lines.push(
      `| search "PostgreSQL" | ${scopeFilter.searchUnfiltered.p50}ms | ${scopeFilter.searchRepo.p50}ms | — |`,
    );
    lines.push('');
  }

  if (adversarial) {
    lines.push('### Adversarial query patterns');
    lines.push('');
    lines.push('| Class | Sample | p50 | p95 | p99 |');
    lines.push('|---|---|---|---|---|');
    const samples = ADVERSARIAL_QUERIES;
    for (const [k, v] of Object.entries(adversarial)) {
      lines.push(`| ${k} | \`${samples[k][0]}\`, … | ${v.p50}ms | ${v.p95}ms | ${v.p99}ms |`);
    }
    lines.push('');
  }

  if (vector) {
    lines.push('### Vector + FTS hybrid');
    lines.push('');
    if (vector.skipped) {
      lines.push(`_Skipped: ${vector.reason}_`);
    } else {
      lines.push('| Query class | p50 | p95 | p99 | vs target |');
      lines.push('|---|---|---|---|---|');
      lines.push(
        `| rare | ${vector.rare.p50}ms | ${vector.rare.p95}ms | ${vector.rare.p99}ms | ${fmtThreshold(vector.rare.p50, THRESHOLDS.vectorSearchP50)} |`,
      );
      lines.push(
        `| multi | ${vector.multi.p50}ms | ${vector.multi.p95}ms | ${vector.multi.p99}ms | ${fmtThreshold(vector.multi.p50, THRESHOLDS.vectorSearchP50)} |`,
      );
      lines.push('');
      lines.push(`Vector recall on needle N1: rank **${vector.needleRank ?? '∞'}**`);
    }
    lines.push('');
  }

  if (compact) {
    lines.push('### compact.run');
    lines.push('');
    lines.push('| Metric | Value | vs target |');
    lines.push('|---|---|---|');
    lines.push(
      `| Wall-clock | ${compact.durationMs}ms | ${fmtThreshold(compact.durationMs, THRESHOLDS.compactBatchMs)} |`,
    );
    lines.push(`| Scanned | ${compact.scanned} | — |`);
    lines.push(`| Archived | ${compact.archived} | — |`);
    lines.push('');
  }

  lines.push('## Reproduction');
  lines.push('');
  lines.push('```bash');
  lines.push(`node scripts/stress-test.mjs --mode=${config.mode}`);
  lines.push('```');
  lines.push('');
  lines.push('See `docs/guides/stress-test.md` for full flag reference and metric explanations.');
  lines.push('');

  return lines.join('\n');
}

function buildTerminalSummary(data) {
  const { correctness, snapshots, vector, compact, config } = data;
  const lines = [];
  const cPass = correctness.filter((c) => c.pass).length;
  const cFail = correctness.length - cPass;
  lines.push('');
  lines.push('========== STRESS TEST SUMMARY ==========');
  lines.push(`Mode: ${config.mode} (target ${config.target.toLocaleString()})`);
  lines.push(
    `Correctness: ${cPass}/${correctness.length} pass${cFail > 0 ? ` (${cFail} FAIL)` : ''}`,
  );
  if (cFail > 0) {
    lines.push('  Failing tests:');
    for (const c of correctness.filter((x) => !x.pass)) {
      lines.push(`    [${c.id}] ${c.name}`);
    }
  }
  if (snapshots.length > 0) {
    const last = snapshots[snapshots.length - 1];
    lines.push(`Perf @ ${last.count.toLocaleString()}:`);
    lines.push(`  search FTS p50/p95: ${last.search.p50}/${last.search.p95}ms`);
    lines.push(`  list limit=10 p50: ${last.list[10].p50}ms`);
    lines.push(`  context p50: ${last.context.p50}ms`);
    lines.push(
      `  needles top-1: ${last.needles.filter((n) => n.top1).length}/${last.needles.length}`,
    );
  }
  if (vector && !vector.skipped) {
    lines.push(`Vector hybrid: rare p50 ${vector.rare.p50}ms, multi p50 ${vector.multi.p50}ms`);
  }
  if (compact) {
    lines.push(
      `Compact: scanned ${compact.scanned}, archived ${compact.archived} in ${compact.durationMs}ms`,
    );
  }
  lines.push(`Report: ${config.outPath}`);
  lines.push('=========================================');
  return lines.join('\n');
}

// ----- Main -----

async function main() {
  const config = parseArgs();
  const t0 = performance.now();
  console.error(
    `Memento stress test — mode=${config.mode}, target=${config.target.toLocaleString()}, db=${config.dbPath}`,
  );

  // The default DB path embeds the timestamp, so it is always a fresh file. If
  // the caller passed --db pointing at an existing non-empty file, warn — a
  // stress test on a polluted DB is meaningless.
  if (config.callerProvidedDb && existsSync(config.dbPath) && statSync(config.dbPath).size > 0) {
    console.warn(`  ⚠ --db points at an existing non-empty file (${fileSizeMb(config.dbPath)}MB).`);
    console.warn(
      '    Stress tests run on an empty DB by design. Delete the file or omit --db to use a fresh timestamped path.',
    );
  }

  const VERSION = appVersion();

  // ----- Correctness suite — run on its own app session with conflict.enabled=true.
  // We open a separate session because `conflict.enabled` is captured at app
  // construction by the post-write hook closure (see core/bootstrap.ts). If we
  // left it on for the seed phase, the hook would fire 50k+ times async and
  // pollute write-throughput numbers.
  console.error('\n[1/4] Running correctness suite...');
  // Wire a stub embedding provider so the EMBED-dim-mismatch probe
  // actually exercises the validation path (which is a no-op when
  // no embedder is configured — preserves the "raw vector for tests"
  // affordance for offline fixtures, but real users always have one).
  // We never call .embed() during the correctness suite, so the stub
  // doesn't need to do anything useful.
  const stubEmbedder = {
    model: 'bge-base-en-v1.5',
    dimension: 768,
    embed: async () => {
      throw new Error('stub embedder: embed should not be called during correctness suite');
    },
  };
  const correctnessApp = await createMementoApp({
    dbPath: config.dbPath,
    appVersion: VERSION,
    embeddingProvider: stubEmbedder,
    configOverrides: {
      'conflict.enabled': true,
      'retrieval.vector.enabled': false,
      'embedding.autoEmbed': false, // don't auto-embed (would fail via the stub)
      'storage.busyTimeoutMs': 30_000,
    },
  });
  const correctness = await runCorrectnessSuite(correctnessApp);
  correctnessApp.close();
  const cPass = correctness.filter((c) => c.pass).length;
  console.error(`  → ${cPass}/${correctness.length} pass`);
  for (const c of correctness.filter((x) => !x.pass)) console.error(`    ⚠ [${c.id}] ${c.name}`);

  // ----- Performance suite — fresh app session, conflict hook OFF.
  const app = await createMementoApp({
    dbPath: config.dbPath,
    appVersion: VERSION,
    configOverrides: {
      'conflict.enabled': false,
      'retrieval.vector.enabled': false,
      'storage.busyTimeoutMs': 30_000,
    },
  });

  console.error(`\n[2/4] Seeding ${config.target.toLocaleString()} memories...`);
  const snapshots = [];
  // Plant needles first
  await app.memoryRepository.writeMany(NEEDLES.map(genNeedle), { actor: ACTOR });
  let written = NEEDLES.length;
  let nextSnapshotIdx = 0;
  let cumulativeMs = 0;
  const BATCH_SIZE = 2_000;

  for (let i = NEEDLES.length; i < config.target; i += BATCH_SIZE) {
    const sz = Math.min(BATCH_SIZE, config.target - i);
    const batch = [];
    for (let j = 0; j < sz; j++) batch.push(genMemory(i + j));
    const t = performance.now();
    await app.memoryRepository.writeMany(batch, { actor: ACTOR });
    cumulativeMs += performance.now() - t;
    written += sz;

    while (
      nextSnapshotIdx < config.snapshots.length &&
      written >= config.snapshots[nextSnapshotIdx]
    ) {
      const target = config.snapshots[nextSnapshotIdx];
      process.stdout.write(`  @ ${written.toLocaleString()} memories — measuring... `);
      const snap = await snapshotPerf(app, written, config.searchSamples);
      snap.dbSizeMb = fileSizeMb(config.dbPath);
      snap.targetCount = target;
      snap.cumulativeWriteSec = (cumulativeMs / 1000).toFixed(1);
      snap.avgWritesPerSec = (written / (cumulativeMs / 1000)).toFixed(0);
      snapshots.push(snap);
      console.error(
        `search p50=${snap.search.p50}ms, list[10]=${snap.list[10].p50}ms, context=${snap.context.p50}ms, needles=${snap.needles.filter((n) => n.top1).length}/${snap.needles.length}`,
      );
      nextSnapshotIdx++;
    }
  }

  // ----- Phase 3: scope filter, adversarial, vector, compact -----
  console.error('\n[3/4] Scope filter / adversarial query benches...');
  const scopeFilter = await runScopeFilterBench(app);
  const adversarial = await runAdversarialBench(app);
  console.error(
    `  → list unscoped p50: ${scopeFilter.listUnfiltered.p50}ms vs repo-scoped p50: ${scopeFilter.listRepo.p50}ms`,
  );
  console.error(
    `  → adversarial: common p50=${adversarial.common.p50}ms, multi p50=${adversarial.multi.p50}ms`,
  );

  let vector = null;
  if (!config.skipVector) {
    console.error(
      `\n[4/4] Vector phase (injecting fake embeddings on ${config.vectorSubset} subset, then real-embedder hybrid search)...`,
    );
    const t = performance.now();
    const injected = await injectFakeEmbeddings(app, config.vectorSubset);
    console.error(`  → injected ${injected} fake embeddings in ${ms(t)}ms`);
    app.close();
    vector = await runVectorBench(app, config.dbPath, config.vectorSubset);
    if (vector.skipped) console.error(`  → skipped: ${vector.reason}`);
    else
      console.error(
        `  → rare p50 ${vector.rare.p50}ms, multi p50 ${vector.multi.p50}ms, needle rank ${vector.needleRank ?? '∞'}`,
      );
  } else {
    app.close();
    console.error('\n[4/4] Vector phase skipped (--no-vector)');
  }

  // Compact runs on the same DB; reopen briefly
  console.error('\nRunning compact.run...');
  const compactApp = await createMementoApp({
    dbPath: config.dbPath,
    configOverrides: { 'conflict.enabled': false, 'retrieval.vector.enabled': false },
  });
  const compact = await runCompactBench(compactApp);
  compactApp.close();
  console.error(
    `  → ${compact.durationMs}ms, scanned ${compact.scanned}, archived ${compact.archived}`,
  );

  // ----- Reopen briefly to grab system.info + configured-embedder details -----
  // We read embedder model/dim straight from the configStore so the header
  // reports the configured embedder regardless of whether the info-display
  // app instance happened to wire one up.
  const infoApp = await createMementoApp({
    dbPath: config.dbPath,
    appVersion: VERSION,
    configOverrides: { 'retrieval.vector.enabled': false },
  });
  const info = await exec(infoApp, 'system.info', {});
  const embedderConfigured = {
    model: infoApp.configStore.get('embedder.local.model'),
    dimension: infoApp.configStore.get('embedder.local.dimension'),
    autoEmbed: infoApp.configStore.get('embedding.autoEmbed'),
  };
  info.embedder = { ...info.embedder, ...embedderConfigured, configured: true };
  infoApp.close();

  const data = {
    config,
    git: gitInfo(),
    info,
    correctness,
    snapshots,
    scopeFilter,
    adversarial,
    vector,
    compact,
    durationMs: ms(t0),
  };
  const md = buildReport(data);
  mkdirSync(dirname(resolve(config.outPath)), { recursive: true });
  await writeFile(config.outPath, md, 'utf8');
  console.error(buildTerminalSummary(data));
}

main().catch((err) => {
  console.error('\nStress test failed:', err);
  process.exit(1);
});
