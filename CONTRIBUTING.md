# Contributing to Omakase

Thanks for your interest! Omakase is early and pre-1.0 — issues, ideas, and PRs
are all welcome. This guide gets you set up and explains the conventions.

> **Heads up:** the project is in a disposable-data phase. There are no schema or
> `.omks` migration guarantees yet, so develop against scratch workspaces, not
> anything precious.

## Prerequisites

- **Node ≥ 22** — storage uses the built-in `node:sqlite` (no native rebuild). On
  Node 22 it needs `--experimental-sqlite`, which the test suite and the CLI bin
  pass automatically; Electron's Node 24 has it unflagged.
- **pnpm 9** (`corepack enable` will provide it).
- macOS is needed for the Dev workbench's "open with" + port tooling; everything
  else is cross-platform.
- Optional: any coding-agent CLI on your `PATH` (Claude Code, Codex, Gemini,
  Cursor Agent, …). With none installed, runs fall back to the built-in agent.

## Setup

```bash
pnpm install
pnpm -r build        # daemon → core → storage → cli (topological)
pnpm -r typecheck
pnpm -r test         # nothing here calls a real model or CLI
```

Run the desktop app:

```bash
pnpm --filter @omakase/desktop dev
```

## Project layout

```
packages/daemon    agent-CLI detection + the AgentEvent runtime  (zero deps)
packages/core      the orchestration loop, memory, retrieval, acceptance
packages/storage   the .omks workspace + node:sqlite stores
packages/cli       headless `omakase agents | run | serve | wiki`
apps/desktop       the Electron cockpit (electron-vite + React)
examples/          a library-usage demo
docs/              architecture, runtime contract, roadmap
```

See [`docs/architecture.md`](./docs/architecture.md) and
[`docs/runtime-contract.md`](./docs/runtime-contract.md) before changing the
loop or the agent protocol.

## Conventions

- **TypeScript, strict, ESM.** No `any` escapes without a reason; keep modules
  small and single-purpose. Match the style of the file you're editing.
- **Tests are deterministic and offline.** The daemon's `Transport` seam scripts
  stdout/stdin/exit for a fake transport; the core runs **scripted in-process
  agents**; storage uses temp-dir SQLite. Don't introduce tests that need a real
  model or a real CLI — those are verified by hand. Add a test with every fix.
- **Conventional commits** — `feat(core): …`, `fix(desktop): …`,
  `refactor(storage): …`, `docs: …`, `test: …`. One logical change per commit.
- **Before opening a PR:** `pnpm -r typecheck && pnpm -r test` must be green, and
  if you touch a `packages/*/src` export consumed by `apps/desktop`, rebuild that
  package (`pnpm --filter @omakase/<pkg> build`) so the desktop typecheck resolves
  the new `dist`.

## Pull requests

1. Fork and branch from `main` (`feat/…`, `fix/…`).
2. Keep the diff focused; explain the *why* in the description.
3. Ensure typecheck + tests pass and add coverage for new behavior.
4. Be ready to iterate in review.

## Reporting bugs / proposing features

Open an [issue](https://github.com/benis-me/Omakase/issues). For bugs, include
what you ran, what happened, and what you expected; logs or a minimal repro help
a lot. For features, describe the problem before the solution.

By contributing you agree your contributions are licensed under the project's
[MIT License](./LICENSE).
