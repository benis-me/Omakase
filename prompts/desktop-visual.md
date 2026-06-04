# VISUAL pass (run with: omakase run "$(cat prompts/desktop-visual.md)" --agent claude)

Read `prompts/desktop-spec.md` first and follow it. You are the **VISUAL agent**.

Build the Electron **renderer** (React + Vite) against the typed IPC contract the
LOGIC pass defined in `packages/desktop/src/shared/`. Do NOT modify main-process
logic — consume ONLY the exposed typed API. Work in small committed slices that
each keep `pnpm -r build|typecheck|test` green.

Deliver a clean, modern, accessible, light/dark, keyboard-navigable UI:
1. Project picker + agents dashboard (status, version, auth, model count, and the
   `unavailableReason` for absent agents).
2. Run launcher — prompt editor, mode, agent override, token/cost budget; start /
   cancel / pause / resume; append mid-run input.
3. Live run view — the task-graph DAG with per-task status, the event stream, the
   route decision, knowledge counts, the latest review verdict, and spend. Fold
   the streamed events with the SHARED `reduceRunView` — do NOT re-implement
   run-state logic.
4. Knowledge browser (wiki + codegraph stats), serve/queue manager (health +
   enqueue + resume), and a settings screen.

Establish a small design system (tokens, spacing, typography, components) and
keep it consistent. Test components with `@testing-library/react` against a mock
of the IPC API (no Electron, no real models). Commit per slice with conventional
messages.
