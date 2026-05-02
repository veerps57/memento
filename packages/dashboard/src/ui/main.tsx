// SPA entry. Mounts <App /> into the <div id="root" /> in index.html.
//
// Fonts are imported via `@fontsource/*` (CSS-only packages
// that ship the .woff2 files and `@font-face` rules), so the
// dashboard works offline once installed — no Google Fonts
// CDN request at first paint. We import only the weights the
// theme actually uses (regular + medium for mono, regular +
// semibold for sans) to keep the bundle small.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';

import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error("Dashboard mount point '#root' missing from index.html.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
