# Omakase — project iteration + Electron desktop app (shared spec)

You are working inside the Omakase monorepo at `/Users/ben/Projects/Omakase2`:
a pnpm + TypeScript (ESM, NodeNext, `.js` specifiers) workspace with three
packages — `@omakase/daemon` (agent runtime, zero deps), `@omakase/core`
(Ralph-loop orchestrator + resumable supervisor + knowledge), and `@omakase/cli`
(Ink TUI + `agents`/`run`/`tui`/`serve`). **Read `README.md`,
`docs/architecture.md`, `docs/runtime-contract.md`, and `docs/roadmap.md` before
writing any code.** The project's bar is publishable open-source quality — never
MVP/stub; every feature must be complete, tested, and usable.

## Division of labor (STRICT)

- **LOGIC agent (codex):** everything Node / main-process / business logic —
  orchestration wiring, IPC, persistence, build & packaging, and the backend
  roadmap items. Owns the Electron **main process + preload + the shared IPC
  contract**. Do NOT hand-craft renderer styling; leave a minimal placeholder UI
  and define a clean, typed IPC surface for the VISUAL agent.
- **VISUAL agent (claude):** the entire Electron **renderer UI** — components,
  layout, design system, theming, interactions, accessibility, polish. Build
  strictly against the typed IPC contract in `packages/desktop/src/shared/`; do
  NOT change main-process logic.

## Workstream A — keep iterating & hardening the existing project

From `docs/roadmap.md` → "Planned enhancements", highest-value first:
- **Real auth probing**: replace the credential-file/env heuristic with a cheap
  authenticated check per adapter, behind the existing `auth` seam in the
  runtime defs. Keep tests model-free (fake transport).
- **Codegraph semantic depth via an OSS tool**: implement a real adapter that
  feeds dependency-cruiser/madge/ts-morph output into `CodeGraph.fromJSON`
  (symbol/call edges), with a worked example + tests. Do NOT hand-roll an
  unsound regex call graph.
- Keep the adapter **conformance fixtures** current; expand event-variant
  coverage.

Follow the established rhythm: small vertical slices, a regression test per
change, `pnpm -r build|typecheck|test` green, conventional commits.

## Workstream B — a highly-usable Electron desktop app (`@omakase/desktop`)

A polished desktop GUI for everything the CLI/TUI does, built on the SAME core
(never reaching around it). Add `packages/desktop` to the workspace.

Architecture — Electron with `contextIsolation: true`, `nodeIntegration: false`:
- **`main/` (Node — LOGIC):** host `createAgentRuntime()` + `Orchestrator` /
  `Supervisor` from `@omakase/core` + `@omakase/daemon` directly; manage windows
  & lifecycle; persist via `FileRunStore` + `projectKnowledgeStore` under the
  selected project's `.omakase/`; stream `OrchestratorEvent`s to the renderer.
- **`preload/` (LOGIC):** `contextBridge` exposes ONLY the typed API from
  `src/shared/` — no raw `ipcRenderer`, no Node globals in the renderer.
- **`shared/` (LOGIC defines, both consume):** the IPC contract — request/
  response types + the per-run event channel — reusing `@omakase/core` types
  (`OrchestrationRequest`, `OrchestratorEvent`, `RunStatus`, …) and
  `DetectedAgent` so there is ONE source of truth.
- **`renderer/` (React + Vite — VISUAL):** the app UI. Fold the streamed events
  into a view-model using the project's existing `RunView` reducer
  (`reduceRunView`). It currently lives in `@omakase/cli`; if importing it into
  the browser bundle pulls Node-only deps (ink), the LOGIC agent extracts that
  reducer into a shared, dependency-free module so both the Ink TUI and the
  renderer consume it — never re-implement run-state logic in the renderer.

Renderer features (VISUAL — genuinely usable, not stubs):
1. **Project picker** — choose a working dir; show detected agents (id, status,
   version, auth, model count) including the `unavailableReason` for absent ones.
2. **Run launcher** — prompt editor; mode (normal/max-power/custom); agent
   override; token/cost budget; start / cancel / pause / resume; append mid-run
   input.
3. **Live run view** — the task-graph DAG with per-task status, the event
   stream, the route decision, knowledge counts, the latest review verdict, and
   spend — all updating live.
4. **Knowledge browser** — render the project wiki (facts/decisions/risks/tasks)
   and codegraph stats for the selected project.
5. **Serve/queue manager** — view & enqueue queue files; show supervisor health
   (queued/active/completed); resume interrupted runs.
6. **Settings** — default mode/agent/budget, runs/queue dirs; persisted.

Design: clean, modern, responsive; light/dark theme; keyboard navigable;
accessible (ARIA); smooth status transitions.

Minimum IPC surface (LOGIC owns):
- `agents.list(cwd) -> DetectedAgent[]`
- `runs.start(req) -> runId`; `runs.cancel|pause|resume(runId)`;
  `runs.appendInput(runId, text)`
- per-run **events** channel: `OrchestratorEvent` stream (renderer folds via the
  shared `reduceRunView`)
- `knowledge.wiki(cwd)` / `knowledge.codegraph(cwd)`
- `serve.health()` / `serve.enqueue(cwd, text)` / `serve.resumeInterrupted(cwd)`
- `settings.get()` / `settings.set(patch)`

## Engineering rules (non-negotiable)

- TypeScript strict, ESM, NodeNext, `.js` import specifiers; match the existing
  two-tsconfig (paths→src for typecheck, no-paths build→dist) + vitest-alias
  setup; register `@omakase/desktop` in `pnpm-workspace.yaml`.
- **No real model calls in tests.** Main-process logic: fake transport +
  `createScriptedAgent`. Renderer: `@testing-library/react` against a mock IPC.
  Optional Playwright-for-Electron smoke.
- Keep `pnpm -r build && pnpm -r typecheck && pnpm -r test` green at EVERY
  commit. Library-first: the desktop app is a consumer of core, not a fork.
- `electron-builder` packaging for mac/win/linux, added incrementally.

## Acceptance

- `@omakase/desktop` builds, typechecks, and tests green in the workspace; all
  existing tests still pass.
- `pnpm --filter @omakase/desktop dev` launches the app; you can pick a project,
  see detected agents, start an **offline** run (`--offline`/builtin agent), and
  watch the task graph + event stream update live to a terminal status.
- The renderer folds events through the SHARED `reduceRunView` (no duplicated
  run-state logic).
- New code has tests; docs updated (README + `docs/desktop.md` + roadmap).

## Method

Vertical slices, each independently green and committed. Order: (1) LOGIC
scaffolds `@omakase/desktop` (main + preload + `src/shared/` IPC contract) and
drives one offline run end-to-end headlessly with tests; (2) VISUAL builds a thin
renderer that lists agents and runs one offline task live; (3) deepen feature by
feature. Record decisions in the project wiki.
