import type { Config } from 'tailwindcss';

/**
 * Tailwind theme for the dashboard.
 *
 * Two non-grey colours, total: amber (the "preserved / durable"
 * accent) and a desaturated cyan-teal (the "synaptic / confirm"
 * accent). Status colours are muted versions of the spectrum,
 * never saturated. Background and foreground are warm-toned
 * off-black / off-white pairs — pure black or pure white never
 * appear.
 *
 * The naming uses semantic tokens (`bg`, `fg`, `accent`,
 * `muted`, `border`) rather than literal colour names; light
 * and dark mode resolve through CSS variables defined in
 * `src/ui/styles.css`. This is the shadcn/ui pattern.
 */
const config = {
  darkMode: 'class',
  content: ['./index.html', './src/ui/**/*.{ts,tsx}'],
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
        // Sans for prose, headings, controls.
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Mono for IDs, paths, code, content snippets. JetBrains
        // Mono is the canonical "designed terminal" mono — wide
        // glyphs, distinguishable 0/O and 1/l/I, ligatures off
        // by default (we don't enable them; ligatures fight the
        // "every character means itself" terminal feel).
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        // Slight expansion on UPPERCASE labels gives the
        // terminal feel without literal box-drawing.
        widish: '0.04em',
      },
    },
  },
  plugins: [],
} satisfies Config;

export default config;
