# Real TUI / Daemon / Wiki Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TUI submissions, planner output, run phases, agent stats, selected main-agent persistence, stop status, and project wiki updates reflect real daemon/orchestrator state.

**Architecture:** Keep the TUI as a file-backed daemon client. Fix the source of truth in the orchestrator event stream and run-store checkpoints, then make the TUI render pending/planner/runtime state from that stream. Persist project-level TUI preferences and render the persisted wiki as both JSON and Markdown.

**Tech Stack:** TypeScript, pnpm, Vitest, Ink React TUI, `@omakase/core`, `@omakase/daemon`, file-backed `.omakase` state.

---

### Task 1: Streaming Run State

**Files:**
- Modify: `packages/core/src/run-events.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/cli/src/view-model.ts`
- Test: `packages/core/tests/orchestrator.test.ts`
- Test: `packages/cli/tests/run-client.test.ts`

- [x] **Step 1: Write failing tests**

```ts
// packages/core/tests/orchestrator.test.ts
it('checkpoints streaming agent events while a task is still running', async () => {
  const store = new MemoryRunStore();
  let release!: () => void;
  const blocker = new Promise<void>((r) => (release = r));
  const exec = createScriptedAgent(async function* () {
    yield { type: 'text_delta', delta: 'working' };
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } };
    await blocker;
    yield { type: 'text_delta', delta: 'done' };
  });
  const runtime = createAgentRuntime({ executors: { scripted: exec }, now: () => 0 });
  const orch = new Orchestrator({ ...baseOptions(runtime, new RulePlanner()), store });
  const handle = orch.start({ prompt: '- long task' });
  const id = await waitFor(async () => (await store.list())[0]);
  const mid = await waitFor(async () => {
    const rec = await store.load(id);
    return rec?.events.some((e) => e.type === 'agent-event') ? rec : undefined;
  });
  expect(mid.events.some((e) => e.type === 'agent-event')).toBe(true);
  release();
  await handle.result;
});

// packages/cli/tests/run-client.test.ts
it('folds live usage and task elapsed from persisted streaming checkpoints', async () => {
  const view = await client.snapshot(id);
  expect(view?.tasks[0]?.tokens).toBe(7);
  expect(view?.tasks[0]?.startedAt).toBeTypeOf('number');
});
```

- [x] **Step 2: Run tests to verify red**

Run:

```bash
pnpm --filter @omakase/core test -- orchestrator.test.ts
pnpm --filter @omakase/cli test -- run-client.test.ts
```

Expected: FAIL because streaming `agent-event` entries are not persisted until a task finishes and `task-status` has no timestamp.

- [x] **Step 3: Implement minimal fix**

Add optional `at` to `task-status`, emit it from `attachGraphListener`, use it in `reduceRunView`, and checkpoint progress after every persisted `agent-event` while a run is active.

- [x] **Step 4: Verify green**

Run the same two commands. Expected: PASS.

### Task 2: Real Planner Phrases

