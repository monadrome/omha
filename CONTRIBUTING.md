# Contributing

Install Node 20+ and run:

```bash
npm ci --ignore-scripts
npm run check
```

Runtime changes need deterministic fake-provider or local-process tests. Do not
call paid providers in tests. Terminal tests use injected fake backends; the real
probe owns private tmux/cmux resources and must close them. Keep public context
stable and do not persist credentials, raw transcripts or dynamic private worker
output in shared memory.

Keep public APIs in `index.mjs` documented in `docs/contracts.md`. Use the
existing ESM modules and standard Node APIs before adding dependencies. Add
versioned schemas for new JSON inputs and reject unknown fields. Update
`task_plan.md`, `findings.md` and `progress.md` for multi-phase work.

Pull requests should explain the failure or user workflow, list meaningful
validation, and call out platform degradation. Preserve the upstream MIT notices
when changing `skills/butterfly-effect` or `skills/hide`; Omha-specific code
must remain clearly separable from retained upstream text.
