# Run Lifecycle Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the fatal TUI/daemon run lifecycle bugs where old cancelled tasks can restart, new tasks can be cancelled by stale control files, run details can show stale content, and phrases can leak noisy raw tool commands.

**Architecture:** Treat run identity, queue claims, control commands, and TUI attachment as separate lifecycle domains. New runs must get process-unique ids; processed queue recovery must require an explicit claim marker; control files must not be listed as runs; TUI pending and tail updates must be bound to the currently selected token/run id.

**Tech Stack:** TypeScript, Vitest, Ink TUI tests, file-backed `.omakase` run store.

---

### Task 1: Reproduce Run Id / Control / Queue Regressions

**Files:**
- Modify: `packages/core/tests/orchestrator.test.ts`
- Modify: `packages/core/tests/run-store.test.ts`
- Modify: `packages/cli/tests/serve.test.ts`

- [x] **Step 1: Add a failing test for run ids across fresh orchestrators**

Add a test that starts two fresh `Orchestrator` instances over the same store without an injected `idGenerator`, then asserts their result ids differ and both records are present in the store.

- [x] **Step 2: Add a failing test for stale control files**

Add a test that writes `run-1.control.json` with `stop`, starts a fresh file-backed orchestrator with `FileControlSource`, and asserts the new run succeeds instead of being cancelled by the stale command.

- [x] **Step 3: Add a failing test that `FileRunStore.list()` ignores `*.control.json`**

Create `run-1.json` and `run-1.control.json`, then assert list returns only `run-1`.

- [x] **Step 4: Add failing queue recovery tests**

In `packages/cli/tests/serve.test.ts`, assert a legacy `queue/processed/*.prompt` file without a claim marker is not re-ingested, while a processed file with a valid `.claim.json` marker is recovered once and then marked started once a run record exists.

- [x] **Step 5: Run the targeted tests and confirm RED**

Run:

```bash
pnpm --filter @omakase/core test -- orchestrator.test.ts run-store.test.ts
pnpm --filter @omakase/cli test -- serve.test.ts
```

Expected: the newly added tests fail for the exact lifecycle bugs.

### Task 2: Fix Backend Lifecycle Boundaries

**Files:**
- Modify: `packages/core/src/ids.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/core/src/supervisor/run-store.ts`
- Modify: `packages/cli/src/serve.ts`

- [x] **Step 1: Add a process-unique run id generator**

Expose a run-id generator that produces ids like `run-<time>-<random>-<seq>` when the caller did not inject deterministic ids. Keep `createIdGenerator()` unchanged for tests that intentionally inject deterministic ids.

- [x] **Step 2: Use the unique generator for new run ids only**

In `Orchestrator`, use the new generator for the top-level run id sequence when `options.idGenerator` is absent. Keep per-run task ids deterministic inside each run.

- [x] **Step 3: Keep control files out of run listings**

Update `FileRunStore.list()` to ignore `.control.json` and temp files so the client never treats control metadata as a run candidate.

- [x] **Step 4: Add claim markers to queue processing**

When claiming a queue file, write `processed/<filename>.claim.json` with `state: "claimed"` before moving the prompt to `processed/`.

- [x] **Step 5: Recover only explicit claimed files**

Change `recoverClaimed()` so legacy processed files without claim markers are ignored. If a matching run record exists, mark the claim `state: "started"` and do not recover it again.

- [x] **Step 6: Run targeted backend tests and confirm GREEN**

Run:

```bash
pnpm --filter @omakase/core test -- orchestrator.test.ts run-store.test.ts control.test.ts
pnpm --filter @omakase/cli test -- serve.test.ts run-client.test.ts
```

Expected: all targeted backend lifecycle tests pass.

### Task 3: Reproduce TUI Stale Attachment / Phrase Noise Bugs

**Files:**
- Modify: `packages/cli/tests/tui.test.tsx`
- Modify: `packages/cli/tests/view-model.test.ts`

- [x] **Step 1: Add a failing stale-tail test**

Render the TUI, attach to one run, go back, attach to another run, then invoke the first run's saved tail callback. Assert the UI still shows the second run.

- [x] **Step 2: Add a failing pending-token continuation test**

Submit a task whose `resolveRunId()` does not resolve immediately, assert the pending detail remains visible, then later resolve the token and assert the TUI attaches to the new run without requiring Esc/back/re-enter.

- [x] **Step 3: Add a failing phrase sanitization test**

Fold an `agent-event` tool call whose name is a raw shell command and assert phrases do not include `/bin/zsh` or the command body, while the task tool count still increments.

- [x] **Step 4: Run targeted TUI tests and confirm RED**

Run:

```bash
pnpm --filter @omakase/cli test -- tui.test.tsx view-model.test.ts
```

Expected: the newly added tests fail for stale attachment, pending resolution, and raw tool phrase noise.

### Task 4: Fix TUI Attachment and Phrase Rendering

**Files:**
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/src/view-model.ts`

- [x] **Step 1: Track the active attached run id in a ref**

Mirror `attachedId` into `attachedIdRef` and ignore tail callbacks whose view `runId` does not match the currently attached id.

- [x] **Step 2: Track the active pending token in a ref**

When submitting a new task, set `pendingTokenRef` to the returned token. Continue resolving that token in the background and attach only if it is still the active pending token.

- [x] **Step 3: Clear stale detail state on every attach/back transition**

Set `view` to null when attaching to a concrete run and clear `pendingTokenRef` when the user backs out, so stale details cannot remain on screen.

- [x] **Step 4: Sanitize tool phrase labels**

Render tool phrases as compact tool names only. If the parsed name looks like a raw command path or a long command string, display `tool` instead of the command.

- [x] **Step 5: Run targeted CLI tests and confirm GREEN**

Run:

```bash
pnpm --filter @omakase/cli test -- tui.test.tsx view-model.test.ts run-client.test.ts serve.test.ts
```

Expected: all targeted CLI tests pass.

### Task 5: Full Verification

**Files:**
- Verify all changed packages.

- [x] **Step 1: Run full package checks**

Run:

```bash
pnpm --filter @omakase/core typecheck
pnpm --filter @omakase/cli typecheck
pnpm --filter @omakase/daemon typecheck
pnpm check
```

Expected: all typechecks and tests pass.

- [x] **Step 2: Inspect live `.omakase` state**

Confirm `.omakase/runs/*.json` no longer implies a new daemon will reuse `run-1`, and legacy processed queue files without claim markers are not candidates for recovery.

- [x] **Step 3: Report remaining live-verification gap if any**

If an interactive TUI run is not executed in this session, explicitly say code and tests are green but the live terminal surface still needs one manual/PTY pass.
