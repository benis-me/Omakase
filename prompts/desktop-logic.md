# LOGIC pass (run with: omakase run "$(cat prompts/desktop-logic.md)" --agent codex)

Read `prompts/desktop-spec.md` first and follow it. You are the **LOGIC agent**.

This pass owns the Node / main-process side. Do, in order, as small committed
slices that each keep `pnpm -r build|typecheck|test` green:

1. Scaffold `packages/desktop` and register it in `pnpm-workspace.yaml`: an
   Electron app with `main/`, `preload/`, and `shared/`, matching the repo's
   two-tsconfig + ESM conventions. Wire `createAgentRuntime()` +
   `Orchestrator`/`Supervisor` from `@omakase/core` + `@omakase/daemon` in the
   main process, persisting via `FileRunStore` + `projectKnowledgeStore` under
   the selected project's `.omakase/`.
2. Define the FULL typed IPC contract in `packages/desktop/src/shared/` (the
   surface listed in the spec), reusing `@omakase/core` + `DetectedAgent` types,
   and implement it in the main process + a secure `preload` (`contextIsolation`
   on, `nodeIntegration` off, no raw `ipcRenderer` leaked). Stream per-run
   `OrchestratorEvent`s to the renderer.
3. If reusing `@omakase/cli`'s `reduceRunView` in the renderer would pull
   Node-only deps, extract that reducer + its types into a shared,
   dependency-free module both the Ink TUI and the renderer import.
4. Leave the renderer a minimal placeholder (a single window that lists agents
   and can start one offline run) for the VISUAL agent to build out.
5. Advance ONE Workstream-A roadmap item — start with **real auth probing** or
   **codegraph semantic depth via an OSS tool** (per the spec).

Test main-process logic headlessly with the fake transport + `createScriptedAgent`
(no real models). Do NOT design renderer styling — that's the VISUAL agent's job.
Commit per slice with conventional messages.
