#!/usr/bin/env node
// Regenerate the rasterized favicon variants from public/favicon.svg.
//
// Output: favicon.ico (32×32), favicon-16x16.png, favicon-32x32.png,
// favicon-48x48.png, favicon-96x96.png, favicon-144x144.png,
// apple-touch-icon.png (180×180), apple-touch-icon-precomposed.png
// (180×180), icon-192.png, icon-512.png — all under public/.
//
// The 48 / 96 / 144 sizes exist for Google's favicon picker, which
// per https://developers.google.com/search/docs/appearance/favicon-in-search
// recommends multiples of 48 pixels. Without these, Google falls
// back to the SVG (sometimes) or the default globe icon (often).
//
// Why a script (and not a build step): icon files change rarely and
// rasterization needs a tool with SVG support. Committing the
// generated artefacts keeps the build pipeline pure-JS / no system
// deps; this script only runs when a maintainer updates the SVG.
//
// Toolchain: macOS `sips`. `sips` is the only rasterizer that ships
// in the macOS base install, and Memento maintainers run macOS. If
// you're regenerating on Linux, install librsvg (`apt install
// librsvg2-bin`) and swap the `sips` calls for `rsvg-convert`, or
// commit the regenerated files from a macOS box.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');
const src = join(publicDir, 'favicon.svg');

if (!existsSync(src)) {
  console.error(`[generate-icons] missing source: ${src}`);
  process.exit(1);
}

if (process.platform !== 'darwin') {
  console.error(
    '[generate-icons] this script uses macOS `sips`. See the file header for the librsvg fallback.',
  );
  process.exit(1);
}

const sips = (args) => execFileSync('sips', args, { stdio: ['ignore', 'ignore', 'inherit'] });

const png = (size, name) =>
  sips([
    '-s',
    'format',
    'png',
    '-z',
    String(size),
    String(size),
    src,
    '--out',
    join(publicDir, name),
  ]);

png(16, 'favicon-16x16.png');
png(32, 'favicon-32x32.png');
png(48, 'favicon-48x48.png');
png(96, 'favicon-96x96.png');
png(144, 'favicon-144x144.png');
png(180, 'apple-touch-icon.png');
png(192, 'icon-192.png');
png(512, 'icon-512.png');
copyFileSync(
  join(publicDir, 'apple-touch-icon.png'),
  join(publicDir, 'apple-touch-icon-precomposed.png'),
);
sips([
  '-s',
  'format',
  'ico',
  join(publicDir, 'favicon-32x32.png'),
  '--out',
  join(publicDir, 'favicon.ico'),
]);

console.log('[generate-icons] done.');
