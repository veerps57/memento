#!/usr/bin/env node
// scripts/bench.mjs — Memento ↔ memorybench harness driver.
//
// Drives the public memorybench harness (supermemoryai/memorybench) end
// to end against Memento. Builds Memento, stages the memorybench fork
// containing the Memento provider, sets `MEMENTO_BIN` to the locally
// built CLI, spawns `bun run src/index.ts run -p memento -b <bench>` for
// each requested benchmark, and renders a markdown summary.
//
// Distinct from the other two harness scripts:
//
//   - scripts/retrieval-eval.mjs — measures Memento's internal ranker
//     on a small labeled needle set in a fresh in-memory SQLite.
//     "Is the ranker returning the right memories?"
//   - scripts/stress-test.mjs — measures engine throughput / latency
//     at scale. "Is the engine fast, correct, stable at scale?"
//   - scripts/bench.mjs (this file) — measures Memento on public
//     industry datasets (LoCoMo, LongMemEval, ConvoMem) judged by an
//     LLM. "How does Memento answer real long-conversation questions?"
//
// Usage:
//   node scripts/bench.mjs                                       # LoCoMo + LongMemEval, defaults
//   node scripts/bench.mjs --benchmark=locomo --limit=5          # first-5 consecutive questions on LoCoMo
//   node scripts/bench.mjs --sample=3 --sample-type=random       # 3 per category, randomly chosen across conversations
//   node scripts/bench.mjs --judge=gemini-2.5-pro                # cross-family judge (vs default sonnet-4.6)
//   node scripts/bench.mjs --search-limit=30                     # provider top-K (env: MEMENTO_BENCH_SEARCH_LIMIT)
//   node scripts/bench.mjs --concurrency-ingest=1                # serialize ingest (safe against Anthropic rate-limit overloads)
//   node scripts/bench.mjs --memorybench-dir=/path/to/fork       # use a local fork checkout (skip clone)
//   node scripts/bench.mjs --memorybench-ref=<sha|branch>        # pin a specific fork ref
//   node scripts/bench.mjs --out=./bench                         # output directory (default: ./bench)
//   node scripts/bench.mjs --resume=memento-locomo-2026-05-14... # resume a crashed run by its runId
//
// Output: a single markdown file at `<out>/<ts>.md` per invocation (and one
// per benchmark inside that file). The `--memorybench-dir`'s `data/runs/<runId>/`
// holds the per-question JSON reports. Crashed runs print the resume command on
// the way out — run it from the same machine and the orchestrator picks up at
// the failed phase of the failed question, skipping all completed work.
//
// Architectural notes:
//   - NOT part of `pnpm verify`. Needs network, judge API keys, and
//     hours. AGENTS.md is explicit that verify must pass offline.
//   - Every behavioral value is declared in `DEFAULTS` at the top of
//     the file (architectural rule 2 — no hardcoded behavioral
//     constants). Flags / env vars are documented in
//     `docs/guides/benchmark.md`.
//   - Reuses the gitInfo()-style reproducibility footer pattern from
//     scripts/retrieval-eval.mjs so a future reader can diff runs.
//   - Spawns child processes; doesn't import Memento packages directly.
//     The provider lives in the memorybench fork.

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ----- Defaults / config -----

