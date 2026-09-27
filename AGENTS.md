# Repository guidance

## Scope and sources of truth

- `docs/` owns project concepts, architecture, and other published documentation.
- `www/` is the Next.js website and documentation app; read `www/AGENTS.md`
  before changing it.
- `runtime/` is the experiment runtime, an independent Node.js package; read
  `runtime/AGENTS.md` before changing it.
- `assets/` contains source artwork and generators. Only `www/public/` assets
  are served by the website.
- Keep the root `README.md` welcoming: branding, a concise project pitch, and
  human onboarding. Keep `www/README.md` focused on developing and running the
  app. Detailed project concepts belong in `docs/`, not the READMEs.

## Development

- Use npm and keep each lockfile in sync with its package. The root package
  provides Git hook tooling; `www/` and `runtime/` are separate packages.
- Run `npm ci` at the repository root to install Husky and commitlint hooks.
  Use Conventional Commits, for example `docs: update introduction` or
  `feat(www): add search`.
- Install app dependencies with `npm ci` from `www/` and preview with
  `npm run dev` from that directory.
- Keep documentation in the root `docs/` directory; do not copy it into `www/`.
- Do not edit or commit generated output, dependency directories, or secrets.
- Do not publish placeholder documentation or invent implemented features.

## Verification

For website or MDX changes, run `npm run lint` and `npm run build` from `www/`.
For runtime changes, run `npm run typecheck`, `npm run lint`, and `npm test`
from `runtime/`.
For UI changes, also check affected pages, mobile layout, and both color themes.
Report checks that could not be completed rather than claiming they passed.
