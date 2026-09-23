# Website guidance

Follow the repository-wide guidance in `../AGENTS.md`. See `README.md` for
setup and commands.

- Use the App Router, TypeScript, and the existing Tailwind/Fumadocs setup.
  Keep components server-rendered unless browser APIs or interaction require
  a client component.
- Documentation lives in `../docs/`. `source.config.ts` defines the collection;
  `lib/source.ts` is the shared loader for routes, navigation, search, and sitemap.
- Keep unpublished stubs excluded in `source.config.ts` until their content is
  ready. Do not publish them just to fill out navigation.
- Register shared MDX components in `mdx-components.tsx` and place served assets
  in `public/`.
- Preserve the existing theme controller in `app/theme-toggle.tsx` and theme
  initialization in `app/layout.tsx`; do not add a competing provider.
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
