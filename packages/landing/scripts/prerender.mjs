// Build-time prerender for the landing page.
//
// After `vite build` (client) and `vite build --ssr` (server bundle)
// have produced `dist/` and `dist-ssr/`, this script:
//
//   1. Imports the SSR bundle's `render()` to get the static HTML
//      for `<App />`, then injects it into the `<!--SSR-OUTLET-->`
//      placeholder inside `<div id="root">`.
//   2. Substitutes `__MEMENTO_VERSION__` (from packages/cli's
//      package.json) and `__MEMENTO_LAST_MODIFIED__` (from the
//      most recent git commit touching packages/landing) into the
//      JSON-LD graph.
//   3. Generates a FAQPage JSON-LD block from `FAQ_ITEMS` and
//      replaces the `<!--FAQ-PAGE-JSONLD-->` placeholder.
//   4. Adds `<lastmod>` to `dist/sitemap.xml` using the same
//      git timestamp.
//   5. Removes the SSR build directory.
//
// Why prerender at all: AI crawlers (GPTBot, ClaudeBot,
// PerplexityBot) generally don't execute JavaScript, so a SPA
// shell with an empty `<div id="root">` is invisible to them.
// Prerendering bakes the body content into the static HTML so
// every crawler — JS-rendering or not — gets the same content.

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const landingDir = resolve(here, '..');
const distDir = resolve(landingDir, 'dist');
const ssrDir = resolve(landingDir, 'dist-ssr');
const repoRoot = resolve(landingDir, '../..');

// `await import()` of an absolute path needs a file:// URL on
// Windows, because Node's ESM loader otherwise treats the drive
// letter (e.g. `D:`) as a URL scheme and rejects it.
const ssrEntry = pathToFileURL(resolve(ssrDir, 'entry-server.js')).href;
/** @type {{
 *    render: () => string,
 *    FAQ_ITEMS: ReadonlyArray<{ question: string, answer: string }>,
 *    HOWTO: {
 *      name: string,
 *      description: string,
 *      totalTime: string,
 *      steps: ReadonlyArray<{ name: string, text: string, command?: string }>,
 *    },
 *  }} */
const { render, FAQ_ITEMS, HOWTO } = await import(ssrEntry);

const cliPkg = JSON.parse(readFileSync(resolve(repoRoot, 'packages/cli/package.json'), 'utf8'));
const version = String(cliPkg.version ?? '0.0.0');

let lastModified;
try {
  // Use the most recent commit touching the landing package as the
  // page's `dateModified`. Falls back to "now" only on first commit
  // or in shallow checkouts where git log is empty.
  const out = execSync('git log -1 --format=%cI -- packages/landing', {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  lastModified = out !== '' ? out : new Date().toISOString();
} catch {
  lastModified = new Date().toISOString();
}

const appHtml = render();

const faqPageJsonLd = JSON.stringify(
  {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': 'https://runmemento.com/#faq',
    mainEntity: FAQ_ITEMS.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  },
  null,
  2,
);

// HowTo schema for the install procedure. AI search engines
// surface HowTo content for "how do I install/set up X" queries
// — adding it gives the page a direct answer surface for that
// shape of query without us writing a separate "how to install"
// page. Source data lives in src/howto.ts so the visible
// Quickstart and the schema can't drift.
const howToJsonLd = JSON.stringify(
  {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    '@id': 'https://runmemento.com/#howto-install',
    name: HOWTO.name,
    description: HOWTO.description,
    totalTime: HOWTO.totalTime,
    inLanguage: 'en',
    step: HOWTO.steps.map((s, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: s.name,
      text: s.text,
      url: `https://runmemento.com/#quickstart-step-${i + 1}`,
      ...(s.command !== undefined
        ? {
            tool: {
              '@type': 'HowToTool',
              name: 'Terminal',
            },
          }
        : {}),
    })),
  },
  null,
  2,
);

// Critical-font preload tags. @fontsource ships per-weight CSS
// imports that the browser only fetches when the page first
// references them, which can delay LCP on slow connections.
// Preloading the two latin-400 woff2 files (Inter for body,
// JetBrains Mono for code blocks) gets them in flight while the
// HTML parses. The other weights (500, 600) and the latin-ext
// variants can wait — they're not on the critical render path.
//
// Filenames are content-hashed by Vite, so we discover them by
// scanning dist/assets/ rather than hardcoding. If a future
// fontsource version changes its naming convention, the prefix
// match below needs to be updated; the assertion catches that.
const assetsDir = resolve(distDir, 'assets');
const assetFiles = readdirSync(assetsDir);
function findFont(prefix) {
  const match = assetFiles.find((f) => f.startsWith(prefix) && f.endsWith('.woff2'));
  if (match === undefined) {
    throw new Error(
      `prerender: could not find critical font matching prefix "${prefix}" in ${assetsDir}. Did @fontsource change its naming?`,
    );
  }
  return match;
}
const interLatin400 = findFont('inter-latin-400-normal-');
const jetbrainsLatin400 = findFont('jetbrains-mono-latin-400-normal-');
const fontPreloadTags = [
  `<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/${interLatin400}" />`,
  `<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/${jetbrainsLatin400}" />`,
].join('\n    ');

const indexPath = resolve(distDir, 'index.html');
const template = readFileSync(indexPath, 'utf8');
const html = template
  .replace('<!--SSR-OUTLET-->', appHtml)
  .replaceAll('__MEMENTO_VERSION__', version)
  .replaceAll('__MEMENTO_LAST_MODIFIED__', lastModified)
  // `og:updated_time` is the OpenGraph-equivalent of dateModified.
  // OG-aware unfurlers (LinkedIn, some AI fetchers) re-fetch when
  // it changes, replacing stale cached previews.
  .replaceAll('__MEMENTO_OG_UPDATED_TIME__', lastModified)
  // Visible "Last updated" string in the footer — surfaces freshness
  // to LLMs that read body text directly (not just JSON-LD). Format
  // as a human-readable date next to the lastModified ISO timestamp.
  .replaceAll(
    '__MEMENTO_LAST_UPDATED_HUMAN__',
    new Date(lastModified).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
  )
  .replace(
    '<!--FAQ-PAGE-JSONLD-->',
    `<script type="application/ld+json">\n${faqPageJsonLd}\n    </script>`,
  )
  .replace(
    '<!--HOWTO-JSONLD-->',
    `<script type="application/ld+json">\n${howToJsonLd}\n    </script>`,
  )
  .replace('<!--FONT-PRELOAD-->', fontPreloadTags);
writeFileSync(indexPath, html, 'utf8');

const sitemapPath = resolve(distDir, 'sitemap.xml');
const sitemap = readFileSync(sitemapPath, 'utf8');
if (!sitemap.includes('<lastmod>')) {
  const updated = sitemap.replace(
    '</changefreq>',
    `</changefreq>\n    <lastmod>${lastModified}</lastmod>`,
  );
  writeFileSync(sitemapPath, updated, 'utf8');
}

rmSync(ssrDir, { recursive: true, force: true });

process.stdout.write(
  `prerender: injected ${appHtml.length.toLocaleString()} bytes of SSR HTML, version=${version}, lastModified=${lastModified}\n`,
);
