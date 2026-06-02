# Architecture

Omakase is a pnpm/TypeScript monorepo with three layered packages plus an
example. Each layer imports **only downward**, so the dependency graph is a
clean line:

```
@omakase/cli  ──▶  @omakase/core  ──▶  @omakase/daemon
 (CLI + TUI)        (orchestration)      (agent runtime; dependency-free)
```

The daemon has **zero runtime dependencies** (Node built-ins only). The core
depends only on the daemon. The CLI depends on both, plus Ink + React for the
TUI. This keeps the daemon and core embeddable in any downstream project.

## `@omakase/daemon` — the agent runtime base layer

The daemon answers two questions: *what agents are installed?* and *how do I
run one and get a uniform stream of events back?*

| Area | Key exports | What it does |
|------|-------------|--------------|
| Protocol | `AgentEvent`, `createResultAccumulator`, `collectAgentResult`, `createJsonLineStream` | The unified event model every adapter maps into; folds events into an `AgentRunResult`; parses JSONL stdout. |
| Errors | `AgentRuntimeError` + subclasses, `isAgentRuntimeError` | Discriminable failures: `not_installed`, `auth_missing`, `spawn_failed`, `protocol_error`, `timeout`, `cancelled`, `prompt_too_large`. |
| Transport | `Transport`, `createNodeTransport`, `createFakeTransport` (testing) | The process seam. Production wraps `child_process.spawn`; the fake scripts stdout/stdin/exit for tests. |
| Runtime defs | `RuntimeAgentDef`, `RuntimeRegistry`, `createRegistry`, 8 built-in adapters | Declarative descriptions of how to detect & drive each CLI; downstream code registers its own. |
| Detection | `detectAgents`, `detectAgent`, `resolveRuntime` | Fault-isolated probing → `DetectedAgent[]` (availability, version, models, auth, capabilities). |
| Execution | `createAgentRuntime` → `runtime.runAgent` / `runtime.streamAgentEvents` | Resolve an agent and stream `AgentEvent`s via the right executor. (The latter two are methods on the runtime, not standalone exports.) |
| Executors | `spawnExecutor`, `piRpcExecutor`, `createScriptedAgent`, `localResponderAgent` | Spawn external CLIs, drive pi's RPC, or run deterministic in-process agents. |
| Skills | `listSkills`, `selectSkillsForPrompt`, `renderSkillContext`, `parseFrontmatter` | Multi-root `SKILL.md` discovery + prompt-injection selection. |

**The event model is the contract.** Adapters differ wildly (Claude's
stream-json, Codex's JSON events, pi's RPC dialogue, plain text), but they all
map to one `AgentEvent` union. Consumers never branch on the agent.

**The transport is the test seam.** Because every subprocess goes through a
`Transport`, the entire stack — detection probes, stream parsing, the pi RPC
session, abort/timeout — is exercised with a controllable fake. No real
binaries, no network, deterministic timing.

