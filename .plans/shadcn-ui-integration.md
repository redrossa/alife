# Plan: adopt shadcn/ui without losing Alife’s identity

## Status

Revised after review: components in `components/ui/` are kept **byte-identical
to the registry output** (verified by re-running `shadcn add --overwrite` and
diffing), the design lives in `app/globals.css` tokens, and theming is
next-themes as shadcn documents it.

Landed in `www/`:

- `components.json` (Radix base, `radix-nova` style, stone base color) and
  `lib/utils.ts`, both as `shadcn init` wrote them.
- Dependencies: `next-themes`, `class-variance-authority`, `cn`, `radix-ui`, and
  an explicit `lucide-react` (previously only transitive). The `shadcn` package
  is not a production dependency — the CLI runs via `npx`, and the generated
  `shadcn/tailwind.css` utilities were not adopted because nothing uses them.
  `tw-animate-css` is deferred until the first animated primitive is added.
- `components/ui/button.tsx`: unedited registry output. Call sites that need
  Alife's 44px geometry pass it as `className`, so the override stays visible at
  the call site and the component stays regenerable.
- `app/globals.css`: shadcn's semantic token set with stone values, `:root` +
  `.dark`, `@theme inline` mappings, a class-based `@custom-variant dark`, and
  Fumadocs `--color-fd-*` aliases pointing at the same tokens.
- `components/theme-provider.tsx` + `components/mode-toggle.tsx`: next-themes
  provider (`attribute="class"`, system default, `storageKey="alife-theme"` so
  existing visitors keep their preference) and a single-button toggle that
  renders both icons and lets CSS pick one. `app/theme-toggle.tsx` is deleted.
- `app/layout.tsx` no longer runs a hand-written inline theme script;
  `app/terrain-background.tsx` and `components/docs/mermaid.tsx` watch the
  `.dark` class instead of the removed `data-theme` attribute and
  `alife-theme-change` event. `components/docs/provider.tsx` still disables
  Fumadocs' own provider so only one writes to `<html>`.
- `www/AGENTS.md` and `www/README.md` document ownership, tokens, dark mode, and
  the generator workflow.

Not yet done: baseline screenshots (the pre-migration build was not captured,
so no pixel comparison exists), visual review in a browser at mobile and short
landscape sizes, and additional primitives — Input, and any overlay beyond the
mobile navigation Sheet — which should be added only when something consumes
them.

Verified: `npm run lint` and `npm run build` pass; `/`, `/docs`, `/docs/welcome`,
`/blog` serve 200; next-themes' pre-hydration script is in the served HTML with
`alife-theme`; both theme token sets resolve in the compiled CSS; `dark:`
variant utilities compile to `.dark`-class selectors; the `radix-ui` import
tree-shakes to Slot only.

## Goal

Use shadcn/ui as the foundation for reusable UI primitives and accessible interactions, while preserving Alife’s stone palette, typography, restrained styling, terrain background, pixel grain, and existing page composition.

This is a component-system migration, not a redesign. shadcn components are owned source code: adapt their defaults to Alife rather than adapting Alife to a stock shadcn theme.

## Current foundation

- The app lives in `www/`: Next.js App Router, TypeScript, React, and Tailwind v4.
- `www/app/globals.css` owns semantic colors, light/dark variants, Fumadocs token mappings, grain effects, and responsive layout rules.
- `www/app/theme-toggle.tsx` and initialization in `www/app/layout.tsx` own theme persistence and synchronization. Preserve this system; do not introduce `next-themes` or another theme provider.
- Shared navigation lives in `www/components/site-header.tsx`, `site-menu.tsx`, and `docs-sidebar-nav.tsx`.
- Fumadocs owns documentation navigation, search, and much of the MDX presentation through `www/mdx-components.tsx`.
- `@/*` already resolves to the `www/` root. There is no need to introduce a Tailwind v3 configuration file.

## Design boundaries

### Preserve

- Existing light and dark palettes, including the black dark-mode background.
- Geist typography, editorial hierarchy, content widths, and responsive composition.
- Terrain rendering, dither textures, logos, and custom diagrams.
- Routes, metadata, search behavior, blog publication rules, and MDX content.
- Fumadocs functionality and its accessible interaction patterns.

### Standardize

- Color semantics and component state tokens.
- Button variants, sizes, icon sizing, focus indicators, disabled states, and touch targets.
- Borders, radii, shadows, spacing conventions, and motion behavior.
- Repeated interactive controls and overlay behavior where appropriate.

### Non-goals

