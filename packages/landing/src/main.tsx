import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';

import App from './App.js';
import './styles.css';

const rootEl = document.getElementById('root');
if (rootEl === null) throw new Error('Missing #root element in index.html');

hydrateRoot(
  rootEl,
  <StrictMode>
    <App />
  </StrictMode>,
);
