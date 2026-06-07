# Loop Completion Three Slices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the next three product gaps: planner-generated editable acceptance, a complete read-only web observation surface, and a strategy-aware long-running loop with real smoke coverage.

**Architecture:** Keep the daemon-owned run store and control files as the compatibility layer. Extend the existing planner/orchestrator/view-model surfaces instead of creating a second workflow engine; TUI and web remain clients over persisted run records. Add strategy events and tests before implementation so the loop is visible, replayable, and resumable.

**Tech Stack:** TypeScript ESM, Vitest, Ink TUI, Node HTTP dashboard, shell-based real smoke scripts, existing `@omakase/core` / `@omakase/cli` / `@omakase/daemon` package split.

---

### Task 1: Planner Criteria and TUI Control Loop

**Files:**
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/core/src/acceptance.ts`
- Modify: `packages/core/src/run-events.ts`
- Modify: `packages/cli/src/tui/App.tsx`
- Test: `packages/core/tests/orchestrator-long-running.test.ts`
- Test: `packages/cli/tests/tui.test.tsx`

- [ ] **Step 1: Write failing core tests**

Add a test proving an agent planner can return JSON object output with `tasks` and `acceptanceCriteria`, and that the run emits the generated criteria before review. Add a test proving `edit-criteria` control replaces criteria and triggers a replan.

- [ ] **Step 2: Verify red**

Run:
```bash
pnpm --filter @omakase/core test -- orchestrator-long-running control
```

Expected: FAIL because planner output currently only accepts an array and TUI-visible criteria editing is not exercised through the loop.

- [ ] **Step 3: Implement planner criteria**

Teach the planner parser to accept both legacy task arrays and `{ acceptanceCriteria, tasks }`. If user criteria are present, keep user criteria. If agent criteria are present and user criteria are absent, replace the initial fallback criteria with the planner criteria and emit `acceptance-updated`.

- [ ] **Step 4: Implement TUI gate/criteria controls**

Add compose modes for criteria editing and gate answers. In Acceptance workspace, `[e]` edits criteria as newline/semicolon separated text. In Gate workspace, `[g]` answers the newest open gate. Both commands write through `RunControllerClient` instead of mutating local UI.

- [ ] **Step 5: Verify green**

Run:
```bash
pnpm --filter @omakase/core test -- orchestrator-long-running control
pnpm --filter @omakase/cli test -- tui -t "criteria|gate"
```

Expected: PASS.

### Task 2: Complete Read-Only Web Observation Surface

**Files:**
- Modify: `packages/cli/src/read-only-server.ts`
- Test: `packages/cli/tests/read-only-server.test.ts`

- [ ] **Step 1: Write failing web tests**

Add assertions that home and APIs expose acceptance, iterations, agents, codegraph, and raw events in addition to reports/wiki/runs/activity.

- [ ] **Step 2: Verify red**

Run:
```bash
pnpm --filter @omakase/cli test -- read-only-server
```

Expected: FAIL because the dashboard currently only polls reports/runs/wiki/activity.

- [ ] **Step 3: Implement web regions and APIs**

Add `/api/acceptance`, `/api/iterations`, `/api/agents`, `/api/codegraph`, and `/api/events`. Render each as a dashboard region with client-side polling, compact cards, and no write methods.

- [ ] **Step 4: Browser verify**

Start a temporary read-only server and verify desktop/mobile page identity, nonblank content, no framework overlay, no relevant console errors, and no mobile overflow through the Browser plugin.

- [ ] **Step 5: Verify green**

Run:
```bash
pnpm --filter @omakase/cli test -- read-only-server
```

Expected: PASS.

### Task 3: Strategy Replanner Loop and Real E2E Harness

**Files:**
- Modify: `packages/core/src/run-events.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/cli/src/view-model.ts`
- Create: `scripts/smoke-real-loop.sh`
- Test: `packages/core/tests/orchestrator-long-running.test.ts`
- Test: `packages/cli/tests/view-model.test.ts`

- [ ] **Step 1: Write failing strategy tests**

Add a core test where failed criteria cause a strategy event that records failed criteria, next action, and replan reason. Add a view-model test proving strategy events appear in activity.

- [ ] **Step 2: Verify red**

Run:
```bash
pnpm --filter @omakase/core test -- orchestrator-long-running
pnpm --filter @omakase/cli test -- view-model -t strategy
```

Expected: FAIL because there is no strategy event or E2E smoke command.

- [ ] **Step 3: Implement strategy events**

Emit a replayable `strategy-updated` event after each iteration and before replan when failed or unknown criteria remain. The event must include iteration id, failed criteria, open gates, next action, and reason.

- [ ] **Step 4: Add real E2E harness**

Create `scripts/smoke-real-loop.sh` that runs a real `codex` smoke through `scripts/omakase.sh run --json`, requires planner/reporter/wiki-curator/strategy evidence in the JSON event stream, and fails loudly if only builtin/offline agents were used.

- [ ] **Step 5: Verify green**

Run:
```bash
pnpm --filter @omakase/core test -- orchestrator-long-running
pnpm --filter @omakase/cli test -- view-model -t strategy
bash scripts/smoke-real-loop.sh --dry-run
```

Expected: PASS. Dry-run validates the harness without spending model calls; final product verification runs the real smoke explicitly.

### Task 4: Full Verification and Commit

**Files:**
- No source files unless verification finds a defect.

- [ ] **Step 1: Full automated checks**

Run:
```bash
pnpm check && git diff --check
```

Expected: PASS.

- [ ] **Step 2: Real model smoke**

Run:
```bash
bash scripts/smoke-real-loop.sh
```

Expected: PASS with real `codex` planner/reporter/wiki-curator/strategy evidence.

- [ ] **Step 3: Commit**

Commit the completed slice:
```bash
git add docs/superpowers/plans/2026-06-07-loop-completion-three-slices.md packages scripts
git commit -m "feat: close loop acceptance web and strategy gaps"
```
