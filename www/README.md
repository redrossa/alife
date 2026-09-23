# Alife website

The [Alife website](https://alife.sh) and documentation, built with Next.js App
Router, React, TypeScript, Tailwind CSS, and Fumadocs.

## Get started

Use [Node.js](https://nodejs.org/) 24 LTS (recommended) and npm. Keep the full
repository checkout: this app reads documentation from the sibling `../docs/`
directory.

From the repository root:

```bash
cd www
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). Documentation is at
[localhost:3000/docs](http://localhost:3000/docs). Edits to app code and MDX
content reload during development.

`npm ci` runs `postinstall` to generate Fumadocs files in `.source/`. No API keys
or environment variables are needed for local development.

## Commands

Run these from `www/`:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run lint` | Run ESLint |
| `npm run build` | Create a production build and check TypeScript |
| `npm run start` | Serve an existing production build |
| `npm run postinstall` | Regenerate Fumadocs source files if needed |

## Where to make changes

- `app/page.tsx` — homepage.
- `app/layout.tsx`, `app/globals.css` — shared layout and styles.
- `app/docs/` — documentation layouts and page routes.
- `app/api/search/route.ts` — documentation search.
- `components/` — shared UI and documentation components.
  `docs-sidebar-nav.tsx` is the mobile docs navigation (Docs, GitHub, theme)
  shown in the Fumadocs sidebar drawer below `md`, where the standalone site
  header is hidden and the Fumadocs header becomes the only top bar.
- `lib/site.ts` — site URL and shared metadata.
- `source.config.ts` — Fumadocs collection and MDX configuration.
- `mdx-components.tsx` — components available in MDX.
- `public/` — files served at the site root.

## Editing documentation

Edit MDX in `../docs/`, not in a second copy inside this app. Project concepts
and architecture belong there, rather than in either README.

Each page starts with frontmatter:

```mdx
---
title: Page title
description: A short summary of the page.
updated: 2026-09-23
---

## First section

Page content.
```

- `updated` is an optional ISO date (`YYYY-MM-DD`) rendered as "Updated on
  <date>" under the page description. Set it whenever a page's content changes;
  `source.config.ts` extends the Fumadocs page schema with the field.
- `docs/(introduction)/welcome.mdx` maps to `/docs/welcome`;
  `/docs` redirects there. The `(introduction)` parentheses mark a Fumadocs
  route group: the folder groups the sidebar and holds `meta.json`, but the
  name is left out of the URL slugs. Use groups the same way when adding
  folders whose label should not appear in the URL.
- `meta.json` files control sidebar labels and ordering.
- Headings generate the table of contents; the page title comes from frontmatter.
- Register reusable MDX components in `mdx-components.tsx`. Mermaid code fences
  are supported.
- Put served images in `public/` and reference them by URL, such as
  `/images/docs/diagram.png`. Repository-root `assets/` is not served directly.
- `configuration.mdx` and `experiments.mdx` are unpublished stubs excluded in
  `source.config.ts`. Remove an exclusion and update sidebar ordering when a
  page is ready to publish.

Do not edit or commit generated `.source/`, `.next/`, or `next-env.d.ts` files.

## Production

From `www/`:

```bash
npm ci
npm run lint
npm run build
npm run start
```

Deployment must include **both `www/` and `docs/`**, even when the hosting
provider's project directory is `www/`. Keep the repository as the build
context and allow access to files outside the app directory.

The canonical site URL defaults to `https://alife.sh`. To build for another
origin, set `NEXT_PUBLIC_SITE_URL` (for example, in `www/.env.local` or your
hosting environment) **before building**.

Search engines can verify the site either with a DNS TXT record (no build
change) or with a meta tag: set `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` or
`NEXT_PUBLIC_BING_SITE_VERIFICATION` to the provider's token in the hosting
environment and rebuild. The sitemap is at `/sitemap.xml` and robots rules at
`/robots.txt`; submit the sitemap in Search Console once the property is
verified. New or updated URLs can also be pushed to Bing and Yandex with
IndexNow, using the key file under `public/indexnow/`.

The build uses `next/font` to download Google fonts, so it needs network access.

## License

[MIT](../LICENSE).
