# Long-Running Multi-Agent Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the long-running multi-agent loop described in `docs/superpowers/specs/2026-06-07-long-running-multi-agent-knowledge-design.md`.

**Architecture:** Extend the existing Orchestrator event stream and run record instead of creating a separate workflow engine. Acceptance criteria, iterations, risk gates, reports, and structured knowledge become replayable state folded by the CLI view-model. TUI and read-only web display derive from the same persisted `.omakase` data.

**Tech Stack:** TypeScript ESM, Vitest, Ink React TUI, Node `http`, `@omakase/core`, `@omakase/daemon`, `@omakase/cli`.

---

## File Structure

- Create `packages/core/src/acceptance.ts`: acceptance criterion types, generation, review application, progress helpers.
- Create `packages/core/src/iterations.ts`: iteration snapshot types and transition helpers.
- Create `packages/core/src/reports.ts`: report artifact types and reporter trigger helpers.
- Create `packages/core/src/knowledge/events.ts`: structured knowledge event types and markdown/wiki bridge helpers.
- Modify `packages/core/src/run-events.ts`: add acceptance, iteration, gate, report, and knowledge event variants.
- Modify `packages/core/src/supervisor/run-store.ts`: persist optional `acceptance`, `iterations`, `riskGates`, `reports`, and `knowledgeEvents` with backward-compatible validation.
- Modify `packages/core/src/orchestrator.ts`: generate acceptance, track iterations, evaluate reviewer output against criteria, replan until criteria pass, emit new state events.
- Modify `packages/core/src/types.ts`: add request metadata shape only if needed for budgets and user-provided criteria.
- Modify `packages/cli/src/view-model.ts`: fold acceptance, iterations, risk gates, reports, knowledge events into `RunView`.
- Modify `packages/cli/src/tui/App.tsx`: add workspaces for Acceptance, Knowledge, Reports, and Gate.
- Create `packages/cli/src/read-only-server.ts`: local read-only HTTP server over run records and wiki/codegraph files.
- Modify `packages/cli/src/cli.ts` and `packages/cli/src/tui/index.ts`: start/stop the server with `omakase tui` and pass URL into the TUI.
- Tests: add focused unit tests in `packages/core/tests/acceptance.test.ts`, `packages/core/tests/iterations.test.ts`, `packages/core/tests/orchestrator-long-running.test.ts`, `packages/cli/tests/view-model.test.ts`, `packages/cli/tests/tui.test.tsx`, and `packages/cli/tests/read-only-server.test.ts`.

---

### Task 1: Acceptance and Iteration Core

**Files:**
- Create: `packages/core/src/acceptance.ts`
- Create: `packages/core/src/iterations.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/run-events.ts`
- Modify: `packages/core/src/supervisor/run-store.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Test: `packages/core/tests/acceptance.test.ts`
- Test: `packages/core/tests/iterations.test.ts`
- Test: `packages/core/tests/orchestrator-long-running.test.ts`

- [ ] **Step 1: Write failing acceptance helper tests**

Create `packages/core/tests/acceptance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  acceptanceProgress,
  applyStructuredReview,
  createAcceptanceCriteria,
} from '../src/acceptance.js';

