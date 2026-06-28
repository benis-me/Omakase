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

## Highlights

- **Use the agents you already have.** Detects and drives the coding-CLI agents
  on your `PATH` (Claude Code, Codex, Gemini, Cursor Agent, …) through one
  `AgentEvent` stream, and assigns them across **planner / worker / reviewer /
  validator** roles. No installed CLI? A dependency-free built-in agent keeps the
  loop runnable with no model calls.
- **Spec-first, verified loops.** A run can adopt a spec's acceptance criteria and
  is held to them: the workspace's `test` script runs as a **hard finish-line
  gate** ahead of an independent LLM validator — a run whose tests never go green
  finishes `incomplete`, not `succeeded`.
- **A memory system, not a transcript.** Knowledge accumulates across runs as
  typed facts/decisions/risks (the curator **distills** them — it doesn't log
  narration). Each agent call gets a small always-in-context **core**, the entries
  **retrieved** as most relevant to its task, and an **index** of the rest to pull
  from `.omks/memory/wiki.md` on demand — bounded, not the whole wiki shoved into
  every prompt (MemGPT/Letta-style tiering + keyword/entity retrieval).
- **Built to run unattended.** Hits a usage limit → it **parks and auto-resumes**
  at the reset. A task fails → it **retries**, and reassigns away from a broken
  agent. An automation's run fails → it **self-heals** with backoff. Runs
  checkpoint and **resume** after an app restart.
- **Self-authoring.** Agents can write their own durable `.omks/` artifacts —
  specs, reusable commands ("skills"), and workflows — so the loop doesn't depend
  on a human writing them first.
- **No native-module ABI dance.** Storage is built on Node's `node:sqlite`.

## The cockpit

A workspace is any folder; opening it scaffolds a `.omks/` directory. The left
rail switches a workspace's surfaces; the right pane edits/views them:

- **Runs** — start a run from a spec or a prompt; pick which **agent CLI** powers
  it and set a **token budget**. Watch the live cockpit (Activity / Tasks /
  Reports / Knowledge tabs): routing, plan, tasks, tool calls, reviews, reports,
  knowledge, gates, finish. Pause / resume / stop, queue a steering message, and
  answer risk gates. The **autonomy dial** (off / low / medium / high)
  auto-proceeds past gates up to its risk threshold; higher gates pause for you.
- **Specs** — a **guided phase machine** (idea → spec → acceptance → test-plan →
  tasks → done) with content guards on each advance; the run reads the spec's
  acceptance criteria and verifies against them.
- **Agents** — the **live roster** of sub-agents a run spawns (role, resolved
  CLI + model, status). Installed CLIs + a Rescan live in Settings.
- **Automations** — triggers that start a run on a schedule (every N minutes or
  daily at a time) or when files change, for unattended self-iterating loops; an
  unattended run that can't finish cleanly raises a system notification.
- **Memory** — the `AGENTS.md` briefing, rules, the accumulated project wiki
  (rendered), and the agent knowledge log.
- **Commands** — reusable prompt recipes ("skills").
- **Workflows** — dynamic orchestration scripts with first-class loop primitives
  (`pipeline` / `loopUntil` / `budget`) and starter templates (Mission, TDD).
- **Dev** — a DevDock-style workbench: scan and run project scripts with live
  xterm terminals, free conflicting ports, edit `.env` files, see git status,
  and "open with" your editor/terminal.

Spec runs close the loop with **objective verification** — they run the
workspace's `test` script as a hard finish-line gate ahead of an independent
LLM validator; a run whose tests never go green finishes `incomplete`, not
`succeeded`.

## Requirements

- Node ≥ 22 (storage uses the built-in `node:sqlite`), pnpm 9
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

> **Storage uses Node's built-in `node:sqlite`** — no native module, no ABI to
> rebuild. It's unflagged in Electron's Node 24; the CLI and test suite (on the
> repo's Node 22) get `--experimental-sqlite` automatically. The one remaining
> native module is `node-pty` (the Dev workbench's terminals); `pnpm --filter
> @omakase/desktop dev` rebuilds it for Electron via `electron-builder
> install-app-deps`. Package a distributable with `pnpm --filter @omakase/desktop
> dist:mac`.

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

- [Architecture](./docs/architecture.md) — the monorepo layering, storage model,
  and how the packages fit together
- [Runtime contract](./docs/runtime-contract.md) — the agent runtime + the
  `AgentEvent` protocol every CLI is normalized to
- [Roadmap & known limitations](./docs/roadmap.md)
- [Contributing](./CONTRIBUTING.md)

## Status

**Early but substantial — pre-1.0.** The full loop runs end-to-end on real agent
CLIs: routing → planning → a parallel multi-agent fleet → review → acceptance +
objective verification, plus the cross-run memory system, resilience (usage-limit
parking + auto-resume, retry, agent reassignment), automations, and the desktop
cockpit + Dev workbench. Data is still treated as **disposable** — no schema or
`.omks` migration guarantees yet, so don't point it at anything precious. See the
[roadmap](./docs/roadmap.md) for what's next, and [contributing](./CONTRIBUTING.md)
if you'd like to help.

## License

[MIT](./LICENSE) © Omakase contributors
