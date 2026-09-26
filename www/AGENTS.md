# Website guidance

Follow the repository-wide guidance in `../AGENTS.md`. See `README.md` for
setup and commands.

- Use the App Router, TypeScript, and the existing Tailwind/Fumadocs setup.
  Keep components server-rendered unless browser APIs or interaction require
  a client component.
- Documentation lives in `../docs/` and blog posts in `../blog/`.
  `source.config.ts` defines both collections; `lib/source.ts` is the shared
  loader for routes, navigation, search, and sitemap.
- Blog posts require `title`, `description`, and `authors` frontmatter, plus
  an optional `posted` ISO date. The blog index sorts by `posted` and previews
  each post's content; posts without `posted` are hidden from the site.
- Keep unpublished stubs excluded in `source.config.ts` until their content is
  ready. Do not publish them just to fill out navigation.
- Register shared MDX components in `mdx-components.tsx` and place served assets
  in `public/`.
- A component used by a single docs page belongs next to that page in `../docs`,
  imported by its MDX (`import { Thing } from "./thing"`). This works: the
  sibling `.tsx` sits outside `www/`, but `fumadocs-mdx` preserves the relative
  import and the repository-wide Turbopack root resolves it (verified with a
  probe page). Only reach for `mdx-components.tsx` when several pages need the
  same component. Note `source.config.ts` collects `**/*.{md,mdx}`, so a `.tsx`
  beside a page never becomes a route.
- Use shadcn/ui for reusable UI. `components/ui/` holds registry components
  **unedited**: keep them exactly as `npx shadcn@latest add <name>` writes them
  (imports from `cn`, nova sizes, `data-*` attributes, variant names) so they
  can be regenerated or upgraded. Add one only when something consumes it, and
  review the diff for extra dependencies it wants to introduce.
- Express the design through `app/globals.css` and call sites, never by editing
  a generated component. Reach for a token first; if a control needs different
  geometry (44px header buttons and hero calls to action), pass **layout only**
  as `className` at the call site — size, spacing, flex alignment, display — so
  the override stays visible where it applies. Colors, radius, borders,
  shadows, and typography belong to the component and the tokens.
- Style with the semantic tokens in `app/globals.css`; do not hard-code stone
  values or reintroduce removed tokens. `--muted`, `--accent`, and `--card`
  follow shadcn's meaning (surfaces), so muted *text* is
  `text-muted-foreground`. Two Alife shades sit outside shadcn's set:
  `--surface-hover`, the translucent fill quiet button hovers step up to
  because the dither flattens the generated one-step `bg-muted` hover and an
  opaque fill would hide the grain, and `--surface-active` for the Fumadocs
  dark sidebar rows. The hover adjustment lives in `globals.css` as a rule on
  `[data-slot='button'][data-variant='ghost'|'outline'|'secondary']` —
  `data-variant` is
  shadcn's hook for theme-level changes, so components stay untouched. Other
  hover and pressed styling stays on the components (`hover:bg-primary/80`).
  `--radius` is Alife's 4px corner and the `@theme inline` scale derives every
  smaller step from it; generated components therefore use the site radius, and
  Fumadocs surfaces follow the same scale.
- Keep `components.json` aliases authoritative and preserve the
  `@custom-variant dark` hook.
- Overlays (Sheet, Dialog, …) animate through `tw-animate-css` plus shadcn's
  `data-open`/`data-closed` variants, both wired up in `globals.css`. When a
  new component needs another preset variant (`data-checked`, `data-selected`,
  …), copy that one definition in the same way instead of importing the
  preset's whole `tailwind.css`, which is mostly unused scroll-fade/shimmer
  utilities.
- Theming is next-themes, mounted once in `app/layout.tsx` via
  `components/theme-provider.tsx` (attribute="class", system default,
  `storageKey="alife-theme"`). It owns the `.dark` class and `color-scheme`.
  Use `useTheme` from `next-themes` in components — do not add a second theme
  provider — and keep the docs `RootProvider` theme disabled so only one
  provider writes to `<html>.` `components/mode-toggle.tsx` shows both icons
  and lets `dark:` pick one, which avoids mounted-state hydration guards.
- Keep site metadata centralized in `lib/site.ts` and preserve canonical docs
  URLs when changing routes.
- Keep the repository-wide Turbopack root: the app needs to resolve and watch
  the sibling documentation directory.
- Do not edit generated `.source/`, `.next/`, or `next-env.d.ts` files.
- Run `npm run lint` and `npm run build` after app or MDX changes. Check docs
  navigation, search, and both themes when changing shared UI.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
