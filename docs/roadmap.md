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
- **Free-text review fallback.** Per-criterion structured review is supported
  (`acceptanceCriteria`); without criteria the verdict is parsed from free text
  (`APPROVE`/`REJECT`), and the built-in reviewer auto-approves (no model).
- **Codegraph is syntactic.** Regex extraction sees imports/exports/symbols and
  resolves relative paths and `tsconfig` path aliases
  ({@link loadTsconfigAliases}); it does not resolve types or call graphs. Good
  for blast-radius reasoning, not for refactoring proofs — back it with an OSS
  tool (dependency-cruiser/madge/ts-morph) via `CodeGraph.fromJSON` for depth.
- **24/7 operation** is provided by the {@link Supervisor} (queue +
  `resumeInterrupted()` + heartbeat) plus the resumable orchestrator
  (checkpoint + `resume`). It is pull-based (`drain()`/`heartbeat()`) and
  timer-free; a host wires it to a long-lived loop or cron.

### CLI/TUI
- `omakase run` uses real installed agents by default (it will spend real model
  calls). Pass `--offline` (or `--agent builtin`) to force the built-in agent
  and run with no model calls.
- The TUI auto-runs a task passed on the command line and exposes
  pause/resume/cancel/replan; it does not yet have an in-TUI text input for
  composing a brand-new task interactively.

## Planned enhancements

1. **Adapter conformance tests** that record real CLI output as fixtures and
   replay them through the parsers, keeping argv/stream mapping honest per
   release.
2. **Codegraph depth**: symbol-level edges, call graphs, and a watch-mode that
   feeds incremental `update()` from a file watcher (path-alias resolution is
   done).
3. **Host integrations**: an `omakase serve`/cron wrapper around the
   {@link Supervisor}, and an in-TUI text input for composing new tasks.

**Shipped since first cut:** bounded-parallel task execution
(`maxConcurrency`), a TTL detection cache (`detectionCacheTtlMs` +
`refreshDetection()`), `--offline`/`--agent`, a token/cost budget (`budget` /
`--max-tokens` / `--max-cost`), atomic checkpoint writes, unique run ids, the 14
adversarial-review fixes, **cross-run persisted knowledge** (`KnowledgeStore` /
`projectKnowledgeStore` under `.omakase/`), **structured per-criterion review**
(`acceptanceCriteria` + `parseStructuredReview`), **live MCP injection** (three
strategies via `applyMcpInjection`), **codegraph tsconfig path-alias
resolution** (`loadTsconfigAliases`), the **Supervisor daemon** (queue +
`resumeInterrupted()` + heartbeat), and **skill-aware planning**.
