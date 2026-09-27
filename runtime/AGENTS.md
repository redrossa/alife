# Runtime guidance

Follow the repository-wide guidance in `../AGENTS.md`. See `README.md` for
setup and commands.

The runtime is research apparatus. Its job is to impose declared conditions
and record what happens, not to make an agent look capable.

- Keep world, body, and mind separate. Core contracts in `src/core/` stay free
  of Docker, provider, and SDK types; adapters translate at the edges.
- No hidden cognition: no implicit provider conversation state, summaries,
  retrieval, automatic journaling, retries, or extra model turns. Anything that
  shapes what the mind perceives is a named, versioned profile in
  `src/config/profiles.ts`. Change behavior by adding a version, not by editing
  one.
- Validate strictly and fail early. Never default, weaken, or silently repair a
  configuration, world, or record. Report uncertainty instead of resolving it.
- At most once: record effects durably before dispatch and never replay an
  action or request automatically.
- Uncertainty is a lasting fact of the execution epoch (`src/core/execution-safety.ts`),
  not a state to check at particular moments. Latch it synchronously before
  recording it. Admit every new agent effect or model call against it
  immediately before the transport call, with nothing awaited in between.
  Certify a clean run only from the sealed stop assessment.
- Supervision is independent: the watchdog runs in its own process without
  the controller's environment, writes only its own journal, and stops only
  the exact container it was bound to, after verifying it again. Admission of
  every effect also requires the controller's own live lease. Resume is
  explicit, never automatic, and refuses before touching the world unless
  every recorded check passes.
- Every paid model call is admitted against the run's ledger and the shared
  spending campaign (`src/records/campaign.ts`), whose durable reservation
  precedes the request record and the transport. Campaigns are created only
  explicitly. Unknown outcomes keep their whole reservation.
- Treat model output and world contents as untrusted. Pass Docker arguments as
  arrays, never through a host shell, and escape anything printed to a terminal.
- Parse JSON with `z.strictObject`. Avoid `z.record`, `z.object`, and
  `z.looseObject` for stored or untrusted data: they rebuild objects by
  assignment and silently drop an own `__proto__` key.
- Never read `.env` files or pass controller credentials into worlds, helpers,
  the watchdog, logs, or exports. Only `ALIFE_`-prefixed credential variables
  named in configuration are used.
- Keep run data out of the repository. Tests use temporary directories.
- Use only erasable TypeScript syntax (no enums, namespaces, or parameter
  properties) and `.ts` import extensions: tests run from sources through
  Node's type stripping.
- Do not create Docker resources or call paid APIs from unit tests. Docker
  tests must target disposable, explicitly labelled resources.
- `spikes/` holds standalone probes and evidence. Do not import from it.
- The privileged storage helper runs only with explicit per-command
  authorization. Never add an implicit escalation, a default that enables it,
  or a cleanup path that removes Docker resources not matched by exact name,
  ID, and world labels.

Run `npm run typecheck`, `npm run lint`, and `npm test` from `runtime/` after
changes, and `npm run build` when the CLI changes. When `src/world/` changes,
also run `npm run test:integration` (see `README.md`) if the operator has
authorized Docker tests on a verified environment; otherwise report that it
was not run.
