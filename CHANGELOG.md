# Changelog

All notable changes to Omakase are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Adapter stream-conformance fixtures (`packages/daemon/tests/fixtures/`) replayed
  through the parsers, pinning argv/stream mapping per release.
- `createCodeGraphWatcher` (`@omakase/core`): a debounced, batched driver for
  incremental `CodeGraph.update()` from any file watcher.
- In-TUI task composer: `[i]` starts a new task when idle, `[u]` types a custom
  note during a run.
- `deploy/` systemd + launchd service units for `omakase serve --watch`.
- CI (GitHub Actions), CHANGELOG, and `repository`/`homepage`/`bugs` package
  metadata.

### Fixed
- 21 findings from a fourth adversarial review round (terminal-save outcome flip,
  codex tool/reasoning double-emit, signal-death-as-completed, run-record
  validation, unguarded supervisor resume, TUI no-TTY hang, serve task-loss
  window, transitive plan blocking, and more) — each with a regression test.
- `binEnvVar` overrides that don't resolve now fail closed *and* surface a clear
  reason in `omakase agents`.

## [0.1.0]

First public cut: a complete, tested implementation of the agent runtime, the
orchestration core, and the CLI/TUI.

### `@omakase/daemon` — agent runtime (zero runtime dependencies)
- Detect installed agent CLIs (8 built-in adapters: claude, codex, pi, gemini,
  opencode, cursor-agent, qwen, copilot) with fault isolation, capability
  probing, model listing, and heuristic auth detection.
- Run any agent through one unified `AgentEvent` stream over a `Transport` seam
  (real `createNodeTransport` + a controllable fake in `@omakase/daemon/testing`),
  with stream parsers for claude-stream-json, codex-json, pi-rpc, and plain text.
- SIGTERM→SIGKILL escalation, signal-death detection, a TTL resolve cache, skill
  loading with a dependency-free frontmatter parser, and live MCP injection
  (`.mcp.json` / opencode-env-content / acp-merge).

### `@omakase/core` — multi-agent orchestration
- The Ralph loop orchestrator (router → planner → workers → reviewer → replan →
  finish) over a serializable plan graph, with bounded-parallel execution, a
  token/cost budget, hooks, and an event stream.
- Resumable runs (atomic checkpoint + `resume`) and a `Supervisor` (queue +
  `resumeInterrupted` + heartbeat) for long-running / "24-7" operation.
- Cross-run persisted knowledge (`ProjectWiki` + a syntactic `CodeGraph` with
  tsconfig path-alias resolution) under `.omakase/`, structured per-criterion
  review, and spec/TDD workflows.

### `@omakase/cli` — CLI + Ink TUI
- `omakase agents | run | tui | serve`, with `--offline` / `--agent`,
  `--max-tokens` / `--max-cost`, and `serve --watch` (file-backed supervisor
  with a queue dir and crash-recovery of claimed-but-unstarted tasks).

### Hardening
- 62 findings fixed across four adversarial multi-agent review rounds
  (14 + 16 + 11 + 21), each with a regression test, keeping
  `pnpm -r build|typecheck|test` green throughout.

<!-- Placeholder repo URL — replace `your-org` with the real GitHub owner. -->
[Unreleased]: https://github.com/your-org/omakase/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/your-org/omakase/releases/tag/v0.1.0
