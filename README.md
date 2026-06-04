# Omakase

> Agent runtime, multi-agent orchestration core, and CLI/TUI for autonomous
> software work.

Omakase is a library-first toolkit for building agents on top of the coding-CLI
agents you already have installed (Claude Code, Codex, Gemini, Cursor Agent,
pi, …). It detects them, runs them through one unified event protocol, and
orchestrates them in a continuous **router → planner → workers → reviewer →
replan** loop with a resumable supervisor — usable as a library or through the
`omakase` CLI/TUI.

```
@omakase/cli   ──▶   @omakase/core   ──▶   @omakase/daemon
 CLI + Ink TUI        orchestration         agent runtime (dependency-free)
```

- **`@omakase/daemon`** — detect agent CLIs, run them through a single
  `AgentEvent` stream, load skills. Zero runtime dependencies.
- **`@omakase/core`** — the Ralph loop: router, plan graph, work modes, hooks,
  wiki + codegraph, spec/TDD workflows, and a resumable, checkpointing
  supervisor.
- **`@omakase/cli`** — `omakase agents | run | tui`, all built on the core.

## Requirements

- Node ≥ 20 (developed on 22)
- pnpm 9

## Quickstart

```bash
pnpm install
pnpm -r build

# List the agent CLIs detected on this machine
pnpm --filter @omakase/cli omakase agents

# Run a task. By default it uses your strongest installed agent; add --offline
# to force the built-in agent and run with no model calls.
pnpm --filter @omakase/cli omakase run "summarize this project" --offline

# Open the interactive TUI
pnpm --filter @omakase/cli omakase tui "add input validation and write tests"

# Supervise a queue for long-running / 24-7 operation: resumes anything left
# unfinished and ingests task files dropped into .omakase/queue/*.txt
pnpm --filter @omakase/cli omakase serve --watch
```

During development you can skip the build and run from source via tsx:

```bash
pnpm --filter @omakase/cli dev agents
```

## Install `omakase` globally (auto-tracks your code)

Put `omakase` on your `PATH` as a live launcher that runs the TypeScript source
via tsx — so any edit to the code takes effect immediately, with **no rebuild**:

```bash
pnpm install            # once, so node_modules/.bin/tsx exists
pnpm run link:global    # symlinks ~/.local/bin/omakase → scripts/omakase.sh
```

Then from any project directory (the CLI operates on the current working dir):

```bash
cd ~/some-project
omakase agents
omakase run "summarize this project" --offline
omakase serve --watch
```

`~/.local/bin` must be on your `PATH`. The launcher is a symlink into this repo,
so both the launcher and the code it runs stay in sync with your checkout; after
a dependency change run `pnpm install` again. Uninstall with
`rm ~/.local/bin/omakase`.

Prefer a compiled global binary instead (faster startup, no tsx)? Build and let
pnpm link it — but then rebuild (or run `pnpm run build:watch`) after edits:

```bash
pnpm -r build && pnpm --filter @omakase/cli link --global
```

## Use it as a library

```ts
import { createAgentRuntime } from '@omakase/daemon';
import { Orchestrator, MemoryRunStore } from '@omakase/core';

const runtime = createAgentRuntime({ fallbackToBuiltin: true });
const agents = await runtime.detect();

const orchestrator = new Orchestrator({ runtime, store: new MemoryRunStore() });
const handle = orchestrator.start({ prompt: 'Build a CSV parser and write tests', cwd: process.cwd() });

for await (const event of handle.events) console.log(event.type);
const result = await handle.result; // { status, summary, plan, wiki, events }
```

The runnable end-to-end demo lives in
[`examples/local-project`](./examples/local-project):

```bash
pnpm --filter @omakase/example-local-project start
```

## Scripts

| Command | What it does |
|---------|--------------|
| `pnpm -r build` | Build every package (topological order) |
| `pnpm -r typecheck` | Strict typecheck every package |
| `pnpm -r test` | Run every package's Vitest suite |
| `pnpm check` | `typecheck` + `test` |

## Testing philosophy

Nothing in the test suite touches a real model or requires a real agent CLI.
The daemon's `Transport` is the seam: a controllable **fake transport** scripts
stdout/stdin/exit so detection, every stream parser, the pi RPC session, and
abort/timeout are all deterministic. The core runs against **scripted in-process
agents**, and the CLI/TUI commands take injectable dependencies so they run
headless. Real CLIs are a runtime concern, verified by hand (`omakase agents`
detects them; `omakase run` drives them).

## Docs

- [Architecture](./docs/architecture.md) — layers, boundaries, key types, decisions
- [Runtime contract](./docs/runtime-contract.md) — the adapter contract + event model
- [Roadmap](./docs/roadmap.md) — known limitations and what's next

## License

MIT
