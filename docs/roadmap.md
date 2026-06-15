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
  *credential* file implies `ok`; it does not verify the token is valid or
  unexpired. A real probe (a cheap authenticated call) would be more accurate.
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
- The TUI is a conversational console built on **OpenTUI** (the same framework
  opencode uses) and **runs under Bun** — `omakase tui` (Node) ensures the daemon
  and submits the task, then spawns the app under `bun --conditions=development`.
  **Bun must be installed** (https://bun.sh). A **session** groups multiple
  **serial** runs into one continuous conversation with a rolling-summary context
  bridge. The composer is a native multiline `<textarea>` (correct keybindings:
  cursor, Backspace, ctrl+j newline) accepting natural-language tasks (routed by
  the router-agent), `/slash` commands, inline `@agent`/`#file`. The left pane
  renders the run event stream as a chat transcript (native `<markdown>`/`<diff>`)
  with **live token streaming**; the right sidebar shows the focused run's plan +
  agents. A fuzzy **command palette** (`ctrl+p`) and a **leader key** (`ctrl+x`)
  drive session/model/agent selectors (native `<select>`); the transcript is a
  `<scrollbox>` and `esc` interrupts the active run. Quitting never cancels a
  run — the daemon owns it; relaunching re-attaches, and only `/stop`/`esc`
  cancels. Streaming saves are coalesced by the daemon's `streamFlushMs` window.
- The OpenTUI view layer is smoke-tested under Bun (`test:tui`, OpenTUI
  `testRender`); the framework-agnostic logic (composer parse, transcript
  projection, fuzzy, leader, session store) keeps full Node/vitest unit coverage.

  Known TUI follow-ups: `@`-fuzzy file finder and `!`-shell prefix; colour themes
  and an external-`$EDITOR` handoff are not yet wired.

## Planned enhancements

1. **Codegraph semantic depth**: symbol-level edges and call graphs. This is
   intentionally *not* attempted from regex (it would be unsound). The graph is a
   pluggable seam — back it with an OSS tool (dependency-cruiser/madge/ts-morph)
   via `CodeGraph.fromJSON`. The syntactic graph, incremental `update()`, and a
   debounced `createCodeGraphWatcher` are shipped.
2. **Real auth probing**: replace the credential-file/env-var heuristic with a
   cheap authenticated call per adapter to verify a token is valid/unexpired.
3. **Adapter argv fidelity**: keep the recorded conformance fixtures current as
   each agent CLI releases, and expand them to cover more event variants.

**Shipped since first cut:** bounded-parallel task execution
(`maxConcurrency`), a TTL detection cache (`detectionCacheTtlMs` +
`refreshDetection()`), `--offline`/`--agent`, a token/cost budget (`budget` /
`--max-tokens` / `--max-cost`), atomic checkpoint writes, unique run ids, **62
fixes across four adversarial-review rounds** (each finding fixed with a
regression test), **cross-run persisted knowledge** (`KnowledgeStore` /
`projectKnowledgeStore` under `.omakase/`), **structured per-criterion review**
(`acceptanceCriteria` + `parseStructuredReview`), **live MCP injection** (three
strategies via `applyMcpInjection`), **codegraph tsconfig path-alias
resolution** (`loadTsconfigAliases`), the **Supervisor daemon** (queue +
`resumeInterrupted()` + heartbeat), **skill-aware planning**, **`omakase
serve`** — a file-backed supervisor CLI (queue dir + `--watch` + resume, with
crash-recovery of claimed-but-unstarted tasks), **adapter stream-conformance
fixtures** (recorded output replayed through the parsers), a debounced
**`createCodeGraphWatcher`** for incremental codegraph updates, an **in-TUI task
composer**, and **systemd/launchd service units** under `deploy/`.
