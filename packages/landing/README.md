# `@psraghuveer/memento-landing`

The marketing landing page for Memento. Static SPA, deployed to GitHub Pages.

This package is private (`"private": true` in `package.json`) — it is not published to npm. It exists to be built and uploaded as a GitHub Pages artifact via [`.github/workflows/deploy-landing.yml`](../../.github/workflows/deploy-landing.yml).

## Local dev

```bash
pnpm -F @psraghuveer/memento-landing dev   # vite dev server on :5174
```

Or the convenience script from the workspace root:

```bash
pnpm dev:landing
```

## Build

```bash
pnpm -F @psraghuveer/memento-landing build
```

Outputs to `dist/`. Preview with `pnpm -F @psraghuveer/memento-landing preview`.

## Theme

Mirrors `packages/dashboard`'s Tailwind tokens by intent — same CSS variables, same fonts, same accent palette. Editing one without the other will drift. Light/dark toggle persists to `localStorage['memento-theme']`; an inline script in `index.html` applies the saved theme before React mounts so there's no flash.

## Deploy

Push to `main` with changes under `packages/landing/**` triggers `.github/workflows/deploy-landing.yml`, which builds with `VITE_BASE_PATH=/memento/` and publishes to GitHub Pages. First-time setup: in repo Settings → Pages, set Source to **GitHub Actions**.

When a custom domain is in place, set `VITE_BASE_PATH=/` in the workflow env (one-line change).

## Static assets

Site assets ship from [`public/`](public/) verbatim — favicons, the OG image, the web app manifest, the schemas mirror, `llms.txt`, and `sitemap.xml`. Drop new files in directly; Vite picks them up at build time. There is currently no screenshots directory; if you need to add inline imagery, prefer co-locating SVG/PNG with the component and importing it as a module so Vite hashes the URL.