- Replacing Fumadocs with a custom documentation system.
- Installing the entire shadcn catalog or adding unused forms, dashboards, and charts.
- Wrapping every HTML element in a React component.
- Publishing or changing the uncommitted first blog post.

## Architecture

```text
www/
  components.json           # shadcn generator configuration
  lib/utils.ts              # cn(): clsx + tailwind-merge
  components/ui/            # locally owned, themed shadcn primitives
  components/               # Alife compositions and branded components
  app/globals.css           # theme contract and shared global styling
```

Use three layers:

1. **Theme tokens:** one source of truth for colors and visual states.
2. **UI primitives:** buttons, separators, and only the interaction primitives actually needed.
3. **Alife compositions:** header, mobile navigation, blog navigation, and specialized layouts built from those primitives.

Keep server components as the default. Place client boundaries around interactions, not around entire pages. Keep native links for navigation and native buttons for actions; avoid nested interactive elements.

## Implementation phases

### 1. Capture the baseline and inventory

- Inventory repeated styles and controls across the home page, header, mobile menu, docs sidebar, theme toggle, blog index, and post navigation.
- Record screenshots in both themes at desktop and mobile sizes, including a short landscape viewport for the terrain home page.
- Record current hover, active, selected, focus, and disabled treatments; distinguish intentional differences from duplication.
- Run baseline lint/build and record existing failures before changing app code.
- Inventory Fumadocs-provided components and installed primitive dependencies before choosing additions.

**Deliverable:** a small migration checklist with each existing control mapped to a retained composition or a new primitive, plus baseline screenshots.

### 2. Add the shadcn foundation

- Run the current shadcn CLI from `www/`, using its Tailwind v4 and React Server Component support. Inspect its proposed changes rather than accepting a wholesale stylesheet replacement.
- Configure `www/components.json` for TypeScript, CSS variables, `app/globals.css`, `@/components/ui`, and `@/lib/utils`; retain existing aliases.
- Prefer the Radix-backed component option for this migration, subject to checking compatibility with the installed Fumadocs dependencies. Avoid mixing primitive implementations without a concrete need.
- Add `cn()` and dependencies required by the selected generated components. Declare packages imported directly by app code, including icon dependencies, explicitly rather than relying on transitive dependencies.
- Start with Button; add other primitives only when a migration step consumes them.
- Review generated font, radius, animation, reset, and theme changes. Do not accept a stock palette, a new provider, or duplicate global resets.
- Use npm and update `www/package-lock.json` with app dependency changes. Leave the root package and lockfile alone unless their dependencies actually change.

**Deliverable:** one locally owned Button that renders correctly in both themes without changing existing pages.

### 3. Define a compatible token contract

The existing token names cannot be copied into shadcn unchanged:

- Alife’s `--muted` is a **text color**; shadcn’s `--muted` is a **surface color**.
- Alife’s `--accent` is a **high-contrast action color**; shadcn’s `--accent` is generally an **interaction surface**.

Use namespaced Alife source tokens, then expose shadcn semantic aliases and Fumadocs aliases from the same source. Temporarily retain existing variables as compatibility aliases until all consumers are migrated; do not redefine their meaning underneath existing components.

| shadcn role | Alife source / intended appearance |
| --- | --- |
| `background`, `foreground` | Existing page background and body text |
| `primary`, `primary-foreground` | Existing accent and on-accent colors |
| `muted`, `muted-foreground` | Existing surface-hover and muted text colors |
| `secondary`, `secondary-foreground` | Quiet surface and normal text |
| `accent`, `accent-foreground` | Interaction surface and normal text |
| `border`, `input` | Existing rule color, checked for control visibility |
| `card`, `card-foreground` | Explicitly chosen content surface and normal text |
| `popover`, `popover-foreground` | Opaque overlay surface and normal text |
| `ring` | A clearly visible focus color, not automatically the subtle rule color |
| `destructive` and any required foreground | Accessible error/action colors, only when needed |

Implementation details:

- Define aliases through Tailwind v4’s CSS-first theme configuration, including the generated components’ required color and radius utilities.
- Keep explicit light/dark preferences and the existing system-theme fallback consistent. Match dark variants to the existing controller’s selectors; verify first paint and hydration rather than relying only on post-hydration switching.
- Preserve existing hover/active action shades as dedicated tokens or component variants; default shadcn opacity-based states need not replace them.
- Keep Fumadocs `--color-fd-*` mappings aligned with the same source values, including sidebar overrides.
- Choose radius and shadow defaults from the current UI. Do not introduce rounded cards or elevated panels as an incidental generator default.
- Keep grain decorative and away from text/control contrast; overlays should remain readable without relying on the backdrop.
- Audit all old token references before removing compatibility aliases. Verify CSS cascade order after Fumadocs imports and avoid circular variable references.