**The built-in agent is real, not a stub.** `localResponderAgent` runs
in-process: it summarizes a project from the filesystem, and as a reviewer it
approves (declaring it can't deeply judge without a model). This is the default
execution base for every role when no CLI is installed, and what makes
`omakase run` work offline.

## `@omakase/core` — multi-agent orchestration

The core implements the **Ralph loop**:

```
router → planner → workers → reviewer → replan → continue / finish
```

| Area | Key exports | What it does |
|------|-------------|--------------|
| Router | `RuleRouter`, `createAgentRouter` | Classify a request as `simple` (one agent) or `complex` (full loop). Deterministic rules + an LLM-backed extension point. |
| Plan graph | `PlanGraph`, `TaskNode`, `TaskStatus`, `ReplanReason` | A dependency DAG with statuses, readiness, cycle detection, topo order, and snapshots. |
| Planner | `RulePlanner`, `createAgentPlanner` | Decompose a request into worker tasks gated by a review task. |
| Modes/policy | `createModelPolicy`, `RoleAssignment` | `max-power` / `normal` / `custom` selection of agent + model + reasoning per role, with a builtin fallback. |
| Hooks | `HookBus`, `OrchestrationHooks` | Ten hook points (`beforeRoute`, `afterAgentRun`, `beforeFileChange`, `beforeReplan`, `onTaskStatusChange`, `onError`, …) with priority ordering and throw/continue failure policy. |
| Knowledge | `ProjectWiki`, `CodeGraph` | A facts/decisions/risks/tasks wiki + a regex-based code graph (imports/exports/symbols/cycles), both incremental and serializable. |
| Workflows | `SpecWorkflow`, `TddLoop` | State machines for spec-driven development and red-green-refactor TDD. |
| Supervisor | `Orchestrator`, `RunStore`, `MemoryRunStore`, `FileRunStore`, `Inbox` | The resumable loop: checkpoint after every task, `resume()` a crashed run, pause/resume/cancel, mid-run `appendUserInput`. |
| Self-improve | `assertSafeWorkspace`, `prepareSelfImprovement`, `summarizeChanges` | Git-guarded routines so the system can work on its own repo without clobbering uncommitted work. |

**The orchestrator emits a typed `OrchestratorEvent` stream** (`run-started`,
`routed`, `planned`, `task-status`, `agent-event`, `task-finished`, `review`,
`replanned`, `knowledge-updated`, `user-input`, `paused`/`resumed`,
`heartbeat`, `run-finished`, `error`). The CLI/TUI render this; tests assert on
it; the `RunStore` persists it.

**Resumability.** After each task the orchestrator writes a `RunRecord`
(request, route decision, plan snapshot, wiki, inbox, event log) to a
`RunStore`. `Orchestrator.resume(runId)` rebuilds the graph/wiki/inbox and
continues from where it stopped — completed tasks are not re-run.

## `@omakase/cli` — CLI + TUI

```
omakase agents [--json]          list detected agents
omakase run "<task>" [--mode …]  run a task through the orchestrator
omakase tui ["<task>"]           interactive Ink/React TUI
```

The CLI is deliberately thin and **never reaches around the core**: every
command builds an `Orchestrator`/`AgentRuntime` and drives it. Logic that could
live outside React does: `view-model.ts` is a pure `OrchestratorEvent → RunView`
reducer (unit-tested), `render.ts` formats plain text, and `tui/App.tsx` is a
thin Ink renderer over the same `RunView`. Dependencies (output sink, runtime,
orchestrator factory, TUI launcher) are injectable, so commands run headless in
tests with no binaries, no models, and no TTY.

### Why Ink?
The brief preferred Ink, and it fits: the TUI is genuinely component-shaped
(panels for agents, task graph, stream, knowledge). The risk with Ink is
testability and ESM friction, mitigated by (a) keeping all logic in the pure
view-model and (b) a single `ink-testing-library` smoke test. If a
zero-dependency TUI were required, the same `RunView` could back a hand-rolled
ANSI renderer with no other change.

## Cross-cutting decisions

- **ESM + NodeNext throughout**, `.js` import specifiers in source — the
  publish-ready shape for a modern Node library; Node 22 runs it natively.
- **Build vs. typecheck vs. test resolution.** Each package has a
  `tsconfig.json` (typecheck/IDE, `paths` → sibling `src`) and a
  `tsconfig.build.json` (emit, no `paths`, resolves built `dist`). Vitest uses
  `resolve.alias` → `src`. The upshot: `build`, `typecheck`, and `test` each
  pass on a fresh `pnpm install` with no ordering surprises (`pnpm -r` runs in
  topological order).
- **Determinism.** Ids come from injectable counters, clocks are injectable,
  and randomness is avoided — so runs are reproducible and snapshots are stable.

See [`runtime-contract.md`](./runtime-contract.md) for the adapter contract and
[`roadmap.md`](./roadmap.md) for known limitations and what's next.
