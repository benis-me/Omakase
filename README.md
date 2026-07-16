# Omakase (`omks`)

> Orchestrate the AI agent CLIs you already have installed — with **Dynamic Workflows** and a **Goal‑loop** that keeps working until the job is verifiably done.

Omakase is a local‑first, open‑source CLI + TUI that turns `claude`, `codex`, `gemini`, `cursor-agent` (and more) into a fleet you can compose. You give it a **goal**; it plans, dispatches agents in parallel, verifies the result against success criteria, and loops until it's met — with durable **resume**, **retry**, and an event‑sourced history of everything that happened.

Built on **Bun**, **TypeScript**, **React 19** and **OpenTUI**. Zero runtime dependencies beyond the terminal renderer.

```
omakase — orchestrate your agents
❯ Goal · goal
  Add a health-check endpoint and a test for it
▸ Plan
  claude › Plan the work
    ✓ 2 steps planned
▸ Build
  claude › Build: add /healthz route     ✓  $0.021
  codex  › Review: add /healthz route     ✓
▸ Validate
  goal MET
✓ succeeded · Added /healthz + passing test.
```

---

## Why

Every agent CLI is a silo. Omakase is the layer above them:

- **Use what you have.** It auto‑detects installed agent CLIs and drives them headlessly. No API keys to re‑enter, no lock‑in.
- **Dynamic Workflows.** Orchestration is code — small Bun/TypeScript files with a tiny `w` API (`phase`, `agent`, `parallel`, `pipeline`, `loopUntil`). They're **reusable, versioned, and used like Skills**: the more you write, the more capable Omakase gets.
- **Goal‑loop.** Define success criteria (a command that must exit 0, a file that must exist, or a natural‑language rubric judged by an agent). Omakase loops — plan → build → **verify** → fix — until they pass or a budget stops it. The verifier keeps autonomous runs honest instead of self‑declaring victory.
- **Durable.** Every run is an append‑only event log in SQLite. Interrupted? `omks resume <id>` replays completed work from cache and continues. Flaky provider? Foundation retry with backoff.
- **Multi‑harness.** The engine talks to a `Harness` interface; the default drives subprocess CLIs, but ACP/in‑process harnesses slot in behind the same seam.

---

## Install

