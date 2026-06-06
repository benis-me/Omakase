# Knowledge Agent Pool TUI Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a product-grade project knowledge loop, clean the live agent pool, and make the run TUI navigable enough to inspect agent details.

**Architecture:** The orchestrator remains the source of truth for run, wiki, and codegraph updates. The CLI view-model folds those events into renderable knowledge/activity state, while the Ink TUI adds focus/navigation without owning run execution. Agent detection parsers must reject non-model terminal noise before policy or UI sees it.

**Tech Stack:** TypeScript ESM, Vitest, Ink, `@omakase/core`, `@omakase/daemon`, `@omakase/cli`.

---

### Task 1: Knowledge Loop and Codegraph State

**Files:**
- Modify: `packages/core/src/knowledge/wiki.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/core/src/run-events.ts`
- Modify: `packages/cli/src/view-model.ts`
- Modify: `packages/cli/src/tui/App.tsx`
- Test: `packages/core/tests/knowledge-store.test.ts`
- Test: `packages/cli/tests/view-model.test.ts`
- Test: `packages/cli/tests/tui.test.tsx`

- [x] **Step 1: Write failing knowledge tests**

Add tests that verify each agent task records a structured wiki entry with role, agent, tokens, tools, source, and the run id; verify `knowledge-updated` carries codegraph stats beyond file count. Also verify daemon/project runs auto-scan codegraph and refresh stale persisted snapshots.

- [x] **Step 2: Run focused tests**

Run:
```bash
pnpm --filter @omakase/core test -- knowledge-store.test.ts -t "knowledge"
pnpm --filter @omakase/cli test -- view-model.test.ts -t "knowledge"
```
Expected: FAIL because codegraph stats and richer run-scoped wiki metadata are not exposed.

- [x] **Step 3: Implement minimal knowledge model changes**

Add a compact codegraph summary to `knowledge-updated`, record task wiki entries with `run:<id>` tags/source metadata, auto-scan/refresh codegraph at project run start, and preserve markdown output.

- [x] **Step 4: Verify focused tests pass**

Run the same focused commands. Expected: PASS.

### Task 2: Agent Pool Noise Filtering

**Files:**
- Modify: `packages/daemon/src/runtimes/shared.ts`
- Modify: `packages/daemon/src/runtimes/defs/cursor-agent.ts`
- Modify: `packages/cli/src/render.ts`
- Modify: `packages/cli/src/tui/App.tsx`
- Test: `packages/daemon/tests/detection.test.ts`
- Test: `packages/daemon/tests/parsers.test.ts`
- Test: `packages/cli/tests/tui.test.tsx`

- [x] **Step 1: Write failing parser/detection tests**

Add tests for Cursor model output containing ANSI/art banner/login prompts; expected parsed models should fall back to `default` only or valid model ids only.

- [x] **Step 2: Run focused tests**

Run:
```bash
pnpm --filter @omakase/daemon test -- detection.test.ts -t "cursor"
```
Expected: FAIL because noisy lines become model ids.

- [x] **Step 3: Implement filtering**

Reject ANSI escape output, prompt text, lines with spaces/control glyphs, and model ids outside a conservative model-id pattern. Keep valid ids such as `gpt-5`, `gemini-2.5-pro`, and `claude-sonnet-4.5`.

- [x] **Step 4: Verify focused tests pass**

Run the focused command again. Expected: PASS.

### Task 3: Plan/Detail Focus and Agent Expansion

**Files:**
- Modify: `packages/cli/src/tui/App.tsx`
- Test: `packages/cli/tests/tui.test.tsx`

- [x] **Step 1: Write failing TUI navigation tests**

Add tests for left/right focus switching between Plan and Detail, up/down selecting agent rows when Detail is focused, and enter toggling an expanded row that shows id, role, status, agent, tokens, tools, elapsed, and title.

- [x] **Step 2: Run focused TUI tests**

Run:
```bash
pnpm --filter @omakase/cli test -- tui.test.tsx -t "focus"
```
Expected: FAIL because only Plan supports up/down selection today.

- [x] **Step 3: Implement TUI focus state**

Add `focusPane`, `selectedTask`, and `expandedTaskId` state. Use left/right arrows to switch panes, up/down to move within the focused pane, and enter to expand/collapse selected Detail rows.

- [x] **Step 4: Verify focused TUI tests pass**

Run the focused TUI command again. Expected: PASS.

### Task 4: Full Verification and Real Smoke

**Files:**
- No source files unless verification finds a defect.

- [x] **Step 1: Run full automated checks**

Run:
```bash
pnpm check
git diff --check
```
Expected: both exit 0.

- [x] **Step 2: Run real source daemon checks**

Run:
```bash
scripts/omakase.sh daemon stop --cwd /Users/ben/Projects/Omakase2
scripts/omakase.sh agents --json
scripts/omakase.sh tui --cwd /Users/ben/Projects/Omakase2 "只读验证 knowledge、agent pool、TUI focus 的当前状态；不要修改文件。"
```
Expected: agents output has no Cursor model garbage; new run appears in `.omakase/runs`, streams planner/activity, updates wiki/codegraph knowledge, and records nonzero usage for Codex-backed runs.

- [x] **Step 3: Inspect persisted artifacts**

Run:
```bash
ls -t .omakase/runs/*.json | head
jq '{status, summary, knowledge:[.events[] | select(.type=="knowledge-updated")] | length}' .omakase/runs/<latest>.json
test -s .omakase/wiki.md
```
Expected: latest run is terminal or running with live events; wiki artifacts exist and contain run/task knowledge.
