import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';

import App from './App.js';

export { FAQ_ITEMS } from './faq.js';
export { HOWTO } from './howto.js';
export { COMPARISON } from './comparison.js';

export function render(): string {
  return renderToString(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
