# Roadmap & known limitations

Omakase today is a complete, working, tested implementation of the agent
runtime, the orchestration core, and the CLI/TUI. This page is honest about
where the edges are and what would deepen each layer.

## Known limitations

### Daemon
- **Adapter argv fidelity.** The 8 built-in adapters use reasonable, current
  flags, but exact CLI syntax drifts across releases. Detection and the
  transport seam are fully tested; real-CLI *runs* depend on the installed
  version. `claude`, `codex`, and `pi` are the most exercised; `gemini`,
  `opencode`, `cursor-agent`, `qwen`, and `copilot` use `plain-text` streaming
  and best-effort flags.
- **Auth detection is heuristic.** Presence of an env var or a home-dir
  credential file implies `ok`; it does not verify the token is valid or
  unexpired. A real probe (a cheap authenticated call) would be more accurate.
- **MCP injection is declared, not performed.** `externalMcpInjection` is
  surfaced on `DetectedAgent` but the daemon does not yet write `.mcp.json` /
  merge ACP configs at spawn time.
- **No detection cache.** `streamAgentEvents` re-resolves the binary
  (`resolveRuntime`: version + help probe) per run. Fine for interactive use;
  a short-TTL cache would help tight loops.
- **Codex/Gemini stream mapping** covers the common event shapes; uncommon or
  newest event variants fall through to no-ops.

### Core
- **Planner/router are rule-based by default.** They are deterministic and
  tested; the `createAgentRouter`/`createAgentPlanner` extension points use an
  agent but are best-effort parsers with rule-based fallback.
- **Review is shallow.** With a real agent the reviewer's verdict is parsed
  from free text (`APPROVE`/`REJECT`); the built-in reviewer auto-approves
  because it has no model to judge with. Structured review (per-criterion
  scoring) is a natural extension.
- **Tasks run sequentially.** The loop executes ready tasks one at a time for
  deterministic behaviour; bounded parallelism across independent ready tasks
  is a clear win.
- **Codegraph is syntactic.** Regex extraction sees imports/exports/symbols and
  resolves relative paths; it does not resolve `tsconfig` path aliases, types,
  or call graphs. Good for blast-radius reasoning, not for refactaring proofs.
- **24/7 operation** is modeled via the resumable supervisor (checkpoint +
  `resume`), not a long-lived process; a daemonized scheduler/heartbeat monitor
  on top of `RunStore` is future work.

### CLI/TUI
- `omakase run` uses real installed agents by default (it will spend real model
  calls). Use a project with no agents on PATH, or wire a custom runtime, for a
  purely offline run.
- The TUI auto-runs a task passed on the command line and exposes
  pause/resume/cancel/replan; it does not yet have an in-TUI text input for
  composing a brand-new task interactively.

## Planned enhancements

1. **Adapter conformance tests** that record real CLI output as fixtures and
   replay them through the parsers, keeping argv/stream mapping honest per
   release.
2. **Bounded-parallel task execution** with a configurable concurrency cap.
3. **Live MCP injection** implementing the three declared strategies.
4. **Detection cache** with TTL + manual `refresh()`.
5. **Structured review** (acceptance-criteria scoring tied to `SpecWorkflow`).
6. **Codegraph depth**: tsconfig path-alias resolution, symbol-level edges, and
   a watch-mode that feeds incremental `update()` from a file watcher.
7. **Supervisor daemon**: a long-running process that owns `RunStore`, restarts
   interrupted runs, and exposes heartbeat/health.
8. **Skill-aware planning**: let selected skills shape the plan, not just inject
   prompt context.
9. **Cost/budget policy**: per-run token/cost budgets enforced by the policy and
   surfaced in the TUI.
10. **Persisted wiki/codegraph** under `.omakase/` so knowledge survives across
    runs and processes.
