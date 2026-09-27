# Continuous integration

`workflows/ci.yml` runs on pull requests, pushes to `main`, and manual dispatch.
It needs no repository secrets and grants only `contents: read`. Checkout does
not retain Git credentials. It never runs paid model calls or privileged Docker
tests.

## Checks

- **Runtime offline** (Node 24.14.0): clean npm install, frozen acceptance hash
  verification, typecheck, lint, full unit suite, build, compiled fake-config
  validation, and packing measurement.
- **Website** (Node 24.14.0): clean npm install, lint, and production build.
- **Required checks**: always reports; fails if change detection or any selected
  check fails or is cancelled.

Change selection runs runtime checks for `runtime/` and `.plans/`, and website
checks for `www/` and the sibling `docs/` content. Shared tooling and `.github/`
changes run both. Unrelated changes still produce the final check without
rebuilding either package. Deleted/renamed paths participate in selection.
Manual dispatch and an initial push run both packages.

There are deliberately no workflow-level path filters: GitHub can leave a
required check pending forever when an entire workflow is filtered out.

## Repository setup after the first push

Open a pull request and wait for its first workflow run. Then require the
**Required checks** job from the **CI** workflow in the default branch's
ruleset/branch-protection settings. Require review before merging if desired.
Do not require the individually conditional Runtime/Website jobs instead.

Workflow files do not configure repository rulesets themselves. No remote
branch protection, secrets, or deployment settings are changed by this setup.

The runtime's offline milestone is verified; real API compatibility and the
fresh-world smoke remain pending. A green CI run is not live-model validation.
Record the exact merged commit in the eventual live evidence.

## Local CI-helper checks

```sh
python3 -m unittest discover -s .github/scripts -p 'test_*.py'
python3 .github/scripts/verify_acceptance.py
```

Acceptance hashes are compared with the tracked handoff manifest. That catches
accidental test changes; edits to the manifest and workflow still need review.
Private `/tmp` evidence logs are not needed by CI and are not uploaded.
