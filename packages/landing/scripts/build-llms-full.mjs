// Build-time generator for `llms-full.txt`.
//
// Concatenates the repo-root README.md and ARCHITECTURE.md into a
// single file at `dist/llms-full.txt`, served at
// https://runmemento.com/llms-full.txt for LLM crawlers that follow
// the llmstxt.org convention. Generated at build time so it cannot
// drift from the source docs.
//
// Run as `postbuild` from packages/landing/package.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const distDir = resolve(here, '../dist');

const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
const architecture = readFileSync(resolve(repoRoot, 'ARCHITECTURE.md'), 'utf8');

const header = `# Memento — full content snapshot

> This file is the full README and ARCHITECTURE concatenated into a
> single document for one-shot ingestion by LLM crawlers (per the
> llmstxt.org convention). Generated at build time from the source
> repository at https://github.com/veerps57/memento — always in sync.

The short, link-rich index lives at https://runmemento.com/llms.txt.

---

`;

const body = `${readme}\n\n---\n\n${architecture}\n`;
writeFileSync(resolve(distDir, 'llms-full.txt'), header + body, 'utf8');