describe('acceptance criteria', () => {
  it('creates durable editable criteria from explicit request criteria', () => {
    let seq = 0;
    const criteria = createAcceptanceCriteria({
      prompt: 'build a parser',
      rawCriteria: ['parses CSV input', 'has tests'],
      clock: () => 123,
      nextId: (prefix) => `${prefix}-${++seq}`,
    });

    expect(criteria).toEqual([
      {
        id: 'criterion-1',
        title: 'parses CSV input',
        description: 'parses CSV input',
        status: 'pending',
        evidence: [],
        source: 'planner',
        createdAt: 123,
        updatedAt: 123,
      },
      {
        id: 'criterion-2',
        title: 'has tests',
        description: 'has tests',
        status: 'pending',
        evidence: [],
        source: 'planner',
        createdAt: 123,
        updatedAt: 123,
      },
    ]);
  });

  it('falls back to a single product-completion criterion when none are provided', () => {
    const criteria = createAcceptanceCriteria({
      prompt: 'ship the feature',
      rawCriteria: [],
      clock: () => 5,
      nextId: (prefix) => `${prefix}-fallback`,
    });

    expect(criteria).toHaveLength(1);
    expect(criteria[0]).toMatchObject({
      id: 'criterion-fallback',
      title: 'Complete requested work',
      description: 'ship the feature',
      status: 'pending',
      source: 'planner',
    });
  });

  it('updates criterion status and progress from reviewer verdicts', () => {
    let seq = 0;
    const base = createAcceptanceCriteria({
      prompt: 'build',
      rawCriteria: ['works', 'tested'],
      clock: () => 0,
      nextId: (prefix) => `${prefix}-${++seq}`,
    });
    const updated = applyStructuredReview(base, [
      { criterion: 'works', met: true, note: 'manual smoke passed' },
      { criterion: 'tested', met: false, note: 'missing regression test' },
    ], { clock: () => 10, taskId: 'review-1' });

    expect(updated.map((c) => c.status)).toEqual(['pass', 'fail']);
    expect(updated[0]?.evidence[0]).toMatchObject({ text: 'manual smoke passed', taskId: 'review-1' });
    expect(acceptanceProgress(updated)).toEqual({ passed: 1, total: 2, complete: false });
  });
});
```

Run:

```bash
pnpm --filter @omakase/core test -- acceptance.test.ts
```

Expected: FAIL because `../src/acceptance.js` does not exist.

- [ ] **Step 2: Implement acceptance helpers**

Create `packages/core/src/acceptance.ts` with:

```ts
import type { ReviewCriterion } from './run-events.js';

export type AcceptanceStatus = 'pending' | 'pass' | 'fail' | 'unknown' | 'needs-user';
export type AcceptanceSource = 'planner' | 'user' | 'reviewer' | 'replan';

export interface AcceptanceEvidence {
  text: string;
  taskId?: string;
  reportId?: string;
  wikiEntryId?: string;
  eventId?: string;
  createdAt: number;
}

export interface AcceptanceCriterion {
  id: string;
  title: string;
  description: string;
  status: AcceptanceStatus;
  evidence: AcceptanceEvidence[];
  source: AcceptanceSource;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAcceptanceInput {
  prompt: string;
  rawCriteria?: readonly string[];
  clock: () => number;
  nextId: (prefix: string) => string;
}

export function createAcceptanceCriteria(input: CreateAcceptanceInput): AcceptanceCriterion[] {
  const now = input.clock();
  const raw = (input.rawCriteria ?? []).map((c) => c.trim()).filter(Boolean);
  const items = raw.length > 0 ? raw : ['Complete requested work'];
  return items.map((criterion) => ({
    id: input.nextId('criterion'),
    title: criterion,
    description: raw.length > 0 ? criterion : input.prompt,
    status: 'pending',
    evidence: [],
    source: 'planner',
    createdAt: now,
    updatedAt: now,
  }));
}

export function applyStructuredReview(
  criteria: readonly AcceptanceCriterion[],
  verdicts: readonly ReviewCriterion[],
  options: { clock: () => number; taskId?: string },
): AcceptanceCriterion[] {
  const now = options.clock();
  return criteria.map((criterion, index) => {
    const verdict = verdicts[index];
    if (!verdict) return { ...criterion, status: 'unknown', updatedAt: now };
    const note = verdict.note?.trim();
    return {
      ...criterion,
      status: verdict.met ? 'pass' : 'fail',
      evidence: note
        ? [...criterion.evidence, { text: note, taskId: options.taskId, createdAt: now }]
        : criterion.evidence,
      updatedAt: now,
    };
  });
}

export function acceptanceProgress(criteria: readonly AcceptanceCriterion[]): {
  passed: number;
  total: number;
  complete: boolean;
} {
  const total = criteria.length;
  const passed = criteria.filter((c) => c.status === 'pass').length;
  return { passed, total, complete: total > 0 && passed === total };
}
```

Export the new types/functions from `packages/core/src/index.ts`.

- [ ] **Step 3: Run acceptance helper tests**

Run:

```bash
pnpm --filter @omakase/core test -- acceptance.test.ts
```

Expected: PASS.

- [ ] **Step 4: Write failing iteration helper tests**

Create `packages/core/tests/iterations.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createIteration, finishIteration } from '../src/iterations.js';