const DEFAULTS = {
  // Upstream memorybench. Pre-merge of the Memento provider, point
  // `--memorybench-dir` at a local checkout of the PR branch. Once
  // the provider is merged into supermemoryai/memorybench:main, the
  // default clone-and-run path just works.
  memorybenchRepo:
    process.env.MEMORYBENCH_REPO ?? 'https://github.com/supermemoryai/memorybench.git',
  memorybenchRef: process.env.MEMORYBENCH_REF ?? 'main',
  // Judge, answering, and distillation model all default to
  // `sonnet-4.6`. Rationale: Memento is LLM-agnostic, but the bulk of
  // MCP-using clients today (Claude Code, Cursor, Claude Desktop) put
  // Claude Sonnet on the conversation side — which is *also* the model
  // doing distillation in real Memento usage (extract_memory is called
  // from the same assistant that's having the chat). Defaulting to
  // sonnet-4.6 produces numbers that reflect what a real Memento user
  // actually gets, not what a Flash-tier sidecar produces. Sonnet 4.6
  // supports temperature=0 (deterministic at the model layer) and is
  // in the fork's MODEL_CONFIGS. Override via `--judge` /
  // `--answering-model` / MEMENTO_DISTILL_MODEL for other families;
  // an independent-family judge (e.g. `gpt-4o`) is the standard
  // robustness check.
  judgeModel: 'sonnet-4.6',
  answeringModel: 'sonnet-4.6',
  // First baseline: LoCoMo + LongMemEval. ConvoMem deferred.
  benchmarks: ['locomo', 'longmemeval'],
  outDir: null, // resolved at runtime to bench-output-<ts>
};

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function parseArgs() {
  const args = new Map();
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) args.set(a.slice(2, eq), a.slice(eq + 1));
    else args.set(a.slice(2), 'true');
  }
  const benchmarkArg = args.get('benchmark');
  const benchmarks = benchmarkArg
    ? benchmarkArg.split(',').map((s) => s.trim())
    : DEFAULTS.benchmarks;
  const limitRaw = args.get('limit');
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive integer (got: ${limitRaw})`);
  }
  const resumeRaw = args.get('resume');
  const resumeRunIds =
    resumeRaw && resumeRaw !== 'true'
      ? resumeRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  // When resuming, the runId encodes the benchmark and the original
  // timestamp; use that as the ts so the rendered summary lands next
  // to the original run's artifacts.
  let tsStr = ts();
  if (resumeRunIds.length > 0) {
    const parsed = parseRunId(resumeRunIds[0]);
    if (parsed?.ts) tsStr = parsed.ts;
  }
  return {
    ts: tsStr,
    benchmarks,
    limit,
    judgeModel: args.get('judge') ?? DEFAULTS.judgeModel,
    answeringModel: args.get('answering-model') ?? DEFAULTS.answeringModel,
    memorybenchDir: args.get('memorybench-dir') ?? process.env.MEMORYBENCH_DIR ?? null,
    memorybenchRepo: args.get('memorybench-repo') ?? DEFAULTS.memorybenchRepo,
    memorybenchRef: args.get('memorybench-ref') ?? DEFAULTS.memorybenchRef,
    // null = resolve against mementoRoot in main() (so a cwd inside the
    // fork doesn't leak the output directory into the fork worktree).
    outDir: args.get('out') ?? null,
    concurrency: parseConcurrencyFlag(args.get('concurrency')),
    concurrencyIngest: parseConcurrencyFlag(args.get('concurrency-ingest')),
    concurrencyIndexing: parseConcurrencyFlag(args.get('concurrency-indexing')),
    concurrencySearch: parseConcurrencyFlag(args.get('concurrency-search')),
    concurrencyAnswer: parseConcurrencyFlag(args.get('concurrency-answer')),
    concurrencyEvaluate: parseConcurrencyFlag(args.get('concurrency-evaluate')),
    searchLimit: args.get('search-limit') ? Number(args.get('search-limit')) : undefined,
    sample: args.get('sample') ? Number(args.get('sample')) : undefined,
    sampleType: args.get('sample-type'),
    resumeRunIds,
  };
}

// runId format: `memento-<bench>-<ts>` where <ts> is the ISO-derived
// timestamp from ts() above (e.g. `memento-locomo-2026-05-14T15-16-29`).
function parseRunId(runId) {
  const m = /^memento-([a-z0-9-]+?)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/.exec(runId);
  if (!m) return null;
  return { benchmark: m[1], ts: m[2] };
}

function parseConcurrencyFlag(raw) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`concurrency flags must be positive integers (got: ${raw})`);
  }
  return n;
}

// ----- Helpers -----

function gitInfo(cwd) {
  const opts = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], cwd };
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
    const sha = execSync('git rev-parse HEAD', opts).trim();
    const shaShort = execSync('git rev-parse --short HEAD', opts).trim();
    const dirty = execSync('git status --porcelain', opts).trim() !== '';
    return { branch, sha, shaShort, dirty };
  } catch {
    return { branch: 'unknown', sha: 'unknown', shaShort: 'unknown', dirty: false };
  }
}

function requireEnv(name, reason) {
  const v = process.env[name];
  if (!v) {
    console.error(`[bench] missing env var ${name}: ${reason}`);
    console.error('[bench] see docs/guides/benchmark.md for the full setup.');
    process.exit(1);
  }
  return v;
}

function judgeFamily(model) {
  if (/^(sonnet|opus|haiku)-/.test(model)) return 'anthropic';
  if (/^gpt-/.test(model)) return 'openai';
  if (/^gemini-/.test(model)) return 'google';
  return 'unknown';
}

function checkApiKey(model, role) {
  const family = judgeFamily(model);
  if (family === 'anthropic')
    requireEnv('ANTHROPIC_API_KEY', `${role} model ${model} is in the Anthropic family`);
  else if (family === 'openai')
    requireEnv('OPENAI_API_KEY', `${role} model ${model} is in the OpenAI family`);
  else if (family === 'google')
    requireEnv('GOOGLE_API_KEY', `${role} model ${model} is in the Google family`);
  else
    console.warn(
      `[bench] warning: unknown ${role} model family for ${model}; not checking API key`,
    );
}

// better-sqlite3 is a native module; loading it against a Node whose
// NODE_MODULE_VERSION differs from the one that built the workspace
// crashes the spawned server with an opaque "MCP error -32000:
// Connection closed". The common trigger is homebrew Node on PATH
// shadowing nvm's Node when running the script from a non-interactive
// shell. We check the same require resolution the server will use,
// so a mismatch fails here with a clear remedy.
function assertNativeAbiMatches(mementoRoot) {
  try {
    const requireFromCore = createRequire(join(mementoRoot, 'packages/core/package.json'));
    requireFromCore('better-sqlite3');
  } catch (e) {
    const firstLine = String(e?.message ?? e).split('\n')[0];
    console.error(
      `[bench] better-sqlite3 failed to load under this Node (${process.version}, modules=${process.versions.modules}, execPath=${process.execPath}):`,
    );
    console.error(`[bench]   ${firstLine}`);
    console.error('[bench] likely cause: the bench is running under a different Node than the one');
    console.error('[bench] that installed the workspace (e.g. homebrew Node on PATH vs nvm).');
    console.error('[bench] fix one of:');
    console.error('[bench]   - invoke with the workspace Node directly, e.g.');
    console.error('[bench]       /Users/<you>/.nvm/versions/node/v22.x/bin/node scripts/bench.mjs');
    console.error('[bench]   - source nvm and re-select, e.g.');
    console.error('[bench]       . "$NVM_DIR/nvm.sh" && nvm use && node scripts/bench.mjs');
    console.error('[bench]   - rebuild against the current Node:  pnpm rebuild better-sqlite3');
    process.exit(1);
  }
}

function spawnAwait(cmd, argv, opts) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, argv, opts);
    child.on('error', rej);
    child.on('close', (code) => {
      if (code === 0) res();
      else rej(new Error(`${cmd} ${argv.join(' ')} exited ${code}`));
    });
  });
}

// Memorybench's orchestrator writes its checkpoint after every phase
// boundary. After a crash, re-invoking with `--resume=<runId>` picks
// up at the failed phase of the failed question, skipping all
// completed work. Print the exact command so the user (or operator
// scanning the log) doesn't have to reconstruct it.
function printResumeHint(runId, opts) {
  const cmd = [process.execPath, 'scripts/bench.mjs', `--resume=${runId}`];
  if (opts.memorybenchDir) cmd.push(`--memorybench-dir=${opts.memorybenchDir}`);
  if (opts.concurrencyIngest) cmd.push(`--concurrency-ingest=${opts.concurrencyIngest}`);
  console.error('');
  console.error('[bench] to resume, run from the Memento repo root:');
  console.error(`[bench]   ${cmd.join(' ')}`);
  console.error('');
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function msFmt(n) {
  if (n === undefined || n === null) return 'n/a';
  return `${Math.round(n)}ms`;
}

// ----- Main -----

async function main() {
  const opts = parseArgs();
  const mementoRoot = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..');

  assertNativeAbiMatches(mementoRoot);

  checkApiKey(opts.judgeModel, 'judge');
  if (opts.answeringModel !== opts.judgeModel) checkApiKey(opts.answeringModel, 'answering');

  console.error('[bench] building Memento packages…');
  execSync(
    'pnpm -F @psraghuveer/memento-schema -F @psraghuveer/memento-core ' +
      '-F @psraghuveer/memento-server -F @psraghuveer/memento ' +
      '-F @psraghuveer/memento-embedder-local build',
    { stdio: 'inherit', cwd: mementoRoot },
  );
  const mementoBin = resolve(mementoRoot, 'packages/cli/dist/cli.js');
  if (!existsSync(mementoBin)) {
    throw new Error(`built CLI not found at ${mementoBin}; build may have failed`);
  }

  // Anchor default `--out` to the Memento repo root, not `process.cwd()`,
  // so callers who `cd` into the fork before running don't get the bench
  // output directory created inside the fork worktree.
  if (opts.outDir === null) {
    opts.outDir = resolve(mementoRoot, 'bench');
  } else {
    opts.outDir = resolve(opts.outDir);
  }

  // Stage memorybench. Either use a local checkout (preferred for
  // development) or clone the fork at the pinned ref into a tmp dir.
  let workdir;
  let workdirOwned = false;
  if (opts.memorybenchDir) {
    workdir = resolve(opts.memorybenchDir);
    if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
      throw new Error(`--memorybench-dir not a directory: ${workdir}`);
    }
    console.error(`[bench] using local memorybench checkout: ${workdir}`);
  } else {
    workdir = mkdtempSync(join(tmpdir(), 'memento-bench-'));
    workdirOwned = true;
    console.error(
      `[bench] cloning ${opts.memorybenchRepo} @ ${opts.memorybenchRef} into ${workdir}…`,
    );
    execSync(
      `git clone --depth 1 --branch ${opts.memorybenchRef} ${opts.memorybenchRepo} ${workdir}`,
      { stdio: 'inherit' },
    );
  }

  // Always ensure deps are installed; bun install is idempotent and
  // bun.lock guarantees stability across runs.
  console.error('[bench] bun install (memorybench)…');
  execSync('bun install', { cwd: workdir, stdio: 'inherit' });

  mkdirSync(opts.outDir, { recursive: true });
  // memorybench's `.gitignore` excludes `/data/`; keep our SQLite
  // files there too so they don't pollute the worktree with
  // untracked WAL artifacts the user has to ignore by hand.
  const dbDir = join(workdir, 'data', 'memento-bench');
  mkdirSync(dbDir, { recursive: true });

  // Build the run list. New invocation: one runId per requested
  // benchmark, derived from the current timestamp. Resume invocation:
  // use the caller-supplied runIds verbatim, derive the benchmark
  // from each.
  const resuming = opts.resumeRunIds.length > 0;
  const targets = resuming
    ? opts.resumeRunIds.map((runId) => {
        const parsed = parseRunId(runId);
        if (!parsed) {
          throw new Error(
            `--resume runId '${runId}' does not match expected shape memento-<bench>-<ts>`,
          );
        }
        return { benchmark: parsed.benchmark, runId };
      })
    : opts.benchmarks.map((bench) => ({
        benchmark: bench,
        runId: `memento-${bench}-${opts.ts}`,
      }));

  const reports = [];
  for (const { benchmark: bench, runId } of targets) {
    const dbPath = join(dbDir, `${runId}.db`);
    if (resuming) {
      const cpPath = join(workdir, 'data', 'runs', runId, 'checkpoint.json');
      if (!existsSync(cpPath)) {
        throw new Error(
          `--resume: no checkpoint for ${runId} at ${cpPath} (was the original run staged against a different --memorybench-dir?)`,
        );
      }
      console.error(`[bench] RESUMING ${bench} (run=${runId})`);
    } else {
      console.error(`[bench] running ${bench} (run=${runId}, db=${dbPath})…`);
    }
    // Log the runId on its own line in a grep-friendly shape so it's
    // recoverable from the bench log if the process dies before
    // memorybench prints the failure summary.
    console.error(`[bench]   runId: ${runId}`);

    const env = {
      ...process.env,
      // Use process.execPath (the exact Node binary running bench.mjs)
      // rather than the literal string 'node', so a `nvm` + `homebrew`
      // PATH cocktail can't pick a Node whose better-sqlite3 ABI
      // doesn't match the build cache.
      MEMENTO_BIN: `${process.execPath} ${mementoBin}`,
      MEMENTO_BENCH_DB: dbPath,
      // The Memento provider uses an LLM for session-level
      // distillation. Default to the answering model so cost / quality
      // are consistent across one run; overridable in the parent env.
      MEMENTO_DISTILL_MODEL: process.env.MEMENTO_DISTILL_MODEL ?? opts.answeringModel,
    };
    if (opts.searchLimit) env.MEMENTO_BENCH_SEARCH_LIMIT = String(opts.searchLimit);
    // Resume mode only needs `-r <runId>`. The checkpoint already
    // carries benchmark, sampling, judge, and answering model; passing
    // them again would either be redundant or (worse) silently
    // disagree with what's stored.
    const argv = resuming
      ? ['run', 'src/index.ts', 'run', '-r', runId]
      : [
          'run',
          'src/index.ts',
          'run',
          '-p',
          'memento',
          '-b',
          bench,
          '-r',
          runId,
          '-j',
          opts.judgeModel,
          '-m',
          opts.answeringModel,
        ];
    if (!resuming && opts.limit) argv.push('-l', String(opts.limit));
    // `-s N` (memorybench's per-category sample size) spreads picks
    // across all categories; pair with `--sample-type=random` to
    // also spread across conversations within each category. Mutually
    // exclusive with `--limit` on the memorybench side — if both are
    // set memorybench prefers `sample`.
    if (!resuming && opts.sample) argv.push('-s', String(opts.sample));
    if (!resuming && opts.sampleType) argv.push('--sample-type', opts.sampleType);
    // Per-phase concurrency passthrough. `--concurrency` sets the
    // default; the per-phase flags override it for that phase. Useful
    // for taming the embedder during ingest on smaller machines.
    if (opts.concurrency) argv.push('--concurrency', String(opts.concurrency));
    if (opts.concurrencyIngest) argv.push('--concurrency-ingest', String(opts.concurrencyIngest));
    if (opts.concurrencyIndexing)
      argv.push('--concurrency-indexing', String(opts.concurrencyIndexing));
    if (opts.concurrencySearch) argv.push('--concurrency-search', String(opts.concurrencySearch));
    if (opts.concurrencyAnswer) argv.push('--concurrency-answer', String(opts.concurrencyAnswer));
    if (opts.concurrencyEvaluate)
      argv.push('--concurrency-evaluate', String(opts.concurrencyEvaluate));

    try {
      await spawnAwait('bun', argv, { cwd: workdir, env, stdio: 'inherit' });
    } catch (err) {
      printResumeHint(runId, opts);
      throw err;
    }

    const reportPath = join(workdir, 'data', 'runs', runId, 'report.json');
    if (!existsSync(reportPath)) {
      printResumeHint(runId, opts);
      throw new Error(`expected report not found at ${reportPath}`);
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    reports.push({ benchmark: bench, runId, report, reportPath, dbPath });
  }

  // Render summary markdown. One file per invocation, named after the
  // wall-clock timestamp; the directory is the user's `--out` (default:
  // `<mementoRoot>/bench/`). Resumed runs land beside the original
  // because parseArgs reused the runId's timestamp.
  const memento = gitInfo(mementoRoot);
  const fork = gitInfo(workdir);
  const summaryPath = join(opts.outDir, `${opts.ts}.md`);
  const summary = renderSummary({
    reports,
    opts,
    memento,
    fork,
    mementoBin,
  });
  await writeFile(summaryPath, summary, 'utf8');

  console.error('[bench] done.');
  console.error(`[bench]   summary: ${summaryPath}`);
  for (const r of reports) {
    console.error(`[bench]   ${r.benchmark}: ${r.reportPath}`);
  }

  if (workdirOwned && process.env.MEMENTO_BENCH_KEEP_WORKDIR !== '1') {
    console.error(`[bench] cleaning up ${workdir} (set MEMENTO_BENCH_KEEP_WORKDIR=1 to keep)`);
    rmSync(workdir, { recursive: true, force: true });
  }
}

function renderSummary({ reports, opts, memento, fork, mementoBin }) {
  const lines = [];
  lines.push('# Memento × memorybench — baseline run');
  lines.push('');
  lines.push(`Run at \`${opts.ts}\`.`);
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| Benchmark | Total | Correct | Accuracy | MemScore | p50 search | p95 search |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of reports) {
    const s = r.report.summary ?? {};
    const lat = r.report.latency?.search ?? {};
    const ms = r.report.memscore ?? 'n/a';
    lines.push(
      `| ${r.benchmark} | ${s.totalQuestions ?? '?'} | ${s.correctCount ?? '?'} | ` +
        `${s.accuracy !== undefined ? pct(s.accuracy) : '?'} | \`${ms}\` | ` +
        `${msFmt(lat.median)} | ${msFmt(lat.p95)} |`,
    );
  }
  lines.push('');
  lines.push('## Per-question-type breakdown');
  lines.push('');
  for (const r of reports) {
    lines.push(`### ${r.benchmark}`);
    lines.push('');
    const byType = r.report.byQuestionType ?? {};
    const types = Object.keys(byType);
    if (types.length === 0) {
      lines.push('*(no per-type stats reported)*');
    } else {
      lines.push('| Type | Total | Correct | Accuracy |');
      lines.push('|---|---|---|---|');
      for (const t of types) {
        const v = byType[t];
        lines.push(
          `| ${t} | ${v.total} | ${v.correct} | ${v.accuracy !== undefined ? pct(v.accuracy) : '?'} |`,
        );
      }
    }
    lines.push('');
  }
  lines.push('## Reproducibility');
  lines.push('');
  lines.push('```');
  lines.push(`memento branch       ${memento.branch}`);
  lines.push(`memento sha          ${memento.shaShort}${memento.dirty ? ' (dirty)' : ''}`);
  lines.push(`memento bin          ${mementoBin}`);
  lines.push(`memorybench branch   ${fork.branch}`);
  lines.push(`memorybench sha      ${fork.shaShort}${fork.dirty ? ' (dirty)' : ''}`);
  lines.push(`memorybench repo     ${opts.memorybenchRepo}`);
  lines.push(`benchmarks           ${opts.benchmarks.join(', ')}`);
  lines.push(`judge model          ${opts.judgeModel}`);
  lines.push(`answering model      ${opts.answeringModel}`);
  if (opts.searchLimit !== undefined) lines.push(`search limit         ${opts.searchLimit}`);
  if (opts.limit !== undefined) lines.push(`limit                ${opts.limit}`);
  if (opts.concurrencyEvaluate !== undefined)
    lines.push(`concurrency-evaluate ${opts.concurrencyEvaluate}`);
  lines.push('```');
  lines.push('');
  lines.push('### Per-run reports');
  lines.push('');
  for (const r of reports) {
    lines.push(`- \`${r.benchmark}\`: ${r.reportPath}`);
  }
  lines.push('');
  return lines.join('\n');
}

main().catch((e) => {
  console.error(`[bench] fatal: ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
