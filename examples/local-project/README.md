# Example: local-project

An end-to-end Omakase demo that uses `@omakase/daemon` and `@omakase/core` as a
library. It:

1. **Detects** local agent CLIs (`runtime.detect()`),
2. **Scans** this directory into a `CodeGraph` (files, symbols, import edges),
3. **Orchestrates** a task through the Ralph loop (router → planner → workers →
   reviewer → finish), streaming events, and
4. **Inspects** the resulting wiki + codegraph knowledge.

The orchestration runs against a deterministic in-process agent, so it works
**offline** with no real models or installed CLIs. Detection still reports
whatever real agents you have.

## Run it

```bash
pnpm --filter @omakase/example-local-project start
```

## Test it

```bash
pnpm --filter @omakase/example-local-project test
```

`run.ts` exports `runDemo()` so the same flow is exercised in `example.test.ts`.
