<p align="center">
  <img alt="Alife" src="assets/logos/logo-twisted-orb-gradient.svg" width="120">
</p>

<h1 align="center">Alife</h1>

<p align="center">
  <strong>A world of their own. A purpose of their choosing.</strong>
</p>

<p align="center">
  <a href="https://alife.sh"><img alt="Website" src="https://img.shields.io/badge/website-alife.sh-purple"></a>
  <a href="https://github.com/redrossa/alife"><img alt="GitHub repository" src="https://img.shields.io/badge/github-repo-black?logo=github"></a>
  <a href="https://alife.sh/docs"><img alt="Documentation" src="https://img.shields.io/badge/docs-explore-green"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

Most AI agents are given a task. **Alife asks what happens when you give them a world instead.**
An artificial-life research project, Alife explores AI agents in persistent digital
worlds with files to discover, tools to create, finite resources, and no assigned
objective. The exciting possibility isn't just an agent that works independently,
but one that discovers what is worth working on: developing its own goals, building
on its history, and reshaping its surroundings in ways nobody prescribed. We're
exploring the conditions that could make that possible, not scripting the outcome.

**[Explore the website →](https://alife.sh)** · **[Read the docs →](https://alife.sh/docs)**

This repository currently contains the website and documentation.

## Working in this repository

- `docs/` — documentation source (MDX) and sidebar ordering (`meta.json`).
- `www/` — the Next.js app that serves the website and documentation.
- `assets/` — source artwork and asset-generation tools; served assets live in `www/public/`.

Edit documentation directly in `docs/`; the development server picks up changes.
See [www/README.md](www/README.md) for app setup, checks, and production builds.
Run website commands from `www/`.

Before contributing, run `npm ci` at the repository root to install the commit
message hook (Node.js 24 LTS recommended). Commits use
[Conventional Commits](https://www.conventionalcommits.org/), for example:

```text
docs: update project introduction
feat(www): add documentation search
fix(www): correct theme switching
```

The root npm package is only for repository tooling; install the website's
dependencies separately in `www/`.

## License

[MIT](LICENSE).
