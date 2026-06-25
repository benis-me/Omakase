# Omakase

> A desktop cockpit for spec-driven, long-running, autonomous multi-agent work —
> built on the coding-CLI agents you already have installed.

**おまかせ (omakase)** — "I'll leave it to you." Hand a spec to autonomous,
long-running, multi-agent loops and let them complete the work, while you watch
and steer. Omakase orchestrates the agent CLIs already on your machine (Claude
Code, Codex, Gemini, Cursor Agent, pi, …) through one unified event protocol and
a continuous **router → planner → workers → reviewer → replan** loop, with a
DevDock-style project workbench built in.

```
apps/desktop ─┐
              ├─▶ @omakase/core ─▶ @omakase/daemon
@omakase/cli ─┘        ▲
                       │
              @omakase/storage  (.omks files + SQLite)
```

- **`@omakase/daemon`** — detect agent CLIs, run them through a single
  `AgentEvent` stream, load skills. Zero runtime dependencies.
- **`@omakase/core`** — the Ralph loop: router, plan graph, work modes, hooks,
  wiki + codegraph, spec / TDD / dynamic workflows, and a resumable,
  checkpointing supervisor.
- **`@omakase/storage`** — a per-project `.omks/` workspace: git-friendly
  authored files (specs, agents, memory, commands, workflows) plus a SQLite
  database for high-volume run/event data. Implements core's storage interfaces.
- **`@omakase/cli`** — headless `omakase agents | run | serve`, on the core.
- **`apps/desktop`** — the Electron cockpit (electron-vite + React 19 + Zustand +
  Tailwind v4 + shadcn + radix).

## The cockpit

A workspace is any folder; opening it scaffolds a `.omks/` directory. The left
rail switches a workspace's surfaces; the right pane edits/views them:

- **Runs** — start a run from a spec or a prompt and watch the live, single-column
  feed (routing, plan, tasks, tool calls, reviews, reports, knowledge, gates,
  finish). Pause / resume / stop, queue a steering message, and answer risk
  gates. The **autonomy dial** (off / low / medium / high) auto-proceeds past
  gates up to its risk threshold; higher gates pause for your decision.
- **Specs** — first-class markdown specs (phase + status) you hand to the loop.
- **Agents** — author custom agent definitions; see the agent CLIs detected
  locally.
- **Memory** — the `AGENTS.md` briefing, rules, the accumulated project wiki, and
  the agent knowledge log.
- **Workflows** — dynamic orchestration scripts.
- **Dev** — a DevDock-style workbench: scan and run project scripts with live
  xterm terminals, free conflicting ports, edit `.env` files, see git status,
  and "open with" your editor/terminal.

## Requirements

- Node ≥ 20 (developed on 22), pnpm 9
- macOS for the Dev workbench's "open with" + port tools (the rest is
  cross-platform)
- Optional: any coding-agent CLI on your `PATH`. With none installed, runs fall
  back to the dependency-free built-in agent (no model calls).

## Run the desktop app

```bash
pnpm install
pnpm -r build                          # build daemon / core / storage / cli
pnpm --filter @omakase/desktop dev     # launch the Electron app
```

> **Native modules:** `better-sqlite3` and `node-pty` stay compiled for Node so
> the test suite runs under Node. `pnpm --filter @omakase/desktop dev` rebuilds
> them for Electron's ABI (`electron-builder install-app-deps`); after running
> the app, run `pnpm rebuild better-sqlite3` before `pnpm -r test` again. Package
> a distributable with `pnpm --filter @omakase/desktop dist:mac`.

## Headless CLI

The same engine, without a UI — for automation and as the detached runner. The
interactive `run`/`wiki`/`workflow` commands persist into the project's `.omks`
workspace:

```bash
pnpm --filter @omakase/cli omakase agents                       # list detected agents
pnpm --filter @omakase/cli omakase run "summarize this" --offline
pnpm --filter @omakase/cli omakase serve --watch                # 24/7 queue supervisor
```

## The `.omks` workspace

```
.omks/
├── workspace.json      # manifest: name, settings, project roots
├── specs/<id>.md       # authored specs (frontmatter + body)
├── agents/<id>.md      # custom agent definitions
├── memory/AGENTS.md    # briefing packet injected into runs
├── memory/wiki.md      # rendered project wiki (knowledge accumulates here)
├── commands/, workflows/
└── omks.db             # SQLite: runs, events, tasks, knowledge (gitignored)
```

Authored content is git-friendly markdown; machine-written run/event data lives
in SQLite. A legacy `.omakase/` directory is imported non-destructively on first
open.

## Use it as a library

```ts
import { createAgentRuntime } from '@omakase/daemon';
import { Orchestrator } from '@omakase/core';
import { openWorkspace } from '@omakase/storage';

const runtime = createAgentRuntime({ fallbackToBuiltin: true });
const ws = openWorkspace(process.cwd());                 // ensures .omks, opens omks.db
const orchestrator = new Orchestrator({ runtime, store: ws.runStore, knowledgeStore: ws.knowledgeStore });
const handle = orchestrator.start({ prompt: 'Build a CSV parser and write tests', cwd: ws.root });

for await (const event of handle.events) console.log(event.type);
const result = await handle.result;                      // { status, summary, plan, wiki, events }
ws.close();
```

## Scripts

| Command | What it does |
|---------|--------------|
| `pnpm -r build` | Build every package (topological order) |
| `pnpm -r typecheck` | Strict typecheck every package |
| `pnpm -r test` | Run every package's Vitest suite |
| `pnpm --filter @omakase/desktop build` | electron-vite build (main/preload/renderer) |

## Testing philosophy

Nothing in the test suite touches a real model or requires a real agent CLI. The
daemon's `Transport` is the seam: a controllable **fake transport** scripts
stdout/stdin/exit so detection, every stream parser, and abort/timeout are
deterministic. The core runs against **scripted in-process agents**; storage runs
against temp-dir SQLite; the desktop main process is tested headless under Node.
Real CLIs are a runtime concern, verified by hand.

## Docs

- [Design spec](./docs/superpowers/specs/2026-06-25-omakase-desktop-design.md) —
  architecture, storage model, loop modes, phasing
- [Research](./docs/research/spec-driven-autonomous-agents-2026.md) — Ralph loop,
  Factory Droid, Anthropic dynamic workflows, loop engineering

## Status

Built and green: the storage layer, the Electron shell + workspace management,
the Dev workbench, the authored-content surfaces, and the live Runs cockpit.
Roadmap: Mission mode (orchestrator / worker / validator with fresh-context
workers), detached-daemon handoff so runs survive app close, run resume on
reopen, and packaging polish.

## License

MIT