Requires **[Bun](https://bun.sh) ≥ 1.3** and at least one agent CLI on your `PATH`
(`claude`, `codex`, `gemini`, or `cursor-agent`).

```bash
git clone https://github.com/benis-me/Omakase
cd Omakase
bun install
bun link            # exposes `omks` globally (or: alias omks="bun /path/to/packages/cli/bin/omks.ts")
```

## Quickstart

```bash
cd my-project
omks init                       # create the .omks workspace
omks doctor                     # check providers + workflows

# Run a goal (headless), streaming progress:
omks run "add a /healthz endpoint and a test" --check "bun test"

# …or just launch the TUI:
omks
```

`omks "build me X"` is shorthand for `omks run "build me X"`.

---

## Real run

This is a **real, unedited run** — not a mock. In an empty directory:

```bash
omks run "Implement a TypeScript token-bucket rate limiter as a Bun project:
  package.json, src/rate-limiter.ts (a RateLimiter class with capacity +
  refillPerSecond, tryRemove(n=1), time-based refill, injectable clock), and
  src/rate-limiter.test.ts (bun:test) covering burst, denial, and refill.
  Make sure 'bun test' passes." \
  --workflow goal --provider claude --check "bun test" --max-agents 12
```

What Omakase did:

1. **Planned 4 steps** (package.json → limiter → tests → run the suite).
2. Built + peer‑reviewed each step in a pipeline.
3. **The Goal‑loop ran the real `bun test`** as its success criterion and looped
   until it went green — no self‑declared victory.
4. `✓ succeeded` — **9 agent turns, ~$2.46**.

The result is a working library (`bun test` → **4 pass, 0 fail, 18 assertions**),
including a proper injectable clock so the time‑based tests are deterministic:

```ts
// src/rate-limiter.ts  (generated)
export class RateLimiter {
  constructor({ capacity, refillPerSecond, now = Date.now }: RateLimiterOptions) { … }
  tryRemove(n = 1): boolean { this.refill(); if (this.tokens >= n) { this.tokens -= n; return true; } return false; }
  available(): number { this.refill(); return this.tokens; }
}
```

The point isn't that an agent wrote code — it's that Omakase **planned it, ran it
in parallel, and refused to finish until `bun test` actually passed.**

---

## Command reference

```
omks                            launch the interactive TUI
omks "<goal>"                   run a goal with the default workflow

CORE
  init [name]                   create an .omks workspace here
  run "<goal>" [opts]           drive a goal to completion (headless)
  resume <runId>                resume an interrupted run
  runs [show <id>]              list / inspect past runs

WORKFLOWS  (reusable, versioned, skills-like)
  workflow list                 list available workflows
  workflow show <name>          show a workflow’s docs
  workflow new <name> [--flat]  scaffold a new workflow
  workflow run <name> "<goal>"  run a specific workflow
  workflow version <name>       show / --bump patch|minor|major

AGENTS & CONFIG
  agent list                    show installed agent CLIs
  agent scan                    re-detect providers + models
  agent check                   verify each provider is authenticated
  config [get|set|list]         workspace settings
  session [list|show]           grouped runs
  doctor                        environment diagnostics
  web [--port n] [--open]       browser dashboard (Vite + React)
  mcp                           run as an MCP server (stdio) for other agents

RUN OPTIONS
  --workflow, -w <name>         pick a workflow (default: goal)
  --provider, -p <id>           pin claude|codex|gemini|cursor-agent
  --model, -m <model>           pin a model
  --check "<cmd>"               success check: command must exit 0 (repeatable)
  --criteria "<text>"           natural-language criterion, judged (repeatable)
  --max-agents <n>              cap agent calls   --concurrency <n>  parallelism
  --max-usd <n>                 cap total spend   --max-time <sec>   wall-clock budget
  --param k=v                   workflow parameter (repeatable)   --session <id>  continue
  --cwd <dir>                   working directory   --json  emit JSONL events
```

---

## Concepts

### Dynamic Workflows

A workflow is a Bun/TypeScript function that receives an orchestration handle `w`:

```ts
// .omks/workflows/ship.ts
// name: ship
// description: Plan, build each step in parallel, then validate against the goal.
// version: 0.1.0
import type { WorkflowContext } from '@omakase/engine';

export default async function ship(w: WorkflowContext): Promise<void> {
  const steps = await w.phase('Plan', async () => {
    const res = await w.agent({ role: 'planner', title: 'Plan', prompt: `Break down: ${w.goal.text}` });
    return res.text.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean);
  });

  await w.phase('Build', async () => {
    await w.pipeline(
      steps,
      (_v, step) => w.agent({ role: 'worker',   title: `Build ${step}`,  prompt: `Implement: ${step}` }),
      (built, step) => w.agent({ role: 'reviewer', title: `Review ${step}`, prompt: `Review: ${step}\n${(built as any).text}` }),
    );
  });

  await w.phase('Validate', async () => {
    await w.loopUntil(async () => {
      const { met, gaps } = await w.goalMet();
      if (met) return [];
      await w.parallel(gaps.map((g) => () => w.agent({ role: 'worker', title: 'Fix', prompt: `Fix: ${g}` })));
      return gaps;
    }, { maxRounds: 3 });
  });

  w.requestReport({ kind: 'final', title: 'Done', summary: `Shipped ${steps.length} step(s).` });
}
```

The `w` API:

| Method | Purpose |
| --- | --- |
| `w.phase(name, fn)` | group work into a named, logged phase |
| `w.agent({role,title,prompt,provider?,model?})` | run one agent turn → `{text,status,sessionId}` |
| `w.parallel([...])` | run thunks concurrently (bounded), await all |
| `w.pipeline(items, ...stages)` | stage each item independently — no barrier |
| `w.loopUntil(fn, {maxRounds})` | loop until `fn` returns `[]` |
| `w.goalMet()` | evaluate the goal's success criteria now |
| `w.budget()` · `w.log()` · `w.requestReport()` · `w.updateWiki()` | accounting, logging, reports, knowledge |
| `w.subdir(name)` · `w.isolate(label, fn)` | isolate parallel agents (subdir; or a git worktree that merges back) |
| `w.recall(limit)` · `w.providers` | accumulated knowledge; available agents (for routing) |

Workflows live either as a flat `<name>.ts` or a **skills‑like folder** with `WORKFLOW.md` (frontmatter incl. a SEMVER `version`) + `workflow.ts` + optional `references/`. Workspace workflows shadow built‑ins of the same name, so you can customize anything. `omks workflow version <name> --bump minor` snapshots and bumps. See [`examples/workflows/ship-feature/`](examples/workflows/ship-feature) for a real folder‑format workflow using `isolate` + provider routing + `recall`. Validate a workflow without spending anything: `omks workflow test <name>`.

Built‑ins: **goal** (default), **auto** (prompt self‑orchestration — the model designs its own DAG), **mission**, **tdd**, **review**, **research**, **parallel**, **solo**.

**Isolating parallel agents.** Agents in `parallel`/`pipeline` share the run's working directory by default. When branches are independent, give each its own folder with `w.subdir(name)` + `agent({ cwd })` so they never edit the same files — the built‑in **parallel** workflow does exactly this.

### Goal‑loop, verification, resume & retry

- **Success criteria** are `command` (exit 0), `file` (exists/matches), `rule` (regex over the tree) or `judge` (agent‑scored rubric). The loop is *done* only when all pass; it stops early on budget exhaustion, a fatal error, cancellation, or a **no‑progress stall**.
- **Resume:** each `agent()` call is keyed by a deterministic structural path and its result is journaled. `omks resume <id>` replays finished calls from cache and re‑drives the rest — robust even across `parallel`/`pipeline`.
- **Foundation retry:** provider calls retry with exponential backoff + jitter, never on cancellation; **rate‑limit / overload** errors back off much harder and record `rateLimitedUntil`.
- **Provider fallback:** if an agent's provider keeps failing, Omakase falls back to the next available provider (emitting `harness:switched`) — so a claude outage doesn't stall the run.
- **Budget:** cap a run by agent calls, **USD spend**, or **wall‑clock** (`--max-agents` / `--max-usd` / `--max-time`); the loop stops with the precise reason.

### Providers & harnesses

Detected via `<cmd> --version` over an augmented `PATH`; results cached in `.omks/agents.json`. Each adapter builds the exact headless invocation and normalizes the CLI's stream into activities + a result. Verified flags for `claude` (`-p --output-format stream-json …`), `codex` (`exec --json -C <cwd> -o <file>`), `gemini` (`-y -o stream-json`), `cursor-agent` (`-p --output-format stream-json`).

> **Auth:** detection only checks that a CLI is installed — each provider must also be **authenticated for headless use**: `claude` needs an active login (`claude` → `/login`), `gemini` needs `GEMINI_API_KEY` (or a configured auth method), `codex` needs `OPENAI_API_KEY`, `cursor-agent` needs `CURSOR_API_KEY`. If a provider isn't authed, Omakase surfaces its real error (e.g. "Not logged in") and moves on.

---

## Architecture

A Bun workspace of focused packages:

| Package | Responsibility |
| --- | --- |
| `@omakase/core` | domain types, `.omks` workspace, event‑sourced SQLite store, budget, logging |
| `@omakase/providers` | detect & drive agent CLIs; spawn, stream‑parse, cancel |
| `@omakase/engine` | the `w` runtime, goal‑loop, verify, resume, retry, workflow loader, built‑ins, harness |
| `@omakase/tui` | OpenTUI + React 19 terminal interface |
| `@omakase/cli` | the `omks` command |

```
.omks/
  workspace.json     identity + settings
  omks.db            runs, events, tasks, reports, sessions, wiki, kv
  workflows/         your Dynamic Workflows (versioned)
  memory/AGENTS.md   briefing every agent reads
  agents.json        cached provider scan
  runs/              per-run journals
```

## Development

```bash
bun install
bun run check          # typecheck (all packages) + tests
bun test               # unit + integration tests across all packages
bun run typecheck:all

bun run build:cli      # compile a self-contained ./dist/omks binary (no Bun needed to run)
bun run build:web      # build the dashboard SPA (Vite)
```

## License

MIT © Omakase contributors
