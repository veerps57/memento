import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import App from './App.js';
import './styles.css';

const rootEl = document.getElementById('root');
if (rootEl === null) throw new Error('Missing #root element in index.html');

const tree = (
  <StrictMode>
    <App />
  </StrictMode>
);

// In production builds, `scripts/prerender.mjs` replaces the
// `<!--SSR-OUTLET-->` placeholder in `index.html` with the SSR'd
// React tree, so `#root` contains hydratable HTML. In dev (where
// no prerender step runs), `#root` is empty except for the SSR
// comment — calling `hydrateRoot` against that fires the
// "Expected server HTML to contain a matching <div>..." warning
// and forces a recovery client render. Branching on the presence
// of an actual element child picks the right entry path for both
// modes without a build-time flag.
if (rootEl.firstElementChild !== null) {
  hydrateRoot(rootEl, tree);
} else {
  createRoot(rootEl).render(tree);
}
