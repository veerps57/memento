#!/usr/bin/env node
// scripts/retrieval-eval.mjs — Memento retrieval-quality eval harness.
//
// Distinct from scripts/stress-test.mjs (which measures throughput &
// latency). This harness measures RETRIEVAL QUALITY: Recall@k,
// Precision@k, MRR, nDCG@10 — plus latency p50/p95/p99 and per-arm
// candidate-set sizes — over a labeled query set planted into a
// fresh in-memory SQLite. The fixture set is embedded inline below
// (`LABELED_QUERIES`); editing it changes what the harness measures.
//
// Usage:
//   node scripts/retrieval-eval.mjs                     # default: N=100,1000
//   node scripts/retrieval-eval.mjs --full              # adds N=10000
//   node scripts/retrieval-eval.mjs --n=100,1000,10000  # explicit sweep
//   node scripts/retrieval-eval.mjs --no-vector         # only measure FTS-only
//   node scripts/retrieval-eval.mjs --out=./report.md   # custom out path
//   node scripts/retrieval-eval.mjs --samples=3         # warmup runs per query
//   node scripts/retrieval-eval.mjs --no-tokenizer      # skip real-tokenizer pass
//
// Architectural notes (matching scripts/stress-test.mjs's conventions):
//   - Every measured query goes through the public command registry
//     via executeCommand (AGENTS.md rule 1).
//   - No new ConfigKeys are introduced; every threshold or weight
//     comes from a CLI flag or env var (rule 2). Defaults are
//     declared in DEFAULTS at the top so a reader can diff a run
//     by changing one place.
//   - The harness uses raw SQL UPDATE only to backdate `created_at`
//     and `last_confirmed_at` on planted seed rows, because the
//     repository write path stamps these from `Date.now()` and the
//     12-month temporal spread the gap analysis needs cannot be
//     produced any other way. This is a *test-side* concession; no
//     production code is modified and the queries under test still
//     go through the registry.
//   - Tokens are counted with the bge-base-en-v1.5 WordPiece
//     tokenizer (the tokenizer the embedder actually uses). Falls
//     back to a documented heuristic when the tokenizer can't load.

import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createMementoApp, executeCommand } from '../packages/core/dist/index.js';

// ----- Defaults / config -----

const DEFAULTS = {
  // Corpus sizes to evaluate. Override with --n=...
  ns: [100, 1000],
  fullExtraN: [10_000],
  // Samples per labeled query. Each query is run `samples` times
  // and the latency stats are computed over them. The retrieval
  // result is deterministic per (db, query) so only the FIRST
  // run's results contribute to Recall/MRR/nDCG; the others
  // exist for warm-cache latency stats.
  samples: 5,
  // How many planted "needle" memories per labeled query intent.
  // We plant exactly one positive needle per query (with
  // distinctive content), plus some easy-positive paraphrases
  // for the paraphrase-robustness case.
  // Filler haystack is generated to bring N up to target.
  warmupQueries: 3,
  // Candidate-cap probes are not yet wired here; the engine's
  // ranker only sees the union of `retrieval.candidate.ftsLimit`
  // and `retrieval.candidate.vectorLimit`. We log those defaults
  // in the report so a future delta-run can compare.
};

function parseArgs() {
  const args = new Map();
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) args.set(a.slice(2, eq), a.slice(eq + 1));
    else args.set(a.slice(2), 'true');
  }
  const explicit = args.get('n');
  const ns = explicit
    ? explicit
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isFinite(x) && x > 0)
    : args.get('full') === 'true'
      ? [...DEFAULTS.ns, ...DEFAULTS.fullExtraN]
      : DEFAULTS.ns;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = args.get('out') ?? resolve(process.cwd(), `eval-report-${ts}.md`);
  // Ranker strategy + weight overrides. Lets the harness A/B
  // `linear` vs `rrf` without rebuilding or touching ConfigKey
  // defaults. Weight flags only apply to the FTS and vector
  // arms — the four baseline arms (confidence / recency / scope
  // / pinned) keep their registry defaults.
  const strategy = args.get('strategy');
  if (strategy !== undefined && strategy !== 'linear' && strategy !== 'rrf') {
    throw new Error(`--strategy must be 'linear' or 'rrf' (got: ${strategy})`);
  }
  const ftsWeight = args.has('fts-weight') ? Number(args.get('fts-weight')) : undefined;
  const vectorWeight = args.has('vector-weight') ? Number(args.get('vector-weight')) : undefined;
  const rrfK = args.has('rrf-k') ? Number(args.get('rrf-k')) : undefined;
  const lambda = args.has('lambda') ? Number(args.get('lambda')) : undefined;
  const maxDuplicates = args.has('max-duplicates') ? Number(args.get('max-duplicates')) : undefined;
  const ftsMinScore = args.has('fts-min-score') ? Number(args.get('fts-min-score')) : undefined;
  const vectorMinCosine = args.has('vector-min-cosine')
    ? Number(args.get('vector-min-cosine'))
    : undefined;
  return {
    ts,
    ns,
    samples: Number(args.get('samples') ?? DEFAULTS.samples),
    skipVector: args.get('no-vector') === 'true',
    skipTokenizer: args.get('no-tokenizer') === 'true',
    outPath,
    strategy,
    ftsWeight,
    vectorWeight,
    rrfK,
    lambda,
    maxDuplicates,
    ftsMinScore,
    vectorMinCosine,
  };
}

const ACTOR = { type: 'cli' };

