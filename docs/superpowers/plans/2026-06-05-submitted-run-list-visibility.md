# Submitted Run List Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every TUI-submitted task visible in the underlying run store and in the runs list as soon as the daemon starts it, even if routing/planning is still slow.

**Architecture:** Persist an initial run record immediately after `run-started` so `sourceQueueFile` correlation works before router/planner completion. Add list-screen polling in the TUI so a user who backs out of a pending detail sees the newly-created run without needing to restart or re-enter the UI.

**Tech Stack:** TypeScript, Vitest, Ink TUI tests, file-backed Omakase run store.

---

### Task 1: Reproduce Missing Run Record Before Routing

**Files:**
- Modify: `packages/core/tests/orchestrator.test.ts`

- [x] **Step 1: Write the failing test**

Add a test that uses a router whose `route()` blocks. Start an orchestrator with a `MemoryRunStore`, wait until `run-started` is emitted, then assert the store already contains a run record with `metadata.sourceQueueFile`.

- [x] **Step 2: Run the test to verify RED**

Run:

```bash
pnpm --filter @omakase/core test -- orchestrator.test.ts
```

Expected before implementation: FAIL because `store.list()` is empty until routing/planning reaches the later checkpoint.

### Task 2: Persist the Initial Run Record

**Files:**
- Modify: `packages/core/src/orchestrator.ts`

- [x] **Step 1: Implement the minimal fix**

After emitting `run-started` for a non-resumed run, call the existing progress checkpoint path before detection/routing. This writes a valid empty-plan record containing the request metadata and event log.

- [x] **Step 2: Run the core targeted test to verify GREEN**

Run:

```bash
pnpm --filter @omakase/core test -- orchestrator.test.ts
```

Expected: the new early-record test passes without breaking existing orchestrator tests.

### Task 3: Reproduce Runs List Staying Stale After Backing Out

**Files:**
- Modify: `packages/cli/tests/tui.test.tsx`

- [x] **Step 1: Write the failing TUI test**

Submit a task whose token does not resolve immediately, press Escape back to the runs list, then make `client.list()` return the new run on a later call. Assert the list updates automatically.

- [x] **Step 2: Run the test to verify RED**

Run:

```bash
pnpm --filter @omakase/cli test -- tui.test.tsx
```

Expected before implementation: FAIL because the list only refreshed once on back and has no list-screen polling.

### Task 4: Poll Runs While On The Runs List

**Files:**
- Modify: `packages/cli/src/tui/App.tsx`

- [x] **Step 1: Implement list polling**

When `screen === 'list'`, poll `refreshRuns()` on a short interval so daemon-created run records appear without user input.

- [x] **Step 2: Keep pending auto-attach behavior scoped**

Leaving a pending detail with Escape may cancel auto-attach, but list polling must still reveal the run once it exists.

- [x] **Step 3: Run the CLI targeted tests to verify GREEN**

Run:

```bash
pnpm --filter @omakase/cli test -- tui.test.tsx run-client.test.ts
```

Expected: the new stale-list test passes and the existing pending auto-attach/stale-tail tests remain green.

### Task 5: Full Verification And Live Check

**Files:**
- Verify changed packages and live daemon state.

- [x] **Step 1: Run full verification**

Run:

```bash
pnpm check
```

Expected: all workspace typechecks and tests pass.

- [x] **Step 2: Restart the daemon**

Run:

```bash
scripts/omakase.sh daemon stop --cwd /Users/ben/Projects/Omakase2
scripts/omakase.sh tui --cwd /Users/ben/Projects/Omakase2
```

Expected: source-running daemon restarts with the updated code.

- [x] **Step 3: Live submit/list check**

Submit a small task through a real installed agent such as `codex`, then confirm the resulting run record appears under `.omakase/runs` and `RunControllerClient.list()` reports it.