describe('iterations', () => {
  it('creates and finishes durable iteration snapshots', () => {
    const iteration = createIteration({
      index: 1,
      reason: 'initial-plan',
      taskIds: ['task-1', 'task-2'],
      clock: () => 10,
      nextId: (prefix) => `${prefix}-1`,
    });

    expect(iteration).toMatchObject({
      id: 'iteration-1',
      index: 1,
      status: 'running',
      reason: 'initial-plan',
      taskIds: ['task-1', 'task-2'],
      startedAt: 10,
      finishedAt: null,
    });

    expect(finishIteration(iteration, {
      status: 'complete',
      reviewSummary: 'all criteria passed',
      failedCriteria: [],
      nextStrategy: 'finish',
      clock: () => 20,
    })).toMatchObject({
      status: 'complete',
      reviewSummary: 'all criteria passed',
      nextStrategy: 'finish',
      finishedAt: 20,
    });
  });
});
```

Run:

```bash
pnpm --filter @omakase/core test -- iterations.test.ts
```

Expected: FAIL because `../src/iterations.js` does not exist.

- [ ] **Step 5: Implement iteration helpers**

Create `packages/core/src/iterations.ts` with:

```ts
export type IterationStatus =
  | 'planning'
  | 'running'
  | 'reviewing'
  | 'replanning'
  | 'waiting-for-user'
  | 'complete';

export interface IterationSnapshot {
  id: string;
  index: number;
  status: IterationStatus;
  reason: string;
  taskIds: string[];
  reviewSummary: string | null;
  failedCriteria: string[];
  nextStrategy: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export function createIteration(input: {
  index: number;
  reason: string;
  taskIds: readonly string[];
  clock: () => number;
  nextId: (prefix: string) => string;
}): IterationSnapshot {
  return {
    id: input.nextId('iteration'),
    index: input.index,
    status: 'running',
    reason: input.reason,
    taskIds: [...input.taskIds],
    reviewSummary: null,
    failedCriteria: [],
    nextStrategy: null,
    startedAt: input.clock(),
    finishedAt: null,
  };
}

export function finishIteration(
  iteration: IterationSnapshot,
  patch: {
    status: IterationStatus;
    reviewSummary: string;
    failedCriteria: readonly string[];
    nextStrategy: string;
    clock: () => number;
  },
): IterationSnapshot {
  return {
    ...iteration,
    status: patch.status,
    reviewSummary: patch.reviewSummary,
    failedCriteria: [...patch.failedCriteria],
    nextStrategy: patch.nextStrategy,
    finishedAt: patch.clock(),
  };
}
```

Export the new types/functions from `packages/core/src/index.ts`.

- [ ] **Step 6: Run iteration helper tests**

Run:

```bash
pnpm --filter @omakase/core test -- iterations.test.ts
```

Expected: PASS.

- [ ] **Step 7: Write failing orchestrator long-running tests**

Create `packages/core/tests/orchestrator-long-running.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { Orchestrator } from '../src/orchestrator.js';
import { MemoryRunStore } from '../src/supervisor/run-store.js';
import { createModelPolicy } from '../src/modes/policy.js';
import type { Router } from '../src/router/router.js';

const complexRouter: Router = {
  route: () => ({ kind: 'complex', reason: 'complex', confidence: 1, signals: [], suggestedRole: 'worker' }),
};

function orchForReview(verdicts: unknown[]) {
  let reviewIndex = 0;
  const exec = createScriptedAgent((input) => {
    if (String(input.metadata?.role) === 'reviewer') {
      const verdict = verdicts[Math.min(reviewIndex, verdicts.length - 1)];
      reviewIndex += 1;
      return [{ type: 'text_delta', delta: JSON.stringify(verdict) }];
    }
    return [{ type: 'text_delta', delta: 'worker done' }];
  });
  return new Orchestrator({
    runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
    router: complexRouter,
    policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
    store: new MemoryRunStore(),
    clock: () => 0,
    detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
  });
}

describe('orchestrator long-running acceptance loop', () => {
  it('emits acceptance and iteration state and only succeeds when all criteria pass', async () => {
    const orch = orchForReview([
      [{ met: true, note: 'feature works' }, { met: false, note: 'tests missing' }],
      [{ met: true, note: 'feature works' }, { met: true, note: 'tests now pass' }],
    ]);

    const result = await orch.start({
      prompt: '- build feature',
      acceptanceCriteria: ['feature works', 'tests pass'],
    }).result;

    expect(result.status).toBe('succeeded');
    expect(result.acceptance.criteria.map((c) => c.status)).toEqual(['pass', 'pass']);
    expect(result.acceptance.progress).toEqual({ passed: 2, total: 2, complete: true });
    expect(result.iterations.length).toBeGreaterThanOrEqual(1);
    expect(result.events.some((e) => e.type === 'acceptance-updated')).toBe(true);
    expect(result.events.some((e) => e.type === 'iteration-updated')).toBe(true);
  });

  it('persists acceptance and iteration state in run records', async () => {
    const store = new MemoryRunStore();
    const exec = createScriptedAgent((input) =>
      String(input.metadata?.role) === 'reviewer'
        ? [{ type: 'text_delta', delta: JSON.stringify([{ met: true, note: 'ok' }]) }]
        : [{ type: 'text_delta', delta: 'done' }],
    );
    const orch = new Orchestrator({
      runtime: createAgentRuntime({ executors: { scripted: exec }, now: () => 0 }),
      router: complexRouter,
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'scripted' } } }),
      store,
      clock: () => 0,
      detectionOptions: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });

