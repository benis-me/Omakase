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

# Run a task (uses an installed agent if present, else the offline built-in)
pnpm --filter @omakase/cli omakase run "summarize this project"

# Open the interactive TUI
pnpm --filter @omakase/cli omakase tui "add input validation and write tests"
```

During development you can skip the build and run from source via tsx:

```bash
pnpm --filter @omakase/cli dev agents
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
