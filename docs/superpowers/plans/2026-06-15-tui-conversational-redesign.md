# TUI Conversational Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the read-only monitor TUI with an opencode-style conversational REPL — a session groups multiple serial daemon runs, the event stream renders as a chat transcript, and an expanded sidebar shows the focused run's plan + agents.

**Architecture:** Four new pure/testable modules (SessionStore in core, composer-parse + reduceTranscript + client extensions in cli) underpin a rewritten Ink TUI split into Composer/Session/Orchestration components. The TUI stays a pure client over the existing daemon; no orchestrator/supervisor/daemon behavior changes.

**Tech Stack:** TypeScript ESM, Ink (React for terminals), Vitest, ink-testing-library. No real model calls in any test (mock client / explicit event arrays / fake store).

---

## File Structure

New files:

- `packages/core/src/session/store.ts` — `Session` type, `SessionStore` interface, `MemorySessionStore`, `FileSessionStore`, `isValidSession`.
- `packages/cli/src/composer-parse.ts` — `ComposerIntent` type, `parseComposerInput`, `composeSessionPrompt`.
- `packages/cli/src/tui/Composer.tsx` — input line + completion menu.
- `packages/cli/src/tui/Session.tsx` — transcript scrollback for the focused session.
- `packages/cli/src/tui/Orchestration.tsx` — sidebar: Plan + Agents for the focused run.

Modified files:

- `packages/cli/src/view-model.ts` — add `TranscriptItem`, `reduceTranscript`.
- `packages/cli/src/run-client.ts` — add `transcript`, `tailRun`, `submitToSession`.
- `packages/cli/src/tui/App.tsx` — rewrite as a shell composing the three components.
- `packages/cli/src/cli.ts` — wire session list/switch into the TUI launch.
- `packages/core/src/index.ts` — export the session module.
- Tests: new `tests/session-store.test.ts` (core), `tests/composer-parse.test.ts` (cli); extend `tests/view-model.test.ts`, `tests/run-client.test.ts`, `tests/tui.test.tsx` (cli).

Test command convention (single file): `pnpm --filter @omakase/<pkg> exec vitest run <relative test path>`.
Full gate before any merge: `pnpm -r typecheck && pnpm -r test && pnpm -r build`.

---

## Phase 1 — SessionStore (core)

### Task 1: Session type + validator + MemorySessionStore

**Files:**
- Create: `packages/core/src/session/store.ts`
- Test: `packages/core/tests/session-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/session-store.test.ts
import { describe, expect, it } from 'vitest';
import { MemorySessionStore, isValidSession } from '../src/session/store.js';

describe('MemorySessionStore', () => {
  it('creates, appends runs, updates summary/title, lists newest-first', async () => {
    const store = new MemorySessionStore();
    const a = await store.create({ id: 's1', title: 'first', now: 1000 });
    expect(a).toMatchObject({ id: 's1', title: 'first', runIds: [], rollingSummary: '' });

    await store.appendRun('s1', 'run-1', 1100);
    await store.appendRun('s1', 'run-1', 1150); // idempotent: no duplicate
    await store.updateSummary('s1', 'did X', 1200);
    await store.updateTitle('s1', 'renamed', 1250);

    const loaded = await store.load('s1');
    expect(loaded).toMatchObject({
      title: 'renamed',
      runIds: ['run-1'],
      rollingSummary: 'did X',
      updatedAt: 1250,
    });

    await store.create({ id: 's2', title: 'second', now: 2000 });
    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual(['s2', 's1']); // newest updatedAt first
  });

  it('returns null for unknown ids and after delete', async () => {
    const store = new MemorySessionStore();
    await store.create({ id: 's1', title: 't', now: 1 });
    await store.delete('s1');
    expect(await store.load('s1')).toBeNull();
    expect(await store.load('nope')).toBeNull();
  });

  it('isValidSession rejects malformed shapes', () => {
    expect(isValidSession({ id: 's', title: 't', runIds: [], rollingSummary: '', createdAt: 1, updatedAt: 1 })).toBe(true);
    expect(isValidSession({ id: 's', runIds: [], rollingSummary: '' })).toBe(false); // missing title/timestamps
    expect(isValidSession({ id: 's', title: 't', runIds: 'x', rollingSummary: '', createdAt: 1, updatedAt: 1 })).toBe(false);
    expect(isValidSession(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omakase/core exec vitest run tests/session-store.test.ts`
Expected: FAIL — cannot find module `../src/session/store.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/session/store.ts
/**
 * A session groups multiple serial runs into one continuous conversation. The
 * heavy run state stays in the {@link RunStore}; a session only stores the run
 * id references plus a rolling summary that bridges context from one run to the
 * next. Files live under `.omakase/sessions/<id>.json`.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Session {
  id: string;
  title: string;
  /** Run ids belonging to this session, in submission order. */
  runIds: string[];
  /** Carried-forward context summary, injected into each new run's prompt. */
  rollingSummary: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionStore {
  create(input: { id: string; title: string; now: number }): Promise<Session>;
  load(id: string): Promise<Session | null>;
  list(): Promise<Session[]>;
  appendRun(id: string, runId: string, now: number): Promise<void>;
  updateSummary(id: string, summary: string, now: number): Promise<void>;
  updateTitle(id: string, title: string, now: number): Promise<void>;
  delete(id: string): Promise<void>;
}

export function isValidSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<Session>;
  return (
    typeof s.id === 'string' &&
    typeof s.title === 'string' &&
    Array.isArray(s.runIds) &&
    s.runIds.every((r) => typeof r === 'string') &&
    typeof s.rollingSummary === 'string' &&
    typeof s.createdAt === 'number' &&
    typeof s.updatedAt === 'number'
  );
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  async create(input: { id: string; title: string; now: number }): Promise<Session> {
    const session: Session = {
      id: input.id,
      title: input.title,
      runIds: [],
      rollingSummary: '',
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.sessions.set(session.id, session);
    return structuredClone(session);
  }

  async load(id: string): Promise<Session | null> {
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : null;
  }

  async list(): Promise<Session[]> {
    return [...this.sessions.values()]
      .map((s) => structuredClone(s))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async appendRun(id: string, runId: string, now: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    if (!s.runIds.includes(runId)) s.runIds.push(runId);
    s.updatedAt = now;
  }

  async updateSummary(id: string, summary: string, now: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.rollingSummary = summary;
    s.updatedAt = now;
  }

  async updateTitle(id: string, title: string, now: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.title = title;
    s.updatedAt = now;
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @omakase/core exec vitest run tests/session-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/store.ts packages/core/tests/session-store.test.ts
git commit -m "feat(core): add Session type and MemorySessionStore"
```

### Task 2: FileSessionStore with atomic writes + tolerant load