const ms = (start) => Number((performance.now() - start).toFixed(2));
const pct = (arr, p) => {
  if (arr.length === 0) return null;
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

function gitInfo() {
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

// ----- Tokenizer (bge-base-en-v1.5 WordPiece, locally cached) -----

async function loadTokenizer(skip) {
  if (skip) return null;
  try {
    // @huggingface/transformers is a transitive dep via
    // @psraghuveer/memento-embedder-local, not a workspace-root
    // dep. Resolve it via require.resolve from that package's
    // location so this script can run from anywhere.
    const { createRequire } = await import('node:module');
    const req = createRequire(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../packages/embedder-local/src/embedder.ts',
      ),
    );
    const transformersPath = req.resolve('@huggingface/transformers');
    const transformers = await import(transformersPath);
    // Use transformers.js's default cacheDir so the harness picks up
    // whatever model artefacts the embedder already cached on this
    // machine, and downloads them on first run otherwise.
    const tok = await transformers.AutoTokenizer.from_pretrained('Xenova/bge-base-en-v1.5');
    return (text) => {
      const r = tok(text, { add_special_tokens: false });
      // r.input_ids is a transformers.js Tensor with `.size` or `.dims`.
      const ids = r.input_ids;
      const len = ids?.size ?? ids?.dims?.reduce((a, b) => a * b, 1) ?? null;
      if (typeof len === 'number') return len;
      // Fallback: count nested numbers.
      return JSON.stringify(ids?.data ?? ids).match(/\d+/g)?.length ?? 0;
    };
  } catch (caught) {
    console.warn(
      `[tokenizer] failed to load bge WordPiece tokenizer, falling back to heuristic: ${caught.message}`,
    );
    return null;
  }
}

// ----- Embedder (real) -----

async function loadEmbedder() {
  try {
    const mod = await import('../packages/embedder-local/dist/index.js');
    const provider = await mod.createLocalEmbedder({
      model: 'bge-base-en-v1.5',
      dimension: 768,
    });
    await provider.embed('warmup');
    return provider;
  } catch (caught) {
    return { error: caught.message };
  }
}

// ----- Labeled query set -----
//
// Each item is one labeled retrieval case. `relevant` is the set of
// planted needle ids that should be returned (we plant them in
// seedNeedles). `mustNotInclude` (optional) lets us assert that a
// specific synthetic memory must NOT appear in the top-K, for
// supersession-bleed-through tests.

const NEEDLE_DEFS = [
  // B1 — paraphrase robustness on the ANN-index fact.
  {
    id: 'needle:ann-fact',
    kind: { type: 'fact' },
    scope: { type: 'global' },
    tags: ['eval-needle', 'topic:retrieval'],
    content:
      "Memento's brute-force vector backend rescans every embedding row on each cosine query — no ANN index. At 100k memories this becomes the dominant cost for memory.search when retrieval.vector.enabled=true. The sqlite-vec native backend is hinted at in ADR-0006 but not yet wired.",
    summary: 'Vector retrieval scans every row brute-force; sqlite-vec stub unwired',
  },
  // C — supersession-bleed: ground truth is the new R preference.
  {
    id: 'needle:stats-r',
    kind: { type: 'preference' },
    scope: { type: 'global' },
    tags: ['eval-needle', 'topic:stats-prefs'],
    content:
      'stats-script-language: r\n\nFor data-science notebooks in this audit, the user prefers R for ad-hoc statistics scripts (after switching away from Python).',
  },
  // The superseded predecessor — must NOT appear in default search.
  {
    id: 'needle:stats-python-old',
    kind: { type: 'preference' },
    scope: { type: 'global' },
    tags: ['eval-needle', 'topic:stats-prefs', 'eval-old'],
    content:
      'stats-script-language: python\n\nFor data-science notebooks in this audit, the user previously preferred Python over R for ad-hoc statistics scripts (this preference was later superseded).',
    forceSuperseded: 'needle:stats-r',
  },
  // D — temporal: a "decision last week" with a known createdAt.
  {
    id: 'needle:retrieval-decision',
    kind: { type: 'decision', rationale: 'pivot to hybrid fusion vs raw cosine' },
    scope: { type: 'global' },
    tags: ['eval-needle', 'topic:retrieval', 'topic:decision'],
    content:
      'retrieval-strategy: adopt-rrf\n\nLast week the team decided to evaluate Reciprocal Rank Fusion as a replacement for the current union+linear-weighted ranker. Linear normalization is batch-relative and underweights weak FTS hits when vector dominates the candidate set.',
    backdateDays: 7, // 7 days ago
  },
  // E — cross-scope: same content, written under a session scope.
  // We mark this with `scope.type === 'session'`; the harness gives
  // it a deterministic session id.
  {
    id: 'needle:session-fact',
    kind: { type: 'fact' },
    scope: { type: 'session', id: '01HSESSNHARNESSEVAR00000XY' },
    tags: ['eval-needle', 'topic:session'],
    content:
      'Session-local note: the harness writes this row in the session scope so cross-session retrieval probes have a concrete target.',
  },
  // N — diversity: 4 near-duplicate paraphrases + 1 distinct memory
  // on the same topic. Top-5 should ideally surface the 1 distinct
  // one (MMR would help here). Without MMR, we expect top-5 to be
  // the 5 near-duplicates and zero recall on the distinct one.
  {
    id: 'needle:dup-a',
    kind: { type: 'preference' },
    scope: { type: 'global' },
    tags: ['eval-needle', 'topic:caching'],
    content:
      'caching: prefer LRU eviction for in-memory caches because tail latency is more predictable than LFU on bursty workloads. (variant A)',
  },
  {
    id: 'needle:dup-b',
    kind: { type: 'preference' },
    scope: { type: 'global' },
    tags: ['eval-needle', 'topic:caching'],
    content:
      'caching: prefer LRU eviction for in-memory caches; tail latency stays predictable on bursty workloads. (variant B)',
  },
  {
    id: 'needle:dup-c',
    kind: { type: 'preference' },
    scope: { type: 'global' },
    tags: ['eval-needle', 'topic:caching'],
    content:
      'caching: prefer LRU eviction in in-memory cache layers because predictable tail latency matters more than hit rate. (variant C)',
  },
  {
    id: 'needle:dup-d',
    kind: { type: 'preference' },
    scope: { type: 'global' },
    tags: ['eval-needle', 'topic:caching'],
    content:
      'caching: prefer LRU over LFU for the in-memory cache eviction policy; predictable tails beat marginal hit-rate gains. (variant D)',
  },
  {
    id: 'needle:distinct-warmup',
    kind: { type: 'fact' },
    scope: { type: 'global' },
    tags: ['eval-needle', 'topic:caching'],
    content:
      'caching: the in-memory cache must warm up from cold storage at boot via a deterministic warmup_set call; without this the first 30 seconds of latency are dominated by miss penalties.',
  },
  // J — self-consistency: identical query, identical state, must
  // return identical rank.
  {
    id: 'needle:consistency',
    kind: { type: 'fact' },
    scope: { type: 'global' },
    tags: ['eval-needle', 'topic:consistency'],
    content:
      'Self-consistency probe: this distinctive content is the only memory matching the phrase "kraken-marker-self-consistency-probe-2026". Search runs against it must return rank 1 every time.',
  },
  // M — adversarial: all-stopwords query that the FTS sanitizer
  // will reduce to a single useful token or to empty.
  {
    id: 'needle:stopword-target',
    kind: { type: 'fact' },
    scope: { type: 'global' },
    tags: ['eval-needle', 'topic:adversarial'],
    content:
      'The is a but and or for of in to with from. This memory contains only frequent English stopwords and a single unique anchor: ZUCK1RKARROT. A query of all stopwords should return either nothing or this row.',
  },
  // Pinned-floor: a pinned memory whose lastConfirmedAt is old; the
  // pinned floor should keep it eligible.
  {
    id: 'needle:pinned-old',
    kind: { type: 'fact' },
    scope: { type: 'global' },
    tags: ['eval-needle', 'topic:pinned'],
    content:
      'Pinned forever fact: the harness will backdate this row by 365 days but pin it; effectiveConfidence should be floored at decay.pinnedFloor.',
    pinned: true,
    backdateDays: 365,
  },
  // Forgotten — must not surface in default search.
  {
    id: 'needle:forgotten',
    kind: { type: 'fact' },
    scope: { type: 'global' },
    tags: ['eval-needle', 'topic:lifecycle', 'eval-forgotten'],
    content:
      'Forgotten-row probe: distinctive marker quartz-marker-forgotten-row-2026. Search must NOT return this row by default; it should appear only when includeStatuses=[forgotten].',
    forceForgotten: true,
  },
];

const LABELED_QUERIES = [
  // From dogfooding B (paraphrase robustness)
  {
    id: 'B1-exact',
    text: 'brute-force vector backend rescans every embedding row',
    relevant: ['needle:ann-fact'],
    axis: 'paraphrase-exact',
  },
  {
    id: 'B2-paraphrase',
    text: 'does memento have an ANN index for vectors',
    relevant: ['needle:ann-fact'],
    axis: 'paraphrase-near',
  },
  {
    id: 'B3-implied',
    text: 'why is search slow when corpus gets large',
    relevant: ['needle:ann-fact'],
    axis: 'paraphrase-implied',
  },
  // From dogfooding C (supersession-bleed)
  {
    id: 'C-current-pref',
    text: 'what does the user prefer for ad-hoc statistics scripts',
    relevant: ['needle:stats-r'],
    mustNotInclude: ['needle:stats-python-old'],
    axis: 'supersession-bleed',
  },
  // From dogfooding D (temporal)
  {
    id: 'D-temporal',
    text: 'what did the team decide last week about ranker strategy',
    relevant: ['needle:retrieval-decision'],
    axis: 'temporal',
    // We do not currently expect this to work — flag so report
    // can call it out as an expected failure rather than a regression.
    expectedFailure: true,
  },
  // From dogfooding E (cross-scope)
  {
    id: 'E-cross-scope',
    text: 'session-local harness write',
    relevant: ['needle:session-fact'],
    axis: 'cross-scope',
  },
  // From dogfooding diversity (N)
  {
    id: 'N-diversity',
    text: 'caching eviction policy and warmup behaviour',
    // All 5 are technically relevant; the "diversity" question is
    // whether the *distinct* one appears in the top-K alongside
    // some of the duplicates, OR whether the top-K saturates with
    // duplicates.
    relevant: [
      'needle:dup-a',
      'needle:dup-b',
      'needle:dup-c',
      'needle:dup-d',
      'needle:distinct-warmup',
    ],
    // Per axis N we treat success as: distinct-warmup appears in
    // top-5 alongside at most 3 duplicates.
    diversityTarget: 'needle:distinct-warmup',
    axis: 'diversity',
  },
  // Self-consistency (J)
  {
    id: 'J-consistency',
    text: 'kraken-marker-self-consistency-probe-2026',
    relevant: ['needle:consistency'],
    axis: 'self-consistency',
  },
  // Adversarial (M)
  {
    id: 'M-stopwords',
    text: 'the is a but and or for of in to with from',
    // FTS sanitizes operators not stopwords; the OR-tokenized
    // query becomes a noisy bag. The unique anchor IS in the
    // content; we expect the row to be returned in some form.
    relevant: ['needle:stopword-target'],
    axis: 'adversarial',
  },
  {
    id: 'M-anchor',
    text: 'ZUCK1RKARROT',
    relevant: ['needle:stopword-target'],
    axis: 'adversarial-anchor',
  },
  // Pinned floor (per decay engine)
  {
    id: 'P-pinned-floor',
    text: 'Pinned forever fact backdated 365 days',
    relevant: ['needle:pinned-old'],
    axis: 'pinned-floor',
  },
  // Forgotten exclusion
  {
    id: 'F-forgotten-default',
    text: 'quartz-marker-forgotten-row-2026',
    // Default search MUST NOT return the forgotten row.
    relevant: [],
    mustNotInclude: ['needle:forgotten'],
    axis: 'forgotten-default',
  },
  {
    id: 'F-forgotten-explicit',
    text: 'quartz-marker-forgotten-row-2026',
    relevant: ['needle:forgotten'],
    includeStatuses: ['active', 'forgotten'],
    axis: 'forgotten-explicit',
  },
];

// ----- Synthetic haystack -----
//
// Filler memories to bring the corpus up to target N. Distinctive
// enough not to accidentally match planted needle queries. The PRNG
// is seeded so the corpus is reproducible across runs.

const HAYSTACK_TOPICS = [
  'logging',
  'metrics',
  'alerting',
  'deploy',
  'rollback',
  'migration',
  'feature-flag',
  'config-drift',
  'incident',
  'postmortem',
  'design-review',
  'refactor',
  'tech-debt',
  'security-audit',
  'compliance',
  'ux-research',
  'a11y',
  'i18n',
  'perf-budget',
  'load-test',
];

let prng = 0xc0ffee;
const rand = () => {
  prng = (prng * 1103515245 + 12345) & 0x7fffffff;
  return prng / 0x7fffffff;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

function genHaystack(i) {
  const topic = pick(HAYSTACK_TOPICS);
  const verb = pick([
    'adopted',
    'rolled back',
    'deferred',
    'spiked on',
    'documented',
    'retired',
    'evaluated',
  ]);
  // Vary kinds across all 5 so retrieval policies that handle one
  // kind well aren't masked by haystack monoculture.
  const kinds = [
    { type: 'fact' },
    { type: 'preference' },
    { type: 'decision', rationale: 'team alignment + ops simplicity' },
    { type: 'todo', due: null },
    { type: 'snippet', language: 'typescript' },
  ];
  const kind = kinds[i % kinds.length];
  // Mix scopes: 70% global, 20% repo, 10% workspace.
  const r = rand();
  let scope;
  if (r < 0.7) scope = { type: 'global' };
  else if (r < 0.9) scope = { type: 'repo', remote: `github.com/eval/haystack-repo-${i % 17}` };
  else scope = { type: 'workspace', path: `/eval/ws/proj-${i % 11}` };
  return {
    scope,
    owner: { type: 'local', id: 'self' },
    kind,
    tags: [`bucket-${i % 100}`, 'eval-haystack'],
    pinned: false,
    content: `Haystack #${i} (${topic}): we ${verb} the ${topic} approach for project ${
      i % 50
    } in 2025; rationale captured here is generic filler designed to be lexically distinct from planted needles. Discriminator token: HSTK${i.toString(36)}.`,
    summary: null,
    storedConfidence: 0.8 + rand() * 0.2,
  };
}

// ----- Seed / setup -----

async function seedCorpus(app, n) {
  // Step 1: write the planted needles (vector OFF for now — we
  // backdate timestamps and superpose embeddings as a second pass).
  const idMap = new Map();
  for (const def of NEEDLE_DEFS) {
    const out = await exec(app, 'memory.write', {
      scope: def.scope,
      owner: { type: 'local', id: 'self' },
      kind: def.kind,
      tags: def.tags,
      pinned: def.pinned ?? false,
      content: def.content,
      summary: def.summary ?? null,
      storedConfidence: 1,
    });
    idMap.set(def.id, out.id);
  }

  // Step 2: handle the supersession (needle:stats-python-old)
  for (const def of NEEDLE_DEFS) {
    if (!def.forceSuperseded) continue;
    const oldId = idMap.get(def.id);
    const newId = idMap.get(def.forceSuperseded);
    if (oldId === undefined || newId === undefined) continue;
    // We wrote stats-r as a separate active memory; reroute it
    // through supersede() so the audit chain reflects the user
    // statement. Easiest path: forget the standalone new memory,
    // then supersede the old with a fresh new payload identical
    // to the def.
    const newDef = NEEDLE_DEFS.find((d) => d.id === def.forceSuperseded);
    await exec(app, 'memory.forget', {
      id: newId,
      reason: 'harness restage',
      confirm: true,
    });
    const sr = await exec(app, 'memory.supersede', {
      oldId,
      next: {
        scope: newDef.scope,
        owner: { type: 'local', id: 'self' },
        kind: newDef.kind,
        tags: newDef.tags,
        pinned: false,
        content: newDef.content,
        summary: newDef.summary ?? null,
        storedConfidence: 1,
      },
    });
    // Rewire the idMap so downstream queries can find the new
    // active head.
    idMap.set(def.forceSuperseded, sr.current.id);
  }

  // Step 3: forget the forgotten needle.
  for (const def of NEEDLE_DEFS) {
    if (!def.forceForgotten) continue;
    const id = idMap.get(def.id);
    await exec(app, 'memory.forget', {
      id,
      reason: 'harness probe — forgotten by design',
      confirm: true,
    });
  }

  // Step 4: backdate createdAt + lastConfirmedAt on flagged
  // needles via raw SQL. The repository write path stamps these
  // from `Date.now()` and offers no override, so this is the
  // only way to get a deterministic 12-month temporal spread on
  // the test corpus. Production code untouched.
  for (const def of NEEDLE_DEFS) {
    if (!def.backdateDays) continue;
    const id = idMap.get(def.id);
    if (!id) continue;
    const t = new Date(Date.now() - def.backdateDays * 24 * 3600 * 1000).toISOString();
    await app.db.db
      .updateTable('memories')
      .set({ created_at: t, last_confirmed_at: t })
      .where('id', '=', id)
      .execute();
  }

  // Step 5: write haystack filler in batches via write_many.
  const fillerCount = Math.max(0, n - NEEDLE_DEFS.length);
  const batch = 100;
  let written = 0;
  while (written < fillerCount) {
    const slice = [];
    for (let i = 0; i < batch && written + i < fillerCount; i++) {
      slice.push(genHaystack(written + i));
    }
    await exec(app, 'memory.write_many', { items: slice });
    written += slice.length;
  }

  return { idMap, plantedNeedles: NEEDLE_DEFS.length, haystack: written };
}

async function attachNeedleEmbeddings(app, idMap, embeddingProvider) {
  if (!embeddingProvider || !embeddingProvider.embed) return 0;
  // We embed only the needles; haystack rows score 0 on vector
  // (consistent with a realistic mid-rebuild state) and the FTS
  // arm picks them up where relevant.
  let n = 0;
  for (const def of NEEDLE_DEFS) {
    const id = idMap.get(def.id);
    if (!id) continue;
    // Build the content the way memory.extract would.
    const content = def.content;
    const vec = await embeddingProvider.embed(content);
    try {
      await app.memoryRepository.setEmbedding(
        id,
        {
          model: embeddingProvider.model,
          dimension: embeddingProvider.dimension,
          vector: vec,
        },
        { actor: ACTOR },
      );
      n += 1;
    } catch {
      // forgotten / archived rows reject setEmbedding — fine,
      // they shouldn't have a vector arm anyway.
    }
  }
  return n;
}

// ----- Metrics -----

function dcg(rels) {
  let s = 0;
  for (let i = 0; i < rels.length; i++) {
    s += (2 ** rels[i] - 1) / Math.log2(i + 2);
  }
  return s;
}

function nDCGAtK(rankedIds, relevantSet, k) {
  const top = rankedIds.slice(0, k);
  const gains = top.map((id) => (relevantSet.has(id) ? 1 : 0));
  const idealCount = Math.min(relevantSet.size, k);
  const ideal = Array(idealCount).fill(1);
  while (ideal.length < gains.length) ideal.push(0);
  const dcgVal = dcg(gains);
  const idcgVal = dcg(ideal);
  return idcgVal > 0 ? dcgVal / idcgVal : 0;
}

function recallAtK(rankedIds, relevantSet, k) {
  if (relevantSet.size === 0) return null;
  const top = rankedIds.slice(0, k);
  let hits = 0;
  for (const id of top) if (relevantSet.has(id)) hits += 1;
  return hits / relevantSet.size;
}

function precisionAtK(rankedIds, relevantSet, k) {
  if (k <= 0) return 0;
  const top = rankedIds.slice(0, k);
  let hits = 0;
  for (const id of top) if (relevantSet.has(id)) hits += 1;
  return hits / top.length;
}

function mrr(rankedIds, relevantSet) {
  for (let i = 0; i < rankedIds.length; i++) {
    if (relevantSet.has(rankedIds[i])) return 1 / (i + 1);
  }
  return 0;
}

// ----- Query runner -----

async function runOneQuery(app, idMap, q, _options, sampleN, tokenize) {
  const wantedNeedleIds = new Set((q.relevant ?? []).map((nid) => idMap.get(nid)).filter(Boolean));
  const forbiddenIds = new Set(
    (q.mustNotInclude ?? []).map((nid) => idMap.get(nid)).filter(Boolean),
  );
  const diversityTargetId = q.diversityTarget && idMap.get(q.diversityTarget);

  // Capture results from one canonical run; latency from sampleN.
  let canonical;
  const lats = [];
  let bytesOut = 0;
  let tokensOut = 0;
  for (let s = 0; s < sampleN; s++) {
    const input = {
      text: q.text,
      limit: 10,
      // Harness needs the per-arm breakdown for diagnostics; the
      // production default flipped to 'summary' (PR F), so opt
      // back into 'full' explicitly here.
      projection: 'full',
      ...(q.includeStatuses ? { includeStatuses: q.includeStatuses } : {}),
    };
    const t0 = performance.now();
    const r = await exec(app, 'memory.search', input);
    lats.push(ms(t0));
    if (s === 0) {
      canonical = r;
      const serialized = JSON.stringify(r);
      bytesOut = Buffer.byteLength(serialized, 'utf8');
      if (tokenize) {
        try {
          tokensOut = tokenize(serialized);
        } catch {
          tokensOut = 0;
        }
      }
    }
  }

  const rankedIds = canonical.results.map((x) => x.memory.id);
  const recall1 = recallAtK(rankedIds, wantedNeedleIds, 1);
  const recall5 = recallAtK(rankedIds, wantedNeedleIds, 5);
  const recall10 = recallAtK(rankedIds, wantedNeedleIds, 10);
  const prec1 = precisionAtK(rankedIds, wantedNeedleIds, 1);
  const prec5 = precisionAtK(rankedIds, wantedNeedleIds, 5);
  const prec10 = precisionAtK(rankedIds, wantedNeedleIds, 10);
  const mrrV = mrr(rankedIds, wantedNeedleIds);
  const ndcg10 = nDCGAtK(rankedIds, wantedNeedleIds, 10);
  const forbiddenLeak = [...forbiddenIds].some((id) => rankedIds.includes(id));
  const topRanks = canonical.results.slice(0, 5).map((r) => ({
    id: r.memory.id,
    content: r.memory.content.slice(0, 60),
    score: Number(r.score.toFixed(4)),
    fts: Number(r.breakdown.fts.toFixed(4)),
    vec: Number(r.breakdown.vector.toFixed(4)),
  }));
  const candidateFts = canonical.results.filter((r) => r.breakdown.fts > 0).length;
  const candidateVec = canonical.results.filter((r) => r.breakdown.vector > 0).length;
  let diversityHit = null;
  if (diversityTargetId) {
    diversityHit = canonical.results.slice(0, 5).some((r) => r.memory.id === diversityTargetId);
  }

  return {
    queryId: q.id,
    axis: q.axis,
    expectedFailure: !!q.expectedFailure,
    recall: { 1: recall1, 5: recall5, 10: recall10 },
    precision: { 1: prec1, 5: prec5, 10: prec10 },
    mrr: mrrV,
    ndcg10,
    forbiddenLeak,
    diversityHit,
    latencyMs: stat(lats),
    candidates: { fts: candidateFts, vector: candidateVec },
    topResults: topRanks,
    response: { bytes: bytesOut, tokens: tokensOut },
  };
}

async function runOneContextProbe(app, sampleN, tokenize) {
  const lats = [];
  let canonical;
  let bytesOut = 0;
  let tokensOut = 0;
  for (let s = 0; s < sampleN; s++) {
    const t0 = performance.now();
    const r = await exec(app, 'memory.context', {});
    lats.push(ms(t0));
    if (s === 0) {
      canonical = r;
      const serialized = JSON.stringify(r);
      bytesOut = Buffer.byteLength(serialized, 'utf8');
      if (tokenize) {
        try {
          tokensOut = tokenize(serialized);
        } catch {
          tokensOut = 0;
        }
      }
    }
  }
  return {
    latencyMs: stat(lats),
    resultCount: canonical.results.length,
    response: { bytes: bytesOut, tokens: tokensOut },
    scoreSpread:
      canonical.results.length > 0
        ? canonical.results[0].score - canonical.results[canonical.results.length - 1].score
        : 0,
  };
}

// ----- One full configuration run -----

async function runConfig(opts) {
  const {
    n,
    vectorEnabled,
    embeddingProvider,
    samples,
    tokenize,
    ts,
    strategy,
    ftsWeight,
    vectorWeight,
    rrfK,
    lambda,
    maxDuplicates,
    ftsMinScore,
    vectorMinCosine,
  } = opts;
  const dbPath = `/tmp/memento-eval-${ts}-n${n}-${
    vectorEnabled ? 'vec' : 'fts'
  }${strategy ? `-${strategy}` : ''}.db`;
  const app = await createMementoApp({
    dbPath,
    embeddingProvider: vectorEnabled ? embeddingProvider : undefined,
    configOverrides: {
      'conflict.enabled': false,
      'retrieval.vector.enabled': vectorEnabled,
      ...(strategy ? { 'retrieval.ranker.strategy': strategy } : {}),
      ...(ftsWeight !== undefined ? { 'retrieval.ranker.weights.fts': ftsWeight } : {}),
      ...(vectorWeight !== undefined ? { 'retrieval.ranker.weights.vector': vectorWeight } : {}),
      ...(rrfK !== undefined ? { 'retrieval.ranker.rrf.k': rrfK } : {}),
      ...(lambda !== undefined ? { 'retrieval.diversity.lambda': lambda } : {}),
      ...(maxDuplicates !== undefined
        ? { 'retrieval.diversity.maxDuplicates': maxDuplicates }
        : {}),
      ...(ftsMinScore !== undefined ? { 'retrieval.candidate.ftsMinScore': ftsMinScore } : {}),
      ...(vectorMinCosine !== undefined
        ? { 'retrieval.candidate.vectorMinCosine': vectorMinCosine }
        : {}),
      // Keep the candidate caps at defaults so the report reflects
      // out-of-the-box behaviour. Override here if a probe needs
      // wider candidate sweeps.
    },
  });

  const tSeedStart = performance.now();
  const { idMap, plantedNeedles, haystack } = await seedCorpus(app, n);
  const seedMs = ms(tSeedStart);
  let needlesEmbedded = 0;
  if (vectorEnabled && embeddingProvider && embeddingProvider.embed) {
    needlesEmbedded = await attachNeedleEmbeddings(app, idMap, embeddingProvider);
  }

  // Cold-warmup: run a small set of throwaway queries so caches/
  // model-pages stabilize before measurement.
  for (let i = 0; i < DEFAULTS.warmupQueries; i++) {
    try {
      await exec(app, 'memory.search', { text: `warmup ${i}`, limit: 5 });
    } catch {
      // ignore — warmup is best-effort.
    }
  }

  const queries = [];
  for (const q of LABELED_QUERIES) {
    // Skip vector-only-fragile queries when vector is off.
    queries.push(await runOneQuery(app, idMap, q, opts, samples, tokenize));
  }

  // Cold context-probe (no scopes given — mirrors the dogfooded
  // session-start call shape).
  const contextProbe = await runOneContextProbe(app, samples, tokenize);

  const dbSizeMb = Number((statSync(dbPath).size / 1024 / 1024).toFixed(2));
  app.close();
  return {
    n,
    vectorEnabled,
    plantedNeedles,
    haystack,
    needlesEmbedded,
    seedMs,
    queries,
    contextProbe,
    dbPath,
    dbSizeMb,
  };
}

// ----- Aggregation + report -----

function aggregate(queries) {
  // Aggregate only over queries NOT flagged expectedFailure for
  // headline numbers; the failures are reported separately.
  const measured = queries.filter((q) => !q.expectedFailure);
  const ef = queries.filter((q) => q.expectedFailure);
  const safeAvg = (vals) =>
    vals.length === 0 ? null : Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4));
  const _lats = measured.flatMap((q) => Array.from({ length: q.latencyMs.n }, (_, i) => i));
  // We don't keep raw samples; aggregate p50/p95/p99 are over the
  // per-query p50/p95/p99. Documented as such in the report.
  const p50 = pct(
    measured.map((q) => q.latencyMs.p50).filter((x) => x != null),
    50,
  );
  const p95 = pct(
    measured.map((q) => q.latencyMs.p95).filter((x) => x != null),
    95,
  );
  const p99 = pct(
    measured.map((q) => q.latencyMs.p99).filter((x) => x != null),
    99,
  );
  return {
    queries: measured.length,
    expectedFailures: ef.length,
    recall1: safeAvg(measured.map((q) => q.recall[1]).filter((x) => x != null)),
    recall5: safeAvg(measured.map((q) => q.recall[5]).filter((x) => x != null)),
    recall10: safeAvg(measured.map((q) => q.recall[10]).filter((x) => x != null)),
    mrr: safeAvg(measured.map((q) => q.mrr)),
    ndcg10: safeAvg(measured.map((q) => q.ndcg10)),
    latencyP50: p50,
    latencyP95: p95,
    latencyP99: p99,
    forbiddenLeaks: measured.filter((q) => q.forbiddenLeak).length,
    diversityHits: measured.filter((q) => q.diversityHit === true).length,
    diversityProbes: measured.filter((q) => q.diversityHit !== null).length,
    avgRespTokens: safeAvg(measured.map((q) => q.response.tokens).filter((x) => x > 0)),
    avgRespBytes: safeAvg(measured.map((q) => q.response.bytes)),
  };
}

