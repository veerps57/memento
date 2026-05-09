#!/usr/bin/env node
// Internal markdown link probe.
//
// Walks every .md file in the workspace, extracts relative-path
// markdown links (i.e. anything that's not http(s):// / mailto: /
// pure #anchor / templated), and verifies each resolves to a file
// that exists on disk.
//
// Why this exists: markdownlint catches formatting drift but not
// path drift. ADR cross-references, package-README links, and the
// Status pointers between ADRs go stale silently — a wrong relative
// path renders fine on GitHub but 404s on click. This probe runs in
// `pnpm verify`, so a stale link fails the PR at the gate.
//
// Marker-comment opt-out:
//
//   <!-- doc-links: resolve-from-repo-root -->
//
// Files carrying this marker have their relative links resolved
// against the repo root rather than the file's own directory. Used
// for distribution artefacts (the `memento-dev` skill, in
// particular) whose links are written assuming Claude Code loads
// them with the user's repo checkout as cwd at skill-load time. The
// in-repo relative-path semantics break for those files; the marker
// declares the convention the file actually uses.
//
// CLI:
//
//   node scripts/check-md-links.mjs           # print drift, exit 1 on any miss
//   node scripts/check-md-links.mjs --json    # JSON output for tooling

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, normalize, resolve as resolvePath } from 'node:path';

const REPO_ROOT = process.cwd();
const MARKER = '<!-- doc-links: resolve-from-repo-root -->';
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const SKIP_PROTOCOL_RE = /^(https?:|mailto:|#|tel:|data:)/;

function listMarkdownFiles() {
  const out = execSync(
    'find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/coverage/*" -not -path "*/.git/*" -not -name "CHANGELOG.md"',
    { encoding: 'utf8' },
  );
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^\.\//, ''));
}

function declaresRepoRootMarker(content) {
  // Marker must be on its own line (modulo surrounding whitespace).
  // This prevents prose mentions of the marker — say, in this
  // very script's docs or in the audit-playbook docs — from
  // accidentally switching a file into repo-root mode.
  for (const line of content.split('\n')) {
    if (line.trim() === MARKER) return true;
  }
  return false;
}

// Replace fenced code blocks (```...```) and single-backtick code
// spans (`...`) with spaces of equal length. Markdown rendering
// treats `[X](Y)` inside backticks as literal text, not as a link;
// so this probe must skip those occurrences. Replacing with spaces
// (rather than dropping the bytes) keeps subsequent character
// indices valid for the line-number computation that drives the
// human-readable output.
function maskCodeSpans(content) {
  const masked = [...content];
  const FENCE_RE = /```[\s\S]*?```/g;
  for (let m = FENCE_RE.exec(content); m !== null; m = FENCE_RE.exec(content)) {
    for (let i = m.index; i < m.index + m[0].length; i++) {
      if (masked[i] !== '\n') masked[i] = ' ';
    }
  }
  const SPAN_RE = /`[^`\n]*`/g;
  for (let m = SPAN_RE.exec(content); m !== null; m = SPAN_RE.exec(content)) {
    for (let i = m.index; i < m.index + m[0].length; i++) {
      if (masked[i] !== '\n') masked[i] = ' ';
    }
  }
  return masked.join('');
}

async function probeFile(file) {
  const raw = await readFile(resolvePath(REPO_ROOT, file), 'utf8');
  const content = maskCodeSpans(raw);
  const resolveFromRepoRoot = declaresRepoRootMarker(raw);
  const baseDir = resolveFromRepoRoot ? REPO_ROOT : dirname(resolvePath(REPO_ROOT, file));
  const broken = [];
  // Reset regex state between files (g-flag is shared).
  LINK_RE.lastIndex = 0;
  for (let match = LINK_RE.exec(content); match !== null; match = LINK_RE.exec(content)) {
    const url = match[2].trim();
    if (SKIP_PROTOCOL_RE.test(url)) continue;
    if (url.startsWith('<') || url.includes('${')) continue;
    const [pathPart] = url.split('#');
    if (!pathPart) continue;
    const target = normalize(resolvePath(baseDir, pathPart));
    if (!existsSync(target)) {
      broken.push({
        source: file,
        url,
        line: content.slice(0, match.index).split('\n').length,
      });
    }
  }
  return broken;
}

async function main() {
  const flags = process.argv.slice(2);
  const json = flags.includes('--json');

  const files = listMarkdownFiles();
  const broken = [];
  for (const file of files) {
    broken.push(...(await probeFile(file)));
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ filesScanned: files.length, broken }, null, 2)}\n`);
    if (broken.length > 0) process.exit(1);
    return;
  }

  if (broken.length === 0) {
    process.stdout.write(
      `docs:links: OK — ${files.length} files scanned, no broken internal links.\n`,
    );
    return;
  }

  process.stderr.write(`docs:links: BROKEN — ${broken.length} broken internal link(s)\n\n`);
  for (const b of broken) {
    process.stderr.write(`  ${b.source}:${b.line} → ${b.url}\n`);
  }
  process.stderr.write(
    `\nIf a flagged file is meant to load with the user's repo as cwd (e.g. a packaged skill), add this marker near the top of the file:\n  ${MARKER}\n`,
  );
  process.exit(1);
}

await main();