**Files:**
- Modify: `packages/core/src/session/store.ts` (append the class)
- Test: `packages/core/tests/session-store.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/tests/session-store.test.ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileSessionStore } from '../src/session/store.js';

describe('FileSessionStore', () => {
  it('persists and reloads a session across instances', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oma-ses-'));
    const a = new FileSessionStore(dir);
    await a.create({ id: 's1', title: 't', now: 1 });
    await a.appendRun('s1', 'run-1', 2);

    const b = new FileSessionStore(dir);
    const loaded = await b.load('s1');
    expect(loaded?.runIds).toEqual(['run-1']);
    expect((await b.list()).map((s) => s.id)).toEqual(['s1']);
  });

  it('returns null for a malformed file instead of throwing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oma-ses-'));
    await writeFile(path.join(dir, 'bad.json'), '{ not valid', 'utf8');
    const store = new FileSessionStore(dir);
    expect(await store.load('bad')).toBeNull();
    expect(await store.list()).toEqual([]); // bad file skipped, not fatal
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omakase/core exec vitest run tests/session-store.test.ts`
Expected: FAIL — `FileSessionStore` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to packages/core/src/session/store.ts
export class FileSessionStore implements SessionStore {
  private tmpSeq = 0;
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private async write(session: Session): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(session.id);
    this.tmpSeq += 1;
    const tmp = `${target}.${this.tmpSeq}.tmp`;
    await writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
    await rename(tmp, target); // atomic: never a partial canonical file
  }

  async create(input: { id: string; title: string; now: number }): Promise<Session> {
    const session: Session = {
      id: input.id,
      title: input.title,
      runIds: [],
      rollingSummary: '',
      createdAt: input.now,
      updatedAt: input.now,
    };
    await this.write(session);
    return session;
  }

  async load(id: string): Promise<Session | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file(id), 'utf8')) as unknown;
      return isValidSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<Session[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: Session[] = [];
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      const s = await this.load(e.slice(0, -'.json'.length));
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async mutate(id: string, fn: (s: Session) => void, now: number): Promise<void> {
    const s = await this.load(id);
    if (!s) return;
    fn(s);
    s.updatedAt = now;
    await this.write(s);
  }

  async appendRun(id: string, runId: string, now: number): Promise<void> {
    await this.mutate(id, (s) => {
      if (!s.runIds.includes(runId)) s.runIds.push(runId);
    }, now);
  }

  async updateSummary(id: string, summary: string, now: number): Promise<void> {
    await this.mutate(id, (s) => {
      s.rollingSummary = summary;
    }, now);
  }

  async updateTitle(id: string, title: string, now: number): Promise<void> {
    await this.mutate(id, (s) => {
      s.title = title;
    }, now);
  }

  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @omakase/core exec vitest run tests/session-store.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 5: Export from core and commit**

Add to `packages/core/src/index.ts` after the run-store export block:

```ts
// ── Sessions ──────────────────────────────────────────────────────────────
export { MemorySessionStore, FileSessionStore, isValidSession } from './session/store.js';
export type { Session, SessionStore } from './session/store.js';
```

Run: `pnpm --filter @omakase/core exec vitest run && pnpm --filter @omakase/core typecheck`
Expected: PASS, no type errors.

```bash
git add packages/core/src/session/store.ts packages/core/src/index.ts packages/core/tests/session-store.test.ts
git commit -m "feat(core): add FileSessionStore with atomic writes and tolerant load"
```

---

## Phase 2 — Composer parsing (cli)

### Task 3: parseComposerInput

**Files:**
- Create: `packages/cli/src/composer-parse.ts`
- Test: `packages/cli/tests/composer-parse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/tests/composer-parse.test.ts
import { describe, expect, it } from 'vitest';
import { parseComposerInput } from '../src/composer-parse.js';

describe('parseComposerInput', () => {
  it('treats blank input as empty', () => {
    expect(parseComposerInput('   ')).toEqual({ kind: 'empty' });
  });

  it('parses a plain natural-language task', () => {
    expect(parseComposerInput('add OAuth to login')).toEqual({
      kind: 'task',
      prompt: 'add OAuth to login',
      files: [],
    });
  });

  it('extracts a leading/inline @agent override and strips it from the prompt', () => {
    expect(parseComposerInput('@codex refactor the parser')).toEqual({
      kind: 'task',
      prompt: 'refactor the parser',
      agentOverride: 'codex',
      files: [],
    });
  });

  it('collects #file references and strips them from the prompt', () => {
    expect(parseComposerInput('explain #src/a.ts and #src/b.ts please')).toEqual({
      kind: 'task',
      prompt: 'explain and please',
      files: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('routes /workflow to a workflow intent', () => {
    expect(parseComposerInput('/workflow review the diff')).toEqual({
      kind: 'workflow',
      source: 'review the diff',
    });
  });

  it('parses other slash commands with name + args', () => {
    expect(parseComposerInput('/agent claude')).toEqual({ kind: 'command', name: 'agent', args: 'claude' });
    expect(parseComposerInput('/stop')).toEqual({ kind: 'command', name: 'stop', args: '' });
  });

  it('does not treat a mid-word @ (e.g. email) as an agent override', () => {
    expect(parseComposerInput('email me@example.com the report')).toEqual({
      kind: 'task',
      prompt: 'email me@example.com the report',
      files: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omakase/cli exec vitest run tests/composer-parse.test.ts`
Expected: FAIL — cannot find module `../src/composer-parse.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/composer-parse.ts
/**
 * Pure parser for the TUI composer line. Classifies raw input into a task
 * (natural language, with optional inline `@agent` override and `#file`
 * references), a slash command, a `/workflow` request, or empty. Kept pure so
 * the completion UI and the App can both rely on identical, unit-tested rules.
 */
export type ComposerIntent =
  | { kind: 'empty' }
  | { kind: 'task'; prompt: string; agentOverride?: string; files: string[] }
  | { kind: 'command'; name: string; args: string }
  | { kind: 'workflow'; source: string };

/** An @agent or #file token only counts at a word boundary (so emails don't match). */
const AGENT_RE = /(?:^|\s)@([A-Za-z0-9_.:-]+)/;
const FILE_RE = /(?:^|\s)#(\S+)/g;

export function parseComposerInput(raw: string): ComposerIntent {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };

  if (trimmed.startsWith('/')) {
    const rest = trimmed.slice(1);
    const sp = rest.search(/\s/);
    const name = (sp === -1 ? rest : rest.slice(0, sp)).toLowerCase();
    const args = sp === -1 ? '' : rest.slice(sp + 1).trim();
    if (name === 'workflow') return { kind: 'workflow', source: args };
    return { kind: 'command', name, args };
  }

  let agentOverride: string | undefined;
  const agentMatch = AGENT_RE.exec(trimmed);
  let body = trimmed;
  if (agentMatch) {
    agentOverride = agentMatch[1];
    body = (body.slice(0, agentMatch.index) + body.slice(agentMatch.index + agentMatch[0].length)).trim();
  }

  const files: string[] = [];
  body = body.replace(FILE_RE, (_m, p1: string) => {
    files.push(p1);
    return ' ';
  });
  const prompt = body.replace(/\s+/g, ' ').trim();

  return agentOverride
    ? { kind: 'task', prompt, agentOverride, files }
    : { kind: 'task', prompt, files };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @omakase/cli exec vitest run tests/composer-parse.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/composer-parse.ts packages/cli/tests/composer-parse.test.ts
