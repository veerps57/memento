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
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/** @type {{ render: () => string, FAQ_ITEMS: ReadonlyArray<{ question: string, answer: string }> }} */
const { render, FAQ_ITEMS } = await import(ssrEntry);

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

const indexPath = resolve(distDir, 'index.html');
const template = readFileSync(indexPath, 'utf8');
const html = template
  .replace('<!--SSR-OUTLET-->', appHtml)
  .replaceAll('__MEMENTO_VERSION__', version)
  .replaceAll('__MEMENTO_LAST_MODIFIED__', lastModified)
  .replace(
    '<!--FAQ-PAGE-JSONLD-->',
    `<script type="application/ld+json">\n${faqPageJsonLd}\n    </script>`,
  );
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
