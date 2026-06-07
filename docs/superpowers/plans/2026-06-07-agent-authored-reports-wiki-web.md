# Agent Authored Reports Wiki Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reports and wiki content authored by out-of-band agents, keep them outside the task graph, and replace the read-only web page with a richer no-flicker dashboard.

**Architecture:** The orchestrator keeps the task graph limited to planner/worker/reviewer work. New out-of-band reporter and wiki-curator agent calls run from orchestration milestones, stream as `agent-event` roles, and emit artifacts/events without adding plan tasks. The CLI read-only server serves a client-rendered dashboard that polls JSON APIs and updates DOM state without full-page refresh.

**Tech Stack:** TypeScript ESM, Vitest, Ink view-model, Node HTTP server, daemon AgentRuntime streaming events, code-native HTML/CSS/JS dashboard.

---

### Task 1: Out-of-Band Reporter Agent

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/core/src/reports.ts`
- Modify: `packages/core/src/run-events.ts`
- Test: `packages/core/tests/orchestrator-long-running.test.ts`
- Test: `packages/core/tests/reports.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving planning/review reports are produced by `reporter` agent stream events, include `authorAgentId`, and do not add reporter tasks to `plan.tasks`.

- [ ] **Step 2: Verify red**

Run:
```bash
pnpm --filter @omakase/core test -- orchestrator-long-running reports
```
Expected: FAIL because reports are currently synthesized synchronously and `AgentRole` has no `reporter`.

- [ ] **Step 3: Implement reporter role**

Add `reporter` to agent roles, add report author metadata, and replace synchronous report markdown generation with an out-of-band agent call that receives run state and returns markdown. Fall back to the current deterministic summary only if the reporter agent call fails.

- [ ] **Step 4: Verify green**

Run the same focused command. Expected: PASS.

### Task 2: Agent-Written Wiki Synthesis

**Files:**
- Modify: `packages/core/src/knowledge/events.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/core/src/run-events.ts`
- Test: `packages/core/tests/orchestrator-long-running.test.ts`
- Test: `packages/core/tests/knowledge-events.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving a `wiki-curator` agent authors a durable project knowledge entry after task/report milestones, that the entry body is synthesis content rather than a raw status line, and that no wiki-curator task appears in the plan graph.

- [ ] **Step 2: Verify red**

Run:
```bash
pnpm --filter @omakase/core test -- orchestrator-long-running knowledge-events
```
Expected: FAIL because current wiki content is structured log-derived.

- [ ] **Step 3: Implement wiki curator**

Add a knowledge event kind/source for agent synthesis, run the curator out-of-band after reports and at terminal run completion, and persist the authored wiki entry through the existing knowledge store.

- [ ] **Step 4: Verify green**

Run the same focused command. Expected: PASS.

### Task 3: TUI Source Visibility

**Files:**
- Modify: `packages/cli/src/view-model.ts`
- Modify: `packages/cli/src/tui/App.tsx`
- Test: `packages/cli/tests/view-model.test.ts`
- Test: `packages/cli/tests/tui.test.tsx`

- [ ] **Step 1: Write failing tests**

Add tests proving planner, reporter, and wiki-curator activity appears as separate phrases/activity, Reports workspace shows the author agent, and Plan workspace only shows plan tasks.

- [ ] **Step 2: Verify red**

Run:
```bash
pnpm --filter @omakase/cli test -- view-model tui
```
Expected: FAIL before the new role/artifact fields are folded.

- [ ] **Step 3: Implement TUI display updates**

Fold reporter/wiki-curator events into phrases, show report author/source in Reports, show knowledge synthesis in Knowledge, and keep plan grouping task-only.

- [ ] **Step 4: Verify green**

Run the same focused command. Expected: PASS.

### Task 4: No-Flicker Visual Web Dashboard

**Files:**
- Modify: `packages/cli/src/read-only-server.ts`
- Test: `packages/cli/tests/read-only-server.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving the home page has a styled app shell, client-side polling script, no meta refresh, and separate API-backed regions for reports, wiki, runs, and activity.

- [ ] **Step 2: Verify red**

Run:
```bash
pnpm --filter @omakase/cli test -- read-only-server
```
Expected: FAIL because current page is mostly static and refreshes by meta tag.

- [ ] **Step 3: Implement dashboard template**

Replace meta refresh with `fetch()` polling, render stronger visual CSS, expose `/api/runs`, `/api/activity`, and keep all mutations rejected.

- [ ] **Step 4: Verify green**

Run the focused command. Expected: PASS.

### Task 5: Full Real Verification

**Files:**
- No source files unless verification finds a defect.

- [ ] **Step 1: Run automated checks**

Run:
```bash
pnpm check
git diff --check
```
Expected: PASS.

- [ ] **Step 2: Run real agent smoke**

Run:
```bash
scripts/omakase.sh tui --cwd /Users/ben/Projects/Omakase2 --agent codex "真实 Reporter/Wiki 烟测：生成 plan、完成一个只读项目知识库摘要、触发 reporter 和 wiki-curator；不要修改文件。"
```
Expected: terminal run has `reporter` and `wiki-curator` agent events, reports with author metadata, knowledge synthesis, and no reporter/wiki-curator plan tasks.

- [ ] **Step 3: Verify web rendering**

Open the TUI web URL or start a test read-only server, capture a rendered screenshot, and verify the page updates without full-page flicker.