git commit -m "feat(cli): add pure composer input parser"
```

### Task 4: composeSessionPrompt (context bridge)

**Files:**
- Modify: `packages/cli/src/composer-parse.ts`
- Test: `packages/cli/tests/composer-parse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/cli/tests/composer-parse.test.ts
import { composeSessionPrompt } from '../src/composer-parse.js';

describe('composeSessionPrompt', () => {
  it('returns the bare prompt when there is no summary or files', () => {
    expect(composeSessionPrompt({ prompt: 'do X', files: [] }, '')).toBe('do X');
  });

  it('prepends a session-context block when a rolling summary exists', () => {
    const out = composeSessionPrompt({ prompt: 'do X', files: [] }, 'we built Y');
    expect(out).toContain('Session context so far:');
    expect(out).toContain('we built Y');
    expect(out.trimEnd().endsWith('do X')).toBe(true);
  });

  it('appends a context-files list when files are referenced', () => {
    const out = composeSessionPrompt({ prompt: 'do X', files: ['a.ts', 'b.ts'] }, '');
    expect(out).toContain('Context files:');
    expect(out).toContain('- a.ts');
    expect(out).toContain('- b.ts');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omakase/cli exec vitest run tests/composer-parse.test.ts`
Expected: FAIL — `composeSessionPrompt` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to packages/cli/src/composer-parse.ts
/**
 * Build the final run prompt for a task submitted inside a session: the session's
 * rolling summary (if any) is prepended as context, and any #file references are
 * appended as an explicit list. Pure and deterministic.
 */
export function composeSessionPrompt(
  intent: { prompt: string; files: string[] },
  rollingSummary: string,
): string {
  const parts: string[] = [];
  if (rollingSummary.trim()) {
    parts.push(`Session context so far:\n${rollingSummary.trim()}\n`);
  }
  parts.push(intent.prompt);
  if (intent.files.length > 0) {
    parts.push(`\nContext files:\n${intent.files.map((f) => `- ${f}`).join('\n')}`);
  }
  return parts.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @omakase/cli exec vitest run tests/composer-parse.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/composer-parse.ts packages/cli/tests/composer-parse.test.ts
git commit -m "feat(cli): add session context-bridge prompt composer"
```

---

## Phase 3 — Transcript projection (cli)

### Task 5: reduceTranscript

**Files:**
- Modify: `packages/cli/src/view-model.ts`
- Test: `packages/cli/tests/view-model.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/cli/tests/view-model.test.ts
import { reduceTranscript, type TranscriptItem } from '../src/view-model.js';
import type { OrchestratorEvent, PlanGraphSnapshot } from '@omakase/core';

function plan(n: number): PlanGraphSnapshot {
  return {
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `t${i}`, title: `task ${i}`, role: 'worker', status: 'pending', dependsOn: [], tags: [], attempts: 0,
    })),
  } as unknown as PlanGraphSnapshot;
}

describe('reduceTranscript', () => {
  it('projects the structural milestones into a chat transcript', () => {
    const events: OrchestratorEvent[] = [
      { type: 'run-started', runId: 'r1', mode: 'normal', request: { prompt: 'add OAuth' } } as OrchestratorEvent,
      { type: 'routed', decision: { kind: 'complex', reason: 'multi-file' } } as OrchestratorEvent,
      { type: 'planned', snapshot: plan(2) } as OrchestratorEvent,
      { type: 'agent-assigned', taskId: 't0', role: 'worker', title: 'task 0', assignment: { agentId: 'claude' }, agentLabel: 'claude' } as OrchestratorEvent,
      { type: 'task-finished', taskId: 't0', role: 'worker', title: 'task 0', success: true } as OrchestratorEvent,
      { type: 'review', approved: true, notes: 'lgtm' } as OrchestratorEvent,
      { type: 'run-finished', status: 'succeeded', summary: 'done' } as OrchestratorEvent,
    ];
    const items = reduceTranscript(events);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(['user-message', 'route', 'plan', 'task-progress', 'task-progress', 'review', 'finished']);
    expect(items[0]).toEqual({ kind: 'user-message', text: 'add OAuth' });
    expect(items[2]).toEqual({ kind: 'plan', taskCount: 2 });
    expect(items[3]).toMatchObject({ kind: 'task-progress', status: 'started', agentLabel: 'claude' });
    expect(items[4]).toMatchObject({ kind: 'task-progress', status: 'succeeded' });
  });

  it('ignores noisy agent stream deltas and heartbeats', () => {
    const events: OrchestratorEvent[] = [
      { type: 'heartbeat', at: 1 } as OrchestratorEvent,
      { type: 'agent-event', taskId: 't0', role: 'worker', assignment: { agentId: 'claude' }, event: { type: 'text_delta', delta: 'hi' } } as OrchestratorEvent,
    ];
    expect(reduceTranscript(events)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omakase/cli exec vitest run tests/view-model.test.ts`
Expected: FAIL — `reduceTranscript` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/cli/src/view-model.ts` (after the `RunView` interface; reuse existing imports `AgentRole`, `OrchestratorEvent`, `RouteKind`, `RunStatus`, and add `WorkflowPhaseStatus` to the import from `@omakase/core`):

```ts
export type TranscriptItem =
  | { kind: 'user-message'; text: string }
  | { kind: 'route'; routeKind: RouteKind; reason: string }
  | { kind: 'plan'; taskCount: number }
  | { kind: 'task-progress'; role: AgentRole; title: string; agentLabel: string | null; status: 'started' | 'succeeded' | 'failed' }
  | { kind: 'review'; approved: boolean; notes: string }
  | { kind: 'report'; title: string }
  | { kind: 'workflow-phase'; name: string; status: WorkflowPhaseStatus }
  | { kind: 'finished'; status: RunStatus; summary: string };

/**
 * Project a run's event log into an ordered chat transcript of structural
 * milestones (user message → route → plan → per-task progress → review →
 * finish). Streaming token/thinking deltas and heartbeats are intentionally
 * dropped — those belong to the live "phrases" feed, not the readable timeline.
 */
export function reduceTranscript(events: OrchestratorEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'run-started':
        items.push({ kind: 'user-message', text: event.request.prompt });
        break;
      case 'routed':
        items.push({ kind: 'route', routeKind: event.decision.kind, reason: event.decision.reason });
        break;
      case 'planned':
        items.push({ kind: 'plan', taskCount: event.snapshot.tasks.length });
        break;
      case 'agent-assigned':
        if (event.taskId) {
          items.push({
            kind: 'task-progress',
            role: event.role,
            title: event.title ?? event.taskId,
            agentLabel: event.agentLabel ?? event.assignment?.agentId ?? null,
            status: 'started',
          });
        }
        break;
      case 'task-finished':
        items.push({
          kind: 'task-progress',
          role: event.role,
          title: event.title,
          agentLabel: null,
          status: event.success ? 'succeeded' : 'failed',
        });
        break;
      case 'review':
        items.push({ kind: 'review', approved: event.approved, notes: event.notes });
        break;
      case 'report-created':
        items.push({ kind: 'report', title: event.report.title });
        break;
      case 'workflow-phase-started':
      case 'workflow-phase-finished':
        items.push({ kind: 'workflow-phase', name: event.phase.name, status: event.phase.status });
        break;
      case 'run-finished':
        items.push({ kind: 'finished', status: event.status, summary: event.summary });
        break;
      default:
        break;
    }
  }
  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @omakase/cli exec vitest run tests/view-model.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/view-model.ts packages/cli/tests/view-model.test.ts
git commit -m "feat(cli): project run events into a chat transcript"
```

---

## Phase 4 — Client session/transcript surface (cli)

### Task 6: client.transcript + client.tailRun

**Files:**
- Modify: `packages/cli/src/run-client.ts`
- Test: `packages/cli/tests/run-client.test.ts`

- [ ] **Step 1: Write the failing test**

Use the existing test's setup pattern (a `MemoryRunStore` + saved `RunRecord`). Add:

```ts
// append to packages/cli/tests/run-client.test.ts
import { reduceTranscript } from '../src/view-model.js';

it('transcript() folds the record events into transcript items', async () => {
  const store = new MemoryRunStore();
  const events = [
    { type: 'run-started', runId: 'r1', mode: 'normal', request: { prompt: 'do X' } },
    { type: 'run-finished', status: 'succeeded', summary: 'ok' },
  ];
  await store.save({
    id: 'r1', request: { prompt: 'do X' }, mode: 'normal', status: 'succeeded',
    plan: { tasks: [] }, wiki: { entries: [] }, inbox: [], events,
    summary: 'ok', createdAt: 1, updatedAt: 2, heartbeatAt: 2, checkpointSeq: 1,
  } as never);
  const client = new RunControllerClient({ store, controlDir: '/tmp/x', queueDir: '/tmp/x', pollMs: 5 });
  const items = await client.transcript('r1');
  expect(items).toEqual(reduceTranscript(events as never));
});

it('tailRun emits both the view and transcript and stops on dispose', async () => {
  const store = new MemoryRunStore();
  await store.save({
    id: 'r1', request: { prompt: 'do X' }, mode: 'normal', status: 'running',
    plan: { tasks: [] }, wiki: { entries: [] }, inbox: [],
    events: [{ type: 'run-started', runId: 'r1', mode: 'normal', request: { prompt: 'do X' } }],
    summary: '', createdAt: 1, updatedAt: 2, heartbeatAt: 2, checkpointSeq: 1,
  } as never);
  const client = new RunControllerClient({ store, controlDir: '/tmp/x', queueDir: '/tmp/x', pollMs: 5 });
  const seen: Array<{ viewRunId: string | null; itemKinds: string[] }> = [];
  const dispose = client.tailRun('r1', (u) => seen.push({ viewRunId: u.view.runId, itemKinds: u.transcript.map((i) => i.kind) }));
  await new Promise((r) => setTimeout(r, 30));
  dispose();
  expect(seen.length).toBeGreaterThanOrEqual(1);
  expect(seen[0]).toEqual({ viewRunId: 'r1', itemKinds: ['user-message'] });
});
```

(If `MemoryRunStore`/`RunControllerClient` aren't imported yet in this file, add them to the existing imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omakase/cli exec vitest run tests/run-client.test.ts`
Expected: FAIL — `transcript`/`tailRun` not a function.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/run-client.ts`, extend the imports and add two methods. Update the view-model import:

```ts
import { applyPlanSnapshot, buildRunView, reduceTranscript, type RunView, type TranscriptItem } from './view-model.js';
```

Add methods to the class (after `tail`):

```ts
  /** One-shot transcript (structural chat timeline) for a run. */
  async transcript(runId: string): Promise<TranscriptItem[]> {
    const rec = await this.store.load(runId);
    return rec ? reduceTranscript(rec.events) : [];
  }

  /**
   * Live-tail a run, emitting both the folded sidebar view and the chat
   * transcript on every advance. One poller drives both projections.
   */
  tailRun(runId: string, onUpdate: (u: { view: RunView; transcript: TranscriptItem[] }) => void): () => void {
    let stopped = false;
    let lastLen = -1;
    let lastStatus = '';
    let lastSeq = -1;
    const poll = async (): Promise<void> => {
      if (stopped) return;
      const rec = await this.store.load(runId);
      if (stopped || !rec) return;
      if (rec.events.length !== lastLen || rec.status !== lastStatus || rec.checkpointSeq !== lastSeq) {
        lastLen = rec.events.length;
        lastStatus = rec.status;
        lastSeq = rec.checkpointSeq;
        const view = { ...applyPlanSnapshot(buildRunView(rec.events, rec.mode), rec.plan), runId };
        onUpdate({ view, transcript: reduceTranscript(rec.events) });
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), this.pollMs);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @omakase/cli exec vitest run tests/run-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/run-client.ts packages/cli/tests/run-client.test.ts
git commit -m "feat(cli): add transcript + combined view/transcript tail to client"
```

### Task 7: client.submitToSession

**Files:**
- Modify: `packages/cli/src/run-client.ts`
- Test: `packages/cli/tests/run-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/cli/tests/run-client.test.ts
import { readFile, readdir } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

it('submitToSession writes a queue file with @agent header and injected context', async () => {
  const queueDir = await mkdtemp(path.join(tmpdir(), 'oma-q-'));
  const store = new MemoryRunStore();
  const client = new RunControllerClient({ store, controlDir: queueDir, queueDir, pollMs: 5 });
  const token = await client.submitToSession(
    { rollingSummary: 'we built Y' },
    { prompt: 'now do X', agentOverride: 'codex', files: ['a.ts'] },
  );
  expect(token).toMatch(/\.prompt$/);
  const files = await readdir(queueDir);
  const body = await readFile(path.join(queueDir, files.find((f) => f.endsWith('.prompt'))!), 'utf8');
  expect(body.startsWith('@agent codex\n')).toBe(true);
  expect(body).toContain('Session context so far:');
  expect(body).toContain('we built Y');
  expect(body).toContain('now do X');
  expect(body).toContain('- a.ts');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omakase/cli exec vitest run tests/run-client.test.ts`
Expected: FAIL — `submitToSession` not a function.

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `run-client.ts`:

```ts
import { composeSessionPrompt } from './composer-parse.js';
```

Add the method (after `submit`):

```ts
  /**
   * Submit a task inside a session: the rolling summary + #file references are
   * folded into the prompt (see {@link composeSessionPrompt}) and an optional
   * agent override is pinned via the `@agent` header. Returns the queue token;
   * the caller resolves the run id and records it on the session.
   */
  async submitToSession(
    session: { rollingSummary: string },
    intent: { prompt: string; agentOverride?: string; files: string[] },
  ): Promise<string> {
    const prompt = composeSessionPrompt({ prompt: intent.prompt, files: intent.files }, session.rollingSummary);
    return this.submit(prompt, intent.agentOverride);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @omakase/cli exec vitest run tests/run-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/run-client.ts packages/cli/tests/run-client.test.ts
git commit -m "feat(cli): add session-aware submit to the run client"
```

---

## Phase 5 — TUI components (cli)

> All TUI tests use `ink-testing-library`'s `render` + `lastFrame()` / `stdin.write(...)`, and gate `useInput` on `isRawModeSupported` (follow the existing `tests/tui.test.tsx` patterns). No real models, no daemon.

### Task 8: Orchestration sidebar component

**Files:**
- Create: `packages/cli/src/tui/Orchestration.tsx`
- Test: `packages/cli/tests/tui.test.tsx` (add a describe block)

- [ ] **Step 1: Write the failing test**

```tsx
// append to packages/cli/tests/tui.test.tsx
import { Orchestration } from '../src/tui/Orchestration.js';
import { initialRunView, type RunView } from '../src/view-model.js';

function viewWith(tasks: RunView['tasks']): RunView {
  return { ...initialRunView('normal'), runId: 'r1', status: 'running', tasks,
    phases: [{ stage: 'build', done: 1, total: 2 }] };
}

describe('Orchestration sidebar', () => {
  it('renders the focused run plan and agents', () => {
    const view = viewWith([
      { id: 't0', title: 'scaffold', role: 'worker', status: 'succeeded', tags: ['build'], tokens: 1200, toolCount: 3, startedAt: 1, finishedAt: 2, agentId: 'claude', agentRunId: null, agentLabel: 'claude' },
      { id: 't1', title: 'oauth', role: 'worker', status: 'running', tags: ['build'], tokens: 840, toolCount: 1, startedAt: 1, finishedAt: null, agentId: 'codex', agentRunId: null, agentLabel: 'codex' },
    ]);
    const { lastFrame } = render(<Orchestration view={view} focused expanded />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Plan');
    expect(frame).toContain('build');
    expect(frame).toContain('Agents');
    expect(frame).toContain('claude');
    expect(frame).toContain('codex');
  });

  it('renders nothing but a collapsed marker when not expanded', () => {
    const { lastFrame } = render(<Orchestration view={viewWith([])} focused={false} expanded={false} />);
    expect(lastFrame() ?? '').not.toContain('Agents');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omakase/cli exec vitest run tests/tui.test.tsx`
Expected: FAIL — cannot find module `../src/tui/Orchestration.js`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/cli/src/tui/Orchestration.tsx
/**
 * The orchestration sidebar: the focused run's plan (phases + tasks) and the
 * agents working it (token/tool counts). Pure presentation over a RunView;
 * expanded by default, collapsible from the App.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { RunView, TaskView } from '../view-model.js';

const STATUS_GLYPH: Record<string, string> = {
  succeeded: '✓', running: '▸', failed: '✗', cancelled: '⊘', blocked: '◌', pending: '◷',
};

interface AgentRow {
  label: string;
  tokens: number;
  active: boolean;
}

function agentRows(tasks: TaskView[]): AgentRow[] {
  const byLabel = new Map<string, AgentRow>();
  for (const t of tasks) {
    const label = t.agentLabel ?? t.agentId ?? 'unassigned';
    const row = byLabel.get(label) ?? { label, tokens: 0, active: false };
    row.tokens += t.tokens;
    row.active = row.active || t.status === 'running';
    byLabel.set(label, row);
  }
  return [...byLabel.values()];
}

export function Orchestration(props: { view: RunView; focused: boolean; expanded: boolean }): React.ReactElement | null {
  const { view, focused, expanded } = props;
  if (!expanded) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>▸ run ({view.activeAgents} agents) — [o] expand</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} paddingX={1} minWidth={26}>
      <Text bold>run ▸ {view.activeAgents} agents</Text>
      <Text bold>Plan</Text>
      {view.phases.length === 0 ? (
        <Text dimColor> no plan yet</Text>
      ) : (
        view.phases.map((p) => (
          <Text key={p.stage}> {p.done === p.total ? '✓' : '▸'} {p.stage} {p.done}/{p.total}</Text>
        ))
      )}
      <Text bold>Tasks</Text>
      {view.tasks.slice(0, 12).map((t) => (
        <Text key={t.id}> {STATUS_GLYPH[t.status] ?? '·'} {t.title}</Text>
      ))}
      <Text bold>Agents</Text>
      {agentRows(view.tasks).map((a) => (
        <Text key={a.label}> {a.active ? '●' : '○'} {a.label} {a.tokens} tok</Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @omakase/cli exec vitest run tests/tui.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/tui/Orchestration.tsx packages/cli/tests/tui.test.tsx
git commit -m "feat(cli): add orchestration sidebar component"
```

### Task 9: Session transcript component

**Files:**
- Create: `packages/cli/src/tui/Session.tsx`
- Test: `packages/cli/tests/tui.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// append to packages/cli/tests/tui.test.tsx
import { Session as SessionPane } from '../src/tui/Session.js';
import type { TranscriptItem } from '../src/view-model.js';

describe('Session transcript pane', () => {
  it('renders user messages, route, plan and task progress', () => {
    const transcript: TranscriptItem[] = [
      { kind: 'user-message', text: 'add OAuth' },
      { kind: 'route', routeKind: 'complex', reason: 'multi-file' },
      { kind: 'plan', taskCount: 3 },
      { kind: 'task-progress', role: 'worker', title: 'callback', agentLabel: 'claude', status: 'started' },
      { kind: 'finished', status: 'succeeded', summary: 'done' },
    ];
    const { lastFrame } = render(<SessionPane transcript={transcript} title="redesign" focused rows={40} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('add OAuth');
    expect(frame).toContain('complex');
    expect(frame).toContain('3 task');
    expect(frame).toContain('callback');
    expect(frame).toContain('done');
  });

  it('shows an empty-session hint when there is no transcript', () => {
    const { lastFrame } = render(<SessionPane transcript={[]} title="new" focused rows={40} />);
    expect(lastFrame() ?? '').toMatch(/type a task|empty|start/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omakase/cli exec vitest run tests/tui.test.tsx`
Expected: FAIL — cannot find module `../src/tui/Session.js`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/cli/src/tui/Session.tsx
/**
 * The conversation scrollback: the focused session's transcript rendered as a
 * readable chat timeline. The newest items are kept visible by tailing the
 * array to the available rows. Pure presentation over TranscriptItem[].
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { TranscriptItem } from '../view-model.js';

function line(item: TranscriptItem): React.ReactElement {
  switch (item.kind) {
    case 'user-message':
      return <Text color="cyan">› {item.text}</Text>;
    case 'route':
      return <Text dimColor>  ↪ router → {item.routeKind} ({item.reason})</Text>;
    case 'plan':
      return <Text dimColor>  ▤ planned {item.taskCount} task(s)</Text>;
    case 'task-progress':
      return (
        <Text>
          {'  '}
          {item.status === 'started' ? '▸' : item.status === 'succeeded' ? '✓' : '✗'} {item.role}
          {item.agentLabel ? `[${item.agentLabel}]` : ''} {item.title}
        </Text>
      );
    case 'review':
      return <Text color={item.approved ? 'green' : 'red'}>  ⚖ {item.approved ? 'APPROVED' : 'REJECTED'} — {item.notes}</Text>;
    case 'report':
      return <Text dimColor>  ▣ report: {item.title}</Text>;
    case 'workflow-phase':
      return <Text dimColor>  ▧ workflow phase {item.status}: {item.name}</Text>;
    case 'finished':
      return <Text color={item.status === 'succeeded' ? 'green' : 'yellow'}>  ■ {item.status} — {item.summary}</Text>;
  }
}

export function Session(props: {
  transcript: TranscriptItem[];
  title: string;
  focused: boolean;
  rows: number;
}): React.ReactElement {
  const { transcript, title, focused, rows } = props;
  const visible = transcript.slice(-Math.max(4, rows - 2));
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} paddingX={1}>
      <Text bold>session · {title}</Text>
      {visible.length === 0 ? (
        <Text dimColor>type a task below to start — router will plan and dispatch agents</Text>
      ) : (
        visible.map((item, i) => <Box key={i}>{line(item)}</Box>)
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @omakase/cli exec vitest run tests/tui.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/tui/Session.tsx packages/cli/tests/tui.test.tsx
git commit -m "feat(cli): add session transcript pane component"
```

### Task 10: Composer input component

**Files:**
- Create: `packages/cli/src/tui/Composer.tsx`
- Test: `packages/cli/tests/tui.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// append to packages/cli/tests/tui.test.tsx
import { Composer } from '../src/tui/Composer.js';

describe('Composer', () => {
  it('submits the parsed intent on enter and clears', async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame } = render(<Composer focused onSubmit={(raw) => submitted.push(raw)} hint="" />);
    stdin.write('add OAuth');
    await delay(20);
    expect(lastFrame() ?? '').toContain('add OAuth');
    stdin.write('\r'); // enter
    await delay(20);
    expect(submitted).toEqual(['add OAuth']);
    expect(lastFrame() ?? '').not.toContain('add OAuth');
  });

  it('shows a slash-command menu when the line starts with /', async () => {
    const { stdin, lastFrame } = render(<Composer focused onSubmit={() => {}} hint="" />);
    stdin.write('/');
    await delay(20);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/\/stop/);
    expect(frame).toMatch(/\/workflow/);
  });
});
```

(`delay` already exists in `tui.test.tsx`; if not, add `const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omakase/cli exec vitest run tests/tui.test.tsx`
Expected: FAIL — cannot find module `../src/tui/Composer.js`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/cli/src/tui/Composer.tsx
/**
 * The composer input line. Captures keystrokes (gated on raw-mode support),
 * shows a completion menu for `/` slash commands, and emits the raw string on
 * enter for the App to parse via parseComposerInput. Kept presentation-only:
 * all classification lives in the pure composer-parse module.
 */
import React, { useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

const COMMANDS = ['/new', '/sessions', '/runs', '/stop', '/pause', '/resume', '/model', '/agent', '/workflow', '/web', '/clear', '/help'];

export function Composer(props: {
  focused: boolean;
  hint: string;
  onSubmit: (raw: string) => void;
}): React.ReactElement {
  const { focused, hint, onSubmit } = props;
  const { isRawModeSupported } = useStdin();
  const [value, setValue] = useState('');

  useInput(
    (input, key) => {
      if (key.return) {
        const raw = value;
        setValue('');
        if (raw.trim()) onSubmit(raw);
        return;
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow) return;
      if (input) setValue((v) => v + input);
    },
    { isActive: focused && isRawModeSupported },
  );

  const showMenu = value.startsWith('/');
  const matches = showMenu ? COMMANDS.filter((c) => c.startsWith(value.split(/\s/)[0] ?? '')) : [];

  return (
    <Box flexDirection="column">
      {showMenu && matches.length > 0 && (
        <Box paddingX={1}>
          <Text dimColor>{matches.join('  ')}</Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} paddingX={1}>
        <Text>{'› '}{value}{focused ? '▍' : ''}</Text>
      </Box>
      {hint ? <Text dimColor>{hint}</Text> : null}
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @omakase/cli exec vitest run tests/tui.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/tui/Composer.tsx packages/cli/tests/tui.test.tsx
git commit -m "feat(cli): add composer input component with slash menu"
```

### Task 11: Rewrite App.tsx as the conversational shell

**Files:**
- Modify (rewrite): `packages/cli/src/tui/App.tsx`
- Test: `packages/cli/tests/tui.test.tsx` (replace the monitor-era App tests with conversational ones)

**Design notes for this task:**
- `App` props extend the existing `AppProps` (keep `client`, `cwd`, `mode`, `task`, `token`, `detect`, `daemonStatus`, `stopDaemon`, `startDaemon`, `readOnlyUrl`). Add `sessions: SessionStore` and `now?: () => number`.
- State: `sessionId` (current), `sessions` (list), `transcript`, `view` (sidebar RunView), `activeRunId`, `focus: 'session' | 'sidebar' | 'composer'` (default `'composer'`), `expanded` (default **true**), `daemon`, `notice`.
- On mount: load/create a session; if `task`/`token` provided, resolve the run id, `appendRun`, and `tailRun`. Otherwise list sessions and attach the newest session's latest run.
- Submit flow (`onSubmit(raw)`): `parseComposerInput(raw)`; then:
  - `task` → if a run is active and non-terminal, `client.sendInput(activeRunId, prompt)`; else `client.submitToSession(session, intent)` → `resolveRunId` → `sessions.appendRun` → `tailRun`. (Serial within session.)
  - `workflow` → `client.submitToSession(session, { prompt: '/workflow ' + source ... })` is NOT used; instead submit the workflow source as a task whose metadata marks it a workflow. **For this plan**, route `/workflow <src>` to `client.submitToSession(session, { prompt: source, files: [] })` and rely on the daemon's workflow path; surface a notice `running workflow`. (Deeper workflow wiring is a follow-up; the sidebar already renders `workflow-phase` transcript items.)
  - `command` → handle locally: `/stop`→`client.stop`, `/pause`,`/resume`, `/new`→create session, `/sessions`,`/runs`→toggle a picker notice, `/web`→show `readOnlyUrl`, `/clear`→clear notice, `/help`→show key help, `/agent <id>`/`/model <m>`→set a pending override notice.
- Keys (App-level `useInput`, gated on raw mode): `Tab` cycles focus session→sidebar→composer; `o` toggles `expanded`; `Ctrl+C`/`q` (only when composer not focused) quits **without** cancelling runs.
- Header: `daemon ● up (pid)` + session title + `N/M agents`. Footer: focus + `[tab] focus  [o] sidebar  /help`.

- [ ] **Step 1: Write the failing test**

```tsx
// replace the monitor-era "TUI App" describe in packages/cli/tests/tui.test.tsx
// with conversational-shell tests. Use the existing makeFakeClient pattern.
describe('TUI App (conversational shell)', () => {
  it('renders the composer and an empty session on launch', async () => {
    const client = makeFakeClient(); // existing helper; returns a RunControllerClient-like stub
    const sessions = new MemorySessionStore();
    const { lastFrame } = render(
      <App client={client as never} cwd="/tmp" mode="normal" sessions={sessions} now={() => 1} />,
    );
    await delay(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('›'); // composer prompt
    expect(frame).toMatch(/session ·/);
  });

  it('submitting a task creates a run in the session and tails it', async () => {
    const client = makeFakeClient();
    const sessions = new MemorySessionStore();
    const { stdin } = render(
      <App client={client as never} cwd="/tmp" mode="normal" sessions={sessions} now={() => 1} />,
    );
    await delay(20);
    stdin.write('add OAuth');
    stdin.write('\r');
    await delay(50);
    expect(client.submitToSession).toHaveBeenCalled();
    const list = await sessions.list();
    expect(list[0]?.runIds.length).toBe(1);
  });
});
```

(`makeFakeClient` must be extended to stub `submitToSession`, `resolveRunId`, `tailRun`, `stop`, `pause`, `resume`, `sendInput`, `list`. Model it on the existing fake-client helper in `tui.test.tsx`; have `submitToSession` return a token and `resolveRunId` return a fixed run id, `tailRun` immediately invoke the callback once with a minimal `{ view: initialRunView(), transcript: [] }` then return a no-op disposer.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omakase/cli exec vitest run tests/tui.test.tsx`
Expected: FAIL — App no longer matches old props / new behavior unimplemented.

- [ ] **Step 3: Write the implementation**

Rewrite `App.tsx`. Skeleton (fill helper bodies per the design notes; keep `useTerminalSize`, `loadTuiPreferences`/`saveTuiPreferences` if still useful):

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import type { DetectedAgent } from '@omakase/daemon';
import type { SessionStore, WorkMode } from '@omakase/core';
import type { DaemonStatus } from '../daemon-control.js';
import type { RunControllerClient } from '../run-client.js';
import { initialRunView, type RunView, type TranscriptItem } from '../view-model.js';
import { parseComposerInput } from '../composer-parse.js';
import { Session } from './Session.js';
import { Orchestration } from './Orchestration.js';
import { Composer } from './Composer.js';

export interface AppProps {
  client: RunControllerClient;
  cwd: string;
  mode: WorkMode;
  sessions: SessionStore;
  now?: () => number;
  token?: string;
  task?: string;
  detect?: () => Promise<DetectedAgent[]>;
  daemonStatus?: () => Promise<DaemonStatus>;
  stopDaemon?: () => Promise<unknown>;
  startDaemon?: () => Promise<unknown>;
  readOnlyUrl?: string;
}

type Focus = 'session' | 'sidebar' | 'composer';

export function App(props: AppProps): React.ReactElement {
  const now = props.now ?? (() => Date.now());
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const size = useTerminalSize();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [view, setView] = useState<RunView>(initialRunView(props.mode));
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>('composer');
  const [expanded, setExpanded] = useState(true); // sidebar expanded by default
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [notice, setNotice] = useState('');
  const tailRef = useRef<() => void>(() => {});

  // ── session bootstrap ──────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      const existing = await props.sessions.list();
      let id = existing[0]?.id ?? null;
      if (!id) {
        const created = await props.sessions.create({ id: `ses-${now()}`, title: 'session', now: now() });
        id = created.id;
      }
      setSessionId(id);
      if (props.token) await attachToken(id, props.token);
    })();
    return () => tailRef.current();
  }, []);

  // ── daemon status poll ─────────────────────────────────────────────
  useEffect(() => {
    if (!props.daemonStatus) return;
    let live = true;
    const tick = async () => { if (live) setDaemon(await props.daemonStatus!()); };
    void tick();
    const t = setInterval(() => void tick(), 1500);
    t.unref?.();
    return () => { live = false; clearInterval(t); };
  }, [props.daemonStatus]);

  async function attachRun(runId: string): Promise<void> {
    tailRef.current();
    setActiveRunId(runId);
    tailRef.current = props.client.tailRun(runId, (u) => {
      setView(u.view);
      setTranscript(u.transcript);
    });
  }

  async function attachToken(sid: string, token: string): Promise<void> {
    const runId = await props.client.resolveRunId(token);
    if (!runId) return;
    await props.sessions.appendRun(sid, runId, now());
    await attachRun(runId);
  }

  async function onSubmit(raw: string): Promise<void> {
    const intent = parseComposerInput(raw);
    if (intent.kind === 'empty' || !sessionId) return;
    if (intent.kind === 'command') return void handleCommand(intent.name, intent.args);

    // serial within a session: a follow-up during an active run is an input note
    if (activeRunId && (view.status === 'running' || view.status === 'paused')) {
      await props.client.sendInput(activeRunId, intent.kind === 'workflow' ? `/workflow ${intent.source}` : intent.prompt);
      setNotice('sent input to the running run');
      return;
    }
    const session = (await props.sessions.load(sessionId))!;
    const taskIntent =
      intent.kind === 'workflow'
        ? { prompt: intent.source, files: [] as string[] }
        : { prompt: intent.prompt, agentOverride: intent.agentOverride, files: intent.files };
    const token = await props.client.submitToSession({ rollingSummary: session.rollingSummary }, taskIntent);
    const runId = await props.client.resolveRunId(token);
    if (runId) {
      await props.sessions.appendRun(sessionId, runId, now());
      await attachRun(runId);
    }
  }

  async function handleCommand(name: string, args: string): Promise<void> {
    switch (name) {
      case 'stop': if (activeRunId) await props.client.stop(activeRunId); setNotice('stop requested'); break;
      case 'pause': if (activeRunId) await props.client.pause(activeRunId); break;
      case 'resume': if (activeRunId) await props.client.resume(activeRunId); break;
      case 'new': {
        const created = await props.sessions.create({ id: `ses-${now()}`, title: 'session', now: now() });
        tailRef.current(); setActiveRunId(null); setTranscript([]); setView(initialRunView(props.mode));
        setSessionId(created.id); break;
      }
      case 'web': setNotice(props.readOnlyUrl ? `report server: ${props.readOnlyUrl}` : 'no report server'); break;
      case 'clear': setNotice(''); break;
      case 'help': setNotice('keys: [tab] focus  [o] sidebar  /stop /pause /resume /new /web /agent /model /workflow'); break;
      default: setNotice(`unknown command: /${name}${args ? ' ' + args : ''}`);
    }
  }

  useInput(
    (input, key) => {
      if (key.tab) { setFocus((f) => (f === 'session' ? 'sidebar' : f === 'sidebar' ? 'composer' : 'session')); return; }
      if (focus !== 'composer' && (input === 'o')) setExpanded((e) => !e);
      if (focus !== 'composer' && (input === 'q')) exit();
    },
    { isActive: isRawModeSupported },
  );

  const daemonText = daemon?.alive ? `daemon ● up (${daemon.pid})` : 'daemon ○ down';
  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Box justifyContent="space-between" paddingX={1}>
        <Text bold>omakase</Text>
        <Text dimColor>{daemonText} · {view.activeAgents}/{view.totalAgents} agents</Text>
      </Box>
      <Box flexGrow={1}>
        <Session transcript={transcript} title={sessionId ?? '…'} focused={focus === 'session'} rows={size.rows - 6} />
        <Orchestration view={view} focused={focus === 'sidebar'} expanded={expanded} />
      </Box>
      <Composer focused={focus === 'composer'} hint={notice} onSubmit={(raw) => void onSubmit(raw)} />
    </Box>
  );
}
```

(Carry over `useTerminalSize` from the current file verbatim. Remove all monitor-era helpers — `stageOf`, `tasksForPhase`, `cycleAgent`, workspace logic, etc. — that no longer have callers.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @omakase/cli exec vitest run tests/tui.test.tsx`
Expected: PASS (component + shell tests).

- [ ] **Step 5: Typecheck the package (catch removed-symbol fallout) and commit**

Run: `pnpm --filter @omakase/cli typecheck`
Expected: errors only where `cli.ts` still calls the old `App`/`launchTui` contract — those are fixed in Task 12. If other files reference removed helpers, fix them now.

```bash
git add packages/cli/src/tui/App.tsx packages/cli/tests/tui.test.tsx
git commit -m "feat(cli): rewrite TUI App as conversational session shell"
```

---

## Phase 6 — CLI wiring + docs

### Task 12: Wire SessionStore into the TUI launch

**Files:**
- Modify: `packages/cli/src/cli.ts` (the `tuiCommand` / `launchTui` path)
- Modify: `packages/cli/src/tui/index.ts` (export new components if it re-exports)
- Test: `packages/cli/tests/cli.test.ts` (adjust the TUI-launch test to the new contract)

- [ ] **Step 1: Read the current launch wiring**

Run: `grep -n "launchTui\|new App\|App(\|tuiCommand\|FileRunStore\|RunControllerClient" packages/cli/src/cli.ts`
Identify where the `RunControllerClient` and `App` are constructed.

- [ ] **Step 2: Write/adjust the failing test**

In `tests/cli.test.ts`, find the test that drives `tuiCommand` (it injects a fake `launchTui`). Assert the launcher now receives a `sessions` store. Example adjustment:

```ts
// in the existing tuiCommand test, extend the fake launcher signature:
let launchedWith: { sessions?: unknown } = {};
const deps = makeCliDeps({
  launchTui: async (opts: { sessions?: unknown }) => { launchedWith = opts; },
});
await runCli(['tui', 'do something'], deps);
expect(launchedWith.sessions).toBeDefined();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @omakase/cli exec vitest run tests/cli.test.ts`
Expected: FAIL — `sessions` is undefined in the launch options.

- [ ] **Step 4: Implement the wiring**

In `cli.ts`, where the client is built for the TUI, also construct a `FileSessionStore` rooted at `<cwd>/.omakase/sessions` and pass it through to `App` via the launcher options. Concretely:

```ts
import { FileSessionStore } from '@omakase/core';
// ...
const sessions = new FileSessionStore(path.join(cwd, '.omakase', 'sessions'));
await deps.launchTui({
  client,
  cwd,
  mode,
  sessions,
  token,
  task,
  detect,
  daemonStatus,
  stopDaemon,
  startDaemon,
  readOnlyUrl,
});
```

Update the `launchTui` default implementation (the one that renders Ink) to forward `sessions` into `<App .../>`. Update the `CliDeps['launchTui']` type to include `sessions: SessionStore`.

- [ ] **Step 5: Run tests + full gate, then commit**

Run:
```bash
pnpm --filter @omakase/cli exec vitest run tests/cli.test.ts
pnpm -r typecheck && pnpm -r test
```
Expected: PASS across all packages.

```bash
git add packages/cli/src/cli.ts packages/cli/src/tui/index.ts packages/cli/tests/cli.test.ts
git commit -m "feat(cli): wire session store into the TUI launch"
```

### Task 13: Update docs (roadmap + changelog)

**Files:**
- Modify: `docs/roadmap.md` (CLI/TUI section)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the TUI bullet in `docs/roadmap.md`**

Replace the existing CLI/TUI description with the conversational model: a session groups serial runs, the transcript renders the event stream as chat, the sidebar shows the focused run's plan + agents, and the composer supports NL tasks / slash commands / `@agent` / `#file` / `/workflow`.

- [ ] **Step 2: Add a CHANGELOG entry**

Add an entry describing the conversational TUI redesign and the new `SessionStore`.

- [ ] **Step 3: Full gate + build**

Run: `pnpm -r typecheck && pnpm -r test && pnpm -r build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md CHANGELOG.md
git commit -m "docs: describe the conversational TUI and session model"
```

---

## Self-Review

**Spec coverage:**
- §2 interaction (chat + sidebar) → Tasks 8–11. ✓
- §3 session model, serial runs, context bridge → Tasks 1–2 (store), 4 (composeSessionPrompt), 7 (submitToSession), 11 (serial-input branch). ✓
- §4 layering (TUI pure client, daemon unchanged) → no daemon edits in any task. ✓
- §5.1 SessionStore → Tasks 1–2. ✓
- §5.2 Composer parse (NL/slash/@/#/workflow) → Task 3; completion menu → Task 10. ✓
- §5.3 reduceTranscript → Task 5. ✓
- §5.4 client extensions → Tasks 6–7. ✓
- §5.5 TUI shell + components, sidebar expanded default → Tasks 8–11. ✓
- §6 fold-in (`/web` for report server) → Task 11 handleCommand; drop monitor model → Task 11. ✓
- §7 tests, no real models → every task uses fakes/explicit events. ✓
- §8 file plan → matches the File Structure section. ✓

**Placeholder scan:** `#file` completion via codegraph/glob is described as live-completion UI but implemented minimally (parse only) in Task 3 — completion *menus* for `@`/`#` beyond slash are deferred and noted; not a hidden placeholder. Workflow deep-wiring is explicitly flagged as a follow-up in Task 11, with the transcript/sidebar support shipped. No "TBD"/"handle edge cases" left.

**Type consistency:** `TranscriptItem`/`reduceTranscript` (Task 5) are consumed identically in client (Task 6) and Session.tsx (Task 9). `submitToSession({ rollingSummary }, { prompt, agentOverride?, files })` (Task 7) is called with that exact shape in App (Task 11). `SessionStore` method names (`create/load/list/appendRun/updateSummary/updateTitle/delete`) are used consistently in App and cli.ts. `Orchestration({ view, focused, expanded })` and `Session({ transcript, title, focused, rows })` and `Composer({ focused, hint, onSubmit })` props match their tests.

**Known follow-ups (out of scope, intentionally):** `@`/`#` completion menus, `/sessions` and `/runs` interactive pickers (currently notices), rolling-summary auto-generation from run results (the field exists and is injected; populating it from a finished run's summary is a natural next task), and deep `/workflow` dispatch wiring.