    const result = await orch.start({ prompt: '- build feature', acceptanceCriteria: ['ok'] }).result;
    const record = await store.load(result.id);

    expect(record?.acceptance?.criteria[0]?.title).toBe('ok');
    expect(record?.acceptance?.progress.complete).toBe(true);
    expect(record?.iterations.length).toBeGreaterThan(0);
  });
});
```

Run:

```bash
pnpm --filter @omakase/core test -- orchestrator-long-running.test.ts
```

Expected: FAIL because `RunResult` and `RunRecord` do not yet expose acceptance or iterations and no new events exist.

- [ ] **Step 8: Wire acceptance and iteration state into core events and records**

Modify `packages/core/src/run-events.ts` to add:

```ts
import type { AcceptanceCriterion } from './acceptance.js';
import type { IterationSnapshot } from './iterations.js';

export interface AcceptanceSnapshot {
  criteria: AcceptanceCriterion[];
  progress: { passed: number; total: number; complete: boolean };
}

// Add to OrchestratorEvent:
| { type: 'acceptance-updated'; acceptance: AcceptanceSnapshot }
| { type: 'iteration-updated'; iteration: IterationSnapshot; iterations: IterationSnapshot[] }
```

Modify `packages/core/src/supervisor/run-store.ts`:

```ts
import type { AcceptanceSnapshot } from '../run-events.js';
import type { IterationSnapshot } from '../iterations.js';