**Files:**
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/cli/src/view-model.ts`
- Modify: `packages/cli/src/tui/App.tsx`
- Test: `packages/core/tests/orchestrator.test.ts`
- Test: `packages/cli/tests/tui.test.tsx`

- [x] **Step 1: Write failing tests**

```ts
it('uses an agent-backed planner by default and streams planner events before planned', async () => {
  const events = await collect(new Orchestrator({
    runtime,
    router: complexRouter,
    policy: customPolicy,
    store: new MemoryRunStore(),
    clock: () => 0,
    detectionOptions,
  }).start({ prompt: 'build a real feature' }));
  const plannerIdx = events.findIndex((e) => e.type === 'agent-event' && e.role === 'planner');
  const plannedIdx = events.findIndex((e) => e.type === 'planned');
  expect(plannerIdx).toBeGreaterThan(-1);
  expect(plannerIdx).toBeLessThan(plannedIdx);
});
```

- [x] **Step 2: Run tests to verify red**

Expected: FAIL because the default planner is `RulePlanner` and emits no planner events.

- [x] **Step 3: Implement minimal fix**

When no planner is injected, select the policy's `planner` assignment. If it is not `builtin`, stream the planner agent with JSON-plan instructions, emit `agent-event` entries with `role: 'planner'` and `taskId: null`, accumulate text, parse the JSON array, and fall back to `RulePlanner` if parsing fails.

- [x] **Step 4: Verify green**

Run core and TUI tests. Expected: PASS.

### Task 3: TUI Submission / Stop / Preference UX

**Files:**
- Create: `packages/cli/src/tui/preferences.ts`
- Modify: `packages/cli/src/tui/App.tsx`
- Test: `packages/cli/tests/tui.test.tsx`

- [x] **Step 1: Write failing tests**

```ts
it('shows a pending run immediately after submitting a new task', async () => {
  const client = fakeClient({ resolveRunId: vi.fn(async () => null) });
  const { stdin, lastFrame } = render(<App client={client} cwd="/p" mode="normal" />);
  stdin.write('i');
  stdin.write('ship it');
  stdin.write('\r');
  await tick(20);
  expect(lastFrame()).toContain('ship it');
  expect(lastFrame()).toContain('pending');
});

it('persists the selected main agent per project', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-tui-prefs-'));
  const first = render(<App client={client} cwd={cwd} mode="normal" detect={async () => TWO_AGENTS} />);
  first.stdin.write('a');
  await tick(20);
  first.unmount();
  const second = render(<App client={client} cwd={cwd} mode="normal" detect={async () => TWO_AGENTS} />);
  await tick(20);
  expect(second.lastFrame()).toContain('main agent: codex');
});
```

- [x] **Step 2: Run tests to verify red**

Expected: FAIL because the UI waits for a daemon-created run id before entering run view and selected agent is in memory only.

- [x] **Step 3: Implement minimal fix**

Load/save `.omakase/tui-preferences.json`, enter a pending run view immediately after queue submission, refresh runs when a run attaches or tails, and clear stale `stopping...` / `pausing...` notices when the view reaches terminal/paused/running states.

- [x] **Step 4: Verify green**

Run:

```bash
pnpm --filter @omakase/cli test -- tui.test.tsx
```

Expected: PASS.

### Task 4: Project Wiki Markdown

**Files:**
- Modify: `packages/core/src/knowledge/wiki.ts`
- Modify: `packages/core/src/knowledge/store.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Test: `packages/core/tests/wiki.test.ts`
- Test: `packages/core/tests/knowledge-store.test.ts`

- [x] **Step 1: Write failing tests**

```ts
it('writes a human-readable wiki.md beside wiki.json', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-wiki-md-'));
  const store = new FileKnowledgeStore(dir);
  await store.mergeWiki([entry('wiki-1', 'Uses pnpm')]);
  expect(readFileSync(path.join(dir, 'wiki.md'), 'utf8')).toContain('Uses pnpm');
});
```

- [x] **Step 2: Run tests to verify red**

Expected: FAIL because only `wiki.json` exists.

- [x] **Step 3: Implement minimal fix**

Render `wiki.md` on every wiki save/merge and enrich task wiki entries with role, agent id, usage, tool count, and summary so the project knowledge base is useful to humans and future agents.

- [x] **Step 4: Verify green**

Run core wiki/knowledge tests. Expected: PASS.

### Task 5: Full Verification

**Files:**
- All modified files.

- [x] **Step 1: Typecheck**

```bash
pnpm --filter @omakase/core typecheck
pnpm --filter @omakase/cli typecheck
```

- [x] **Step 2: Test**

```bash
pnpm --filter @omakase/core test
pnpm --filter @omakase/cli test
pnpm --filter @omakase/daemon test
```

- [x] **Step 3: Final status**

Confirm `git status --short --branch`, summarize the behavior changes, and keep Desktop work isolated on `codex/desktop-client-snapshot`.
