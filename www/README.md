# Alife website

The [Alife website](https://alife.sh), documentation, and blog, built with
Next.js App Router, React, TypeScript, Tailwind CSS, and Fumadocs.

## Get started

Use [Node.js](https://nodejs.org/) 24 LTS (recommended) and npm. Keep the full
repository checkout: this app reads documentation and blog posts from the
sibling `../docs/` and `../blog/` directories.

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
- `app/blog/` — blog index and post routes; posts are MDX files in `../blog/`.
- `app/api/search/route.ts` — documentation search.
- `components/` — shared UI and documentation components. `components/ui/`
  holds unedited shadcn/ui primitives; the rest are Alife compositions.
  `site-header.tsx` renders the top navigation and `site-menu.tsx` collapses
  it into a full-height Sheet below `md`. `theme-provider.tsx` and
  `mode-toggle.tsx` wrap
  next-themes. `docs-sidebar-nav.tsx` is the mobile docs navigation
  (Home, Docs, Blog, GitHub, theme) shown in the Fumadocs sidebar drawer below
  `md`, where the standalone site header is hidden and the Fumadocs header
  becomes the only top bar.
- `lib/utils.ts` — `cn()`, re-exported from shadcn's `cn` package.
- `components.json` — shadcn/ui generator configuration.
- `lib/site.ts` — site URL and shared metadata.
- `source.config.ts` — Fumadocs collections and MDX configuration.
- `lib/source.ts` — loaders for the docs and blog collections.
- `lib/format.ts` — frontmatter date parsing and formatting.
- `mdx-components.tsx` — components available in MDX.
- `public/` — files served at the site root.

## UI components and theming

The interface is built on [shadcn/ui](https://ui.shadcn.com/). Components in
`components/ui/` are the registry output **unedited**, so they can be
regenerated or updated later; Alife's design is expressed in
`app/globals.css` tokens and at the call sites that use them.

Add a primitive only when something consumes it:

```bash
cd www
npx shadcn@latest add dialog
```

The generator reads `components.json` and `app/globals.css`. Review its diff:
it may want to add a stock palette, an extra provider, or a new dependency.
Overlay components (Sheet, Dialog) animate with `tw-animate-css` and shadcn's
`data-open`/`data-closed` variants; both are already wired up in `globals.css`,
so adding one needs no further CSS setup.

### Theme tokens

`app/globals.css` defines shadcn's semantic token set with Alife's values
(Tailwind's stone palette, pure-black dark background).

| Token group | Meaning |
| --- | --- |
| `background`, `foreground` | Page background and body text |
| `card`, `popover` | Tonal surface and opaque overlay surface |
| `primary`, `primary-foreground` | Accent actions; hover is the component's own `bg-primary/80` |
| `muted`, `secondary`, `accent` | Quiet surfaces (hover, selection) |
| `muted-foreground` | Muted text |
| `border`, `input`, `ring` | Rules, control borders, focus color |
| `surface-hover` | Translucent hover fill for quiet buttons |
| `surface-active` | Stronger surface for the Fumadocs dark sidebar |
| `destructive` | Errors and destructive actions |

`--surface-hover` and `--surface-active` are the additions beyond shadcn's
set. `globals.css` applies the former to `ghost`, `outline`, and `secondary`
button hovers: their generated hovers are a single stone step from the page (or
a 5% foreground tint, on `secondary`) and the dither grain flattens what is
left of them, so they use the next stone step held at 80% opacity — strong
enough to read, translucent enough to keep the grain visible through the
control. The rule targets `[data-slot='button']` by `data-variant`, which keeps
`components/ui/` untouched.

Prefer these over raw Tailwind colors so both themes keep working. Remember
that in shadcn's vocabulary `muted` and `accent` are surfaces: muted text is
`text-muted-foreground`.

`--radius` is Alife's 4px corner, and the `@theme inline` scale derives the
smaller steps from it (`--radius-lg` is `--radius`). Generated components land
on the site radius instead of shadcn's 10px default; because it is a global
scale, Fumadocs' own surfaces follow it too.

When a call site needs different geometry — the 44px header buttons and hero
calls to action — pass **layout only** as `className` (size, spacing, flex
alignment, display) and leave colors, radius, borders, and typography to the
component and the tokens.

### Dark mode

[next-themes](https://github.com/pacocoursey/next-themes) owns theming, mounted
once in `app/layout.tsx` through `components/theme-provider.tsx` with
`attribute="class"`, a system default, and `storageKey="alife-theme"`. It writes
the `.dark` class and `color-scheme` before paint, and every `dark:` utility
keys off that class through the `@custom-variant dark` rule in `globals.css`.
`components/mode-toggle.tsx` is the toggle; use `useTheme` from `next-themes` in
any new component rather than adding another provider. The docs `RootProvider`
keeps its own theme provider disabled so only one writes to `<html>`.

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
- A component only one docs page uses goes next to that page in `../docs` and is
  imported by its MDX (`import { Diagram } from "./diagram"`). Shared components
  are registered in `mdx-components.tsx` instead. Only `.md`/`.mdx` files become
  pages, so a sibling `.tsx` is never routed.
- Put served images in `public/` and reference them by URL, such as
  `/images/docs/diagram.png`. Repository-root `assets/` is not served directly.
- `configuration.mdx` and `experiments.mdx` are unpublished stubs excluded in
  `source.config.ts`. Remove an exclusion and update sidebar ordering when a
  page is ready to publish.

Do not edit or commit generated `.source/`, `.next/`, or `next-env.d.ts` files.

## Writing blog posts

Blog posts are MDX files in `../blog/`, one file per post. For example,
`../blog/hello-world.mdx` maps to `/blog/hello-world`. The blog index at
`/blog` lists published posts newest-first, each with its posted date and
authors, the title, and a two-line preview of the content.

Each post starts with frontmatter:

```mdx
---
title: Post title
description: A one-sentence summary shown on the post page and link cards.
posted: 2026-09-23
authors: [Ada Lovelace, Alan Turing]
---

## First section

Post content.
```

- `title`, `description`, and `authors` are required: a string, a one-line
  summary, and a non-empty list of names shown on the post page.
- `posted` is an optional ISO date (`YYYY-MM-DD`) that orders the index and
  dates the post. Without it, a post stays in the repository but is hidden
  from the site: the index, its route, the sitemap, and adjacent-post links.
- Posts render through the shared MDX components in `mdx-components.tsx`, so
  Mermaid fences and other registered components work as they do in the docs.
- Published posts are included in `/sitemap.xml`.

## Production

From `www/`:

```bash
npm ci
npm run lint
npm run build
npm run start
```

Deployment must include **`www/`, `docs/`, and `blog/`**, even when the hosting
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
IndexNow, using the key file at the site root (`public/<key>.txt`).

The build uses `next/font` to download Google fonts, so it needs network access.

## License

[MIT](../LICENSE).