function escapeCell(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function fmtPct(x) {
  if (x == null) return 'n/a';
  return `${(x * 100).toFixed(1)}%`;
}

function renderReport(meta, runs) {
  const lines = [];
  lines.push(`# Memento retrieval-quality eval — ${meta.ts}`);
  lines.push('');
  lines.push('> Run with `node scripts/retrieval-eval.mjs`. Not a CI gate (yet).');
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push(`- Memento version (from package): \`${meta.appVersion}\``);
  lines.push(`- Git: \`${meta.git.branch}@${meta.git.sha}${meta.git.dirty ? ' (dirty)' : ''}\``);
  lines.push(`- Node: \`${process.version}\``);
  lines.push(`- Tokenizer: \`${meta.tokenizerName}\``);
  lines.push(`- Embedder available: \`${meta.embedderAvailable}\``);
  lines.push(`- Labeled query count: ${LABELED_QUERIES.length}`);
  lines.push(`- Planted needle memories per run: ${NEEDLE_DEFS.length}`);
  lines.push(`- Samples per query (latency): ${meta.samples}`);
  lines.push('');
  lines.push('## Headline summary');
  lines.push('');
  lines.push(
    '| N | Vector | Recall@1 | Recall@5 | Recall@10 | MRR | nDCG@10 | p50 ms | p95 ms | p99 ms | Forbidden leaks | Diversity hits |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of runs) {
    const a = aggregate(r.queries);
    lines.push(
      `| ${r.n} | ${r.vectorEnabled ? 'on' : 'off'} | ${fmtPct(a.recall1)} | ${fmtPct(a.recall5)} | ${fmtPct(a.recall10)} | ${(a.mrr ?? 0).toFixed(3)} | ${(a.ndcg10 ?? 0).toFixed(3)} | ${a.latencyP50 ?? 'n/a'} | ${a.latencyP95 ?? 'n/a'} | ${a.latencyP99 ?? 'n/a'} | ${a.forbiddenLeaks}/${a.queries} | ${a.diversityHits}/${a.diversityProbes} |`,
    );
  }
  lines.push('');
  lines.push('## Per-axis recall by configuration');
  lines.push('');
  // Group rows by axis × config.
  const axes = [...new Set(LABELED_QUERIES.map((q) => q.axis))];
  lines.push(
    `| Axis | ${runs.map((r) => `N=${r.n}/${r.vectorEnabled ? 'vec' : 'fts'} R@5`).join(' | ')} |`,
  );
  lines.push(`| --- | ${runs.map(() => '---').join(' | ')} |`);
  for (const axis of axes) {
    const cells = runs.map((r) => {
      const qq = r.queries.filter((x) => x.axis === axis);
      if (qq.length === 0) return 'n/a';
      const r5 = qq.map((q) => q.recall[5]).filter((x) => x != null);
      const avg = r5.length > 0 ? r5.reduce((a, b) => a + b, 0) / r5.length : null;
      return fmtPct(avg);
    });
    lines.push(`| ${axis} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Latency, by query (ms)');
  lines.push('');
  for (const r of runs) {
    lines.push(`### N=${r.n}, vector=${r.vectorEnabled ? 'on' : 'off'}`);
    lines.push('');
    lines.push(
      `Seed time: ${r.seedMs} ms · Planted needles: ${r.plantedNeedles} · Haystack: ${r.haystack} · DB size: ${r.dbSizeMb} MB · Needles with embeddings: ${r.needlesEmbedded}`,
    );
    lines.push('');
    lines.push(
      `Cold \`memory.context\` (no args): p50=${r.contextProbe.latencyMs.p50} ms · ${r.contextProbe.resultCount} results · ${r.contextProbe.response.bytes} bytes · ${r.contextProbe.response.tokens} bge-tokens · score spread ${r.contextProbe.scoreSpread.toFixed(4)}`,
    );
    lines.push('');
    lines.push(
      '| Query | Axis | R@1 | R@5 | R@10 | MRR | nDCG@10 | p50 ms | p95 ms | p99 ms | FTS hits | Vec hits | bytes | tokens | Leak | Diversity |',
    );
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const q of r.queries) {
      const leak = q.forbiddenLeak ? '🚨' : '—';
      const div = q.diversityHit === null ? '—' : q.diversityHit ? 'yes' : '**no**';
      lines.push(
        `| ${escapeCell(q.queryId)}${q.expectedFailure ? ' *(expected-fail)*' : ''} | ${q.axis} | ${fmtPct(q.recall[1])} | ${fmtPct(q.recall[5])} | ${fmtPct(q.recall[10])} | ${q.mrr.toFixed(3)} | ${q.ndcg10.toFixed(3)} | ${q.latencyMs.p50} | ${q.latencyMs.p95} | ${q.latencyMs.p99} | ${q.candidates.fts} | ${q.candidates.vector} | ${q.response.bytes} | ${q.response.tokens || '—'} | ${leak} | ${div} |`,
      );
    }
    lines.push('');
  }
  lines.push('## Selected top-5 traces (canonical run only, vector on if available)');
  lines.push('');
  const tracingRun = runs.find((r) => r.vectorEnabled) ?? runs[0];
  if (tracingRun) {
    for (const q of tracingRun.queries.slice(0, 6)) {
      lines.push(`### \`${q.queryId}\` — ${q.axis}`);
      lines.push('');
      lines.push('| rank | id | fts | vec | score | content (first 60 chars) |');
      lines.push('|---|---|---|---|---|---|');
      q.topResults.forEach((r, i) => {
        lines.push(
          `| ${i + 1} | ${r.id} | ${r.fts} | ${r.vec} | ${r.score} | ${escapeCell(r.content)} |`,
        );
      });
      lines.push('');
    }
  }
  lines.push('## Caveats & methodology');
  lines.push('');
  lines.push(
    '- Recall is computed against a planted needle set, not against the full corpus. The harness controls the seed; any haystack memory whose content happens to match a query is not counted against precision.',
  );
  lines.push(
    '- Latency numbers exclude embedder cold-start; the embedder is warmed during `loadEmbedder()` before any timed query.',
  );
  lines.push(
    '- Token counts are produced by the bge-base-en-v1.5 WordPiece tokenizer (the tokenizer the embedder uses). They are NOT cl100k/GPT4 tokens; expect ±10% drift if you remap to an LLM tokenizer.',
  );
  lines.push(
    '- Headline `p95` per run is the 95th percentile *of per-query p95s*, not of the underlying samples. Per-query latency tables are the canonical numbers.',
  );
  lines.push(
    '- `Forbidden leaks` count queries whose `mustNotInclude` set intersected the top-K. This is the supersession-bleed metric.',
  );
  lines.push(
    '- `Diversity hits` count queries with a `diversityTarget` whose target appeared in top-5. Currently exactly one such probe (N-diversity) per run.',
  );
  lines.push(
    '- `Expected failures` (currently the temporal axis) are EXCLUDED from headline aggregates so a 0% recall on a known-broken capability does not skew the summary. They are still reported in the per-query table flagged `*(expected-fail)*`.',
  );
  lines.push('');
  lines.push('## Reproducibility');
  lines.push('');
  lines.push('```');
  lines.push(
    `node scripts/retrieval-eval.mjs --n=${runs
      .map((r) => r.n)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(',')} --samples=${meta.samples}`,
  );
  lines.push('```');
  return lines.join('\n');
}

// ----- main -----

(async () => {
  const args = parseArgs();

  // Progress output goes to stderr (per the biome `noConsole`
  // policy that allows `error`/`warn` but not `log`). stdout is
  // reserved for any future structured output mode.
  console.error(
    `[eval] sweeps n=${args.ns.join(',')} samples=${args.samples} vector=${
      args.skipVector ? 'off-only' : 'both'
    }`,
  );

  const tokenize = await loadTokenizer(args.skipTokenizer);
  const tokenizerName = tokenize ? 'bge-base-en-v1.5 (WordPiece, local)' : 'disabled';

  const embedderResult = await loadEmbedder();
  const embedder = embedderResult.error ? null : embedderResult;
  console.error(
    embedder
      ? '[eval] embedder ok (bge-base-en-v1.5)'
      : `[eval] embedder unavailable: ${embedderResult.error}`,
  );

  const runs = [];
  for (const n of args.ns) {
    for (const vectorEnabled of args.skipVector ? [false] : [false, true]) {
      if (vectorEnabled && !embedder) {
        console.error(`[eval] skipping n=${n} vector=on (no embedder)`);
        continue;
      }
      console.error(`[eval] running n=${n} vector=${vectorEnabled ? 'on' : 'off'}`);
      const t0 = performance.now();
      const r = await runConfig({
        n,
        vectorEnabled,
        embeddingProvider: embedder,
        samples: args.samples,
        tokenize,
        ts: args.ts,
        ...(args.strategy ? { strategy: args.strategy } : {}),
        ...(args.ftsWeight !== undefined ? { ftsWeight: args.ftsWeight } : {}),
        ...(args.vectorWeight !== undefined ? { vectorWeight: args.vectorWeight } : {}),
        ...(args.rrfK !== undefined ? { rrfK: args.rrfK } : {}),
        ...(args.lambda !== undefined ? { lambda: args.lambda } : {}),
        ...(args.maxDuplicates !== undefined ? { maxDuplicates: args.maxDuplicates } : {}),
        ...(args.ftsMinScore !== undefined ? { ftsMinScore: args.ftsMinScore } : {}),
        ...(args.vectorMinCosine !== undefined ? { vectorMinCosine: args.vectorMinCosine } : {}),
      });
      console.error(`[eval]  done in ${ms(t0)} ms, db=${r.dbPath} size=${r.dbSizeMb} MB`);
      runs.push(r);
    }
  }

  const meta = {
    ts: args.ts,
    samples: args.samples,
    tokenizerName,
    embedderAvailable: !!embedder,
    git: gitInfo(),
    appVersion: (() => {
      try {
        const p = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/cli/package.json');
        return JSON.parse(readFileSync(p, 'utf8')).version;
      } catch {
        return 'unknown';
      }
    })(),
  };
  const report = renderReport(meta, runs);
  await writeFile(args.outPath, report, 'utf8');
  console.error(`[eval] wrote ${args.outPath} (${report.length} bytes)`);
})().catch((e) => {
  console.error('[eval] fatal:', e);
  process.exit(1);
});