**Deliverable:** a documented token map and matching light/dark rendering across native, shadcn, and Fumadocs UI.

### 4. Migrate shared controls first

Migrate in small, independently verifiable changes:

| Area | Proposed treatment |
| --- | --- |
| Home-page calls to action | Button styling composed onto links; preserve geometry and terrain layout |
| `site-header.tsx` | Shared control sizing and variants; retain header layout and branding |
| `app/theme-toggle.tsx` | Adopt the icon-button primitive without changing theme state, storage, or initialization behavior |
| `site-menu.tsx` | Standardize trigger and item styling; preserve the current navigation pattern |
| `blog-post-nav.tsx` | Reuse appropriate link/control styling, retaining editorial hierarchy |
| `docs-sidebar-nav.tsx` | Standardize Alife-owned controls without replacing Fumadocs sidebar state management |

Define only useful Button variants, such as primary, outline, ghost, and link, with consistent default/small/icon sizing. Make icon-only controls accessible by name; tooltips are optional help, not a substitute for labels.

For mobile navigation, choose a primitive based on the existing interaction: a disclosure/collapsible for inline expansion, or Sheet/Dialog only if an overlay is deliberately intended. A list of page links should remain navigation, not become an ARIA application menu merely because Dropdown Menu is available.

If an overlay is introduced, verify Escape dismissal, focus return, focus containment where modal, scroll locking, and stacking above the terrain/header/docs shell. Respect reduced-motion preferences.

**Deliverable:** shared controls use consistent primitives with no unintended layout or interaction changes.

### 5. Align documentation and blog presentation

- Retain Fumadocs’ MDX headings, code blocks, tables, callouts, search, and navigation unless a specific gap justifies replacement.
- Use theme mappings to achieve consistency before changing Fumadocs component implementations.
- Register any genuinely useful new MDX component in `www/mdx-components.tsx`; do not replace the registry wholesale.
- Keep `blog-container.tsx` as a layout abstraction, not a stock Card. Preserve the blog’s editorial presentation.
- Review links, separators, focus states, and surface treatments across docs and blog for consistency without flattening their different content roles.

**Deliverable:** a shared visual language across all sections without duplicate docs primitives or changes to content.

### 6. Document ownership and remove duplication

- Update `www/AGENTS.md` with component placement, token rules, client-boundary guidance, and the requirement to inspect generated diffs.
- Add a short contributor section to `www/README.md` explaining how to add a shadcn component from `www/` and verify it against Alife’s theme.
- Treat generated component files as maintained application code; review upstream updates rather than blindly overwriting local adaptations.
- Remove obsolete styles and temporary aliases only after checking their consumers, including MDX and custom diagrams.
- Avoid a public component-gallery route solely for this migration. Use a local development fixture or test harness if visual comparisons need one.

## Verification and acceptance criteria

Run from `www/` after each meaningful migration:

```sh
npm run lint
npm run build
```

Manually check, and automate where the project’s test tooling permits:

- Home, docs, blog index, and a published post or temporary local-only fixture.
- Light, dark, and system preferences; persisted preference on reload; system preference changes; no incorrect-theme flash or hydration warnings.
- Desktop, narrow mobile, and short landscape viewports; no horizontal overflow or terrain composition regressions.
- Keyboard navigation, visible focus, correct link/button semantics, accessible names, and expanded/current states.
- Mobile menu dismissal and focus behavior, and overlay behavior if applicable.
- Docs search, sidebar, table of contents, code blocks, and diagrams.
- Blog navigation and unchanged published/unpublished behavior. Do not publish the draft to create a test page.
- Text and control contrast, reduced motion, and usable touch targets.
- No unnecessary client boundaries, unused primitives, competing providers, or unexpected dependency/bundle growth.

Success means shared controls use a documented, reusable foundation while baseline comparisons still look recognizably like Alife. Any intentional visual differences should be explicitly reviewed, not hidden in generated defaults.

## Suggested delivery sequence

1. `chore(www): configure shadcn component tooling`
2. `refactor(www): unify UI theme tokens`
3. `refactor(www): standardize shared controls`
4. `refactor(www): align docs and blog UI styles`
5. `docs(www): document UI component conventions`

Keep each step buildable and reviewable. Revert a problematic component migration independently rather than reverting the entire foundation. The first blog post remains outside this work.