export interface RunRecord {
  // existing fields...
  acceptance?: AcceptanceSnapshot;
  iterations?: IterationSnapshot[];
}
```

Keep validation backward compatible: optional fields should not be required for old run records.

- [ ] **Step 9: Wire orchestrator state**

Modify `packages/core/src/orchestrator.ts`:

- add private `acceptance` initialized from request criteria via `createAcceptanceCriteria`,
- add private `iterations: IterationSnapshot[] = []`,
- emit `acceptance-updated` after creation and after each reviewer result,
- create/update an iteration around planned graph execution and review results,
- include acceptance/iterations in `buildRecord()` and `buildResult()`,
- use `acceptanceProgress(...).complete` as the primary completion check when criteria exist.

Do not remove existing `review` events; they remain the compatibility layer.

- [ ] **Step 10: Run long-running core tests**

Run:

```bash
pnpm --filter @omakase/core test -- acceptance.test.ts iterations.test.ts orchestrator-long-running.test.ts structured-review.test.ts
```

Expected: PASS.

---

### Task 2: Risk Gate and User Input

**Files:**
- Create: `packages/core/src/risk-gates.ts`
- Modify: `packages/core/src/run-events.ts`
- Modify: `packages/core/src/supervisor/control.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/cli/src/run-client.ts`
- Test: `packages/core/tests/risk-gates.test.ts`
- Test: `packages/core/tests/control.test.ts`
- Test: `packages/cli/tests/run-client.test.ts`

- [ ] **Step 1: Write failing risk gate tests**

Add tests proving `createRiskGate()` creates an open gate, `answerRiskGate()` closes it, and a run with repeated unknown reviewer output emits `risk-gate-opened` and waits for control input.

- [ ] **Step 2: Implement gate types and events**

Add `RiskGateSnapshot`, `risk-gate-opened`, `risk-gate-answered`, and `waiting-for-user` run status or equivalent paused state.

- [ ] **Step 3: Extend control input**

Add control commands for `answer-gate` and `edit-criteria`, with TUI/API-compatible payloads.

- [ ] **Step 4: Verify focused tests**

Run:

```bash
pnpm --filter @omakase/core test -- risk-gates.test.ts control.test.ts
pnpm --filter @omakase/cli test -- run-client.test.ts
```

Expected: PASS.

---

### Task 3: Reporter and Knowledge Events

**Files:**
- Create: `packages/core/src/reports.ts`
- Create: `packages/core/src/knowledge/events.ts`
- Modify: `packages/core/src/run-events.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/core/src/knowledge/store.ts`
- Test: `packages/core/tests/reports.test.ts`
- Test: `packages/core/tests/knowledge-events.test.ts`
- Test: `packages/core/tests/orchestrator-long-running.test.ts`

- [ ] **Step 1: Write failing report and knowledge event tests**

Add tests proving reporter artifacts are created after planning and review, and proving reporter output cannot change plan/acceptance/task state.

- [ ] **Step 2: Implement report artifacts**

Add `ReportArtifact` and `report-created` events. Store report markdown and structured summary in the run record.

- [ ] **Step 3: Implement structured knowledge events**

Add `KnowledgeEvent` with source run/task/criterion/report links. Render wiki markdown from both legacy wiki entries and structured knowledge events.

- [ ] **Step 4: Verify focused tests**

Run:

```bash
pnpm --filter @omakase/core test -- reports.test.ts knowledge-events.test.ts orchestrator-long-running.test.ts
```

Expected: PASS.

---

### Task 4: TUI Workspaces and Read-Only Web

**Files:**
- Create: `packages/cli/src/read-only-server.ts`
- Modify: `packages/cli/src/view-model.ts`
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/src/tui/index.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `packages/cli/tests/view-model.test.ts`
- Test: `packages/cli/tests/tui.test.tsx`
- Test: `packages/cli/tests/read-only-server.test.ts`

- [ ] **Step 1: Write failing view-model and TUI tests**

Add tests proving replayed run events produce acceptance progress, current iteration, reports, gate state, and server URL in `RunView`.

- [ ] **Step 2: Write failing read-only server tests**

Add tests proving `GET /`, `GET /api/run/:id`, `GET /api/reports`, and `GET /api/wiki` return data and `POST` returns `405`.

- [ ] **Step 3: Implement view-model state**

Fold acceptance, iterations, gates, reports, and knowledge events into `RunView` while preserving old run replay compatibility.

- [ ] **Step 4: Implement TUI workspaces**

Add workspace switching for Plan, Agents, Acceptance, Knowledge, Reports, and Gate. Keep existing Plan/Detail focus behavior for task rows.

- [ ] **Step 5: Implement local read-only server**

Start the server with `omakase tui`, bind to `127.0.0.1`, choose an available port, pass the URL into TUI, and stop it when TUI exits.

- [ ] **Step 6: Verify focused CLI tests**

Run:

```bash
pnpm --filter @omakase/cli test -- view-model.test.ts tui.test.tsx read-only-server.test.ts
```

Expected: PASS.

---

### Task 5: Full Verification and Real Product Smoke

**Files:**
- No source files unless verification finds defects.

- [ ] **Step 1: Run full automated verification**

Run:

```bash
git diff --check
pnpm check
```

Expected: both exit 0.

- [ ] **Step 2: Restart source daemon**

Run:

```bash
scripts/omakase.sh daemon stop --cwd /Users/ben/Projects/Omakase2
scripts/omakase.sh tui --cwd /Users/ben/Projects/Omakase2
scripts/omakase.sh daemon status --cwd /Users/ben/Projects/Omakase2
```

Expected: daemon is running from the source launcher.

- [ ] **Step 3: Run real complex-agent smoke**

Run a real Codex-backed task:

```bash
scripts/omakase.sh tui --cwd /Users/ben/Projects/Omakase2 --agent codex "复杂任务烟测：生成验收标准，完成一个只读项目状态报告，若验收未通过则继续 replan；不要修改文件。"
```

Inspect the latest run:

```bash
latest=$(ls -t .omakase/runs/*.json | head -n1)
jq '{status, summary, acceptance, iterations, reports: (.reports // [] | length), events: [.events[].type]}' "$latest"
```

Expected: acceptance criteria exist, iterations exist, Planner/worker/reviewer events update, reports exist, and the run reaches `succeeded` only after acceptance is complete.
