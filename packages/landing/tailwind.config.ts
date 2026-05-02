import type { Config } from 'tailwindcss';

/**
 * Tailwind theme for the landing page.
 *
 * Mirrors `packages/dashboard/tailwind.config.ts` so the marketing
 * page and the in-product dashboard share one visual identity.
 * Tokens resolve through CSS variables in `src/styles.css`; light
 * and dark mode swap the variables, not the class names.
 */
const config = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'accent-fg': 'rgb(var(--accent-fg) / <alpha-value>)',
        synapse: 'rgb(var(--synapse) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        destructive: 'rgb(var(--destructive) / <alpha-value>)',
        conflict: 'rgb(var(--conflict) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        widish: '0.04em',
      },
      maxWidth: {
        prose: '68ch',
      },
    },
  },
  plugins: [],
} satisfies Config;

export default config;
