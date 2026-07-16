# Contributing to Omakase

Thanks for your interest! Omakase is a Bun + TypeScript monorepo.

## Setup

```bash
bun install
bun run check        # typecheck (all packages) + tests — must pass before a PR
```

## Layout

```
packages/
  core/        types, .omks workspace, SQLite event store, budget, logging
  providers/   agent-CLI adapters + detection + spawn/stream
  engine/      w runtime, goal-loop, verify, resume, retry, workflow loader, built-ins
  tui/         OpenTUI + React 19 terminal UI
  cli/         the omks command
```

Packages import each other by name (`@omakase/*`) and run as TypeScript directly
under Bun — there is no build step for the libraries or CLI.

## Ground rules

- **Typecheck + tests green.** `bun run check` before every PR. Add tests with your change.
- **Integration tests use a fake provider binary.** To exercise the real spawn + stream‑parse + goal‑loop path without any provider auth or cost, tests write a tiny fake `claude` binary (emits claude stream‑json, echoes `--session-id`, writes a file) and drive it via `runTurn({ command })` or `new SubprocessHarness({ commandFor })`. Prefer this over mocking when testing provider/engine behavior — it's deterministic and catches real bugs (it caught the retry session‑id and parser‑noise bugs).
- **No new runtime dependencies** in `core`/`providers`/`engine`/`cli` without discussion. Omakase is intentionally dependency‑light; the TUI's only external deps are `@opentui/*` and `react`.
- **Match the surrounding style.** Small, focused modules; comments explain *why*.
- **Providers:** a new agent CLI = one definition in `packages/providers/src/providers.ts` + one line in `registry.ts`. Verify flags against the real binary.
- **Workflows:** built‑ins live in `packages/engine/src/builtins/`. Keep them small and composable; they double as examples.

## Adding a provider

1. Add an `AgentProvider` in `providers.ts` (build the headless argv + choose a stream parser).
2. Register it in `registry.ts`.
3. Add tests in `providers.test.ts` (plan args + a fake‑spawner parse test).

## Writing a workflow

`omks workflow new <name>` scaffolds one. The `w` API is documented in the README
and typed by `WorkflowContext` in `@omakase/engine`.

## Commit / PR

- Keep PRs focused. Describe what and why.
- CI runs `bun run check` on push.
