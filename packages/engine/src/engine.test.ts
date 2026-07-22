import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, Store, AbortError } from '@omakase/core';
import type { ProviderInfo } from '@omakase/providers';
import { runGoal, resumeRun } from './orchestrator.ts';
import { buildResumeState } from './resume.ts';
import { crystallize } from './crystallize.ts';
import { lintWorkflow } from './lint.ts';
import { parseAgentDefinition } from './agents.ts';
import { supportsPermission } from '@omakase/providers';
import { discoverWorkflows, findWorkflow } from './workflows.ts';
import { parseFrontmatter, parseCommentMeta } from './frontmatter.ts';
import { verifyGoal } from './verify.ts';
import { SubprocessHarness, MockHarness, type Harness, type HarnessRequest, type HarnessResult } from './harness.ts';
import { isRetriableAgentError } from './runtime.ts';
import { makeSystemPromptFactory } from './prompt.ts';

class FakeHarness implements Harness {
  readonly id = 'fake';
  calls: HarnessRequest[] = [];
  constructor(private responder: (req: HarnessRequest) => string | Partial<HarnessResult>) {}
  async runAgent(req: HarnessRequest): Promise<HarnessResult> {
    this.calls.push(req);
    const r = this.responder(req);
    const base: HarnessResult = {
      text: '',
      status: 'ok',
      sessionId: 'sess-x',
      tokens: 5,
      costUsd: 0.001,
      activities: [],
      durationMs: 1,
      provider: req.provider,
    };
    return typeof r === 'string' ? { ...base, text: r } : { ...base, ...r };
  }
  async listProviders(): Promise<ProviderInfo[]> {
    return [
      { id: 'claude', command: 'claude', label: 'Claude', available: true, version: '1', path: '/claude', models: ['sonnet'] },
      { id: 'codex', command: 'codex', label: 'Codex', available: true, version: '1', path: '/codex', models: ['gpt-5'] },
    ];
  }
}

function tmpWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'omks-eng-'));
  const ws = Workspace.init(dir);
  const store = new Store(':memory:');
  return { dir, ws, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('discover: built-in workflows are found', () => {
  const names = discoverWorkflows().map((m) => m.name);
  expect(names).toEqual(expect.arrayContaining(['goal', 'mission', 'tdd', 'review', 'research', 'solo']));
  const goalMeta = findWorkflow('goal');
  expect(goalMeta?.version).toBe('0.1.0');
  expect(goalMeta?.description).toContain('goal');
});

test('prompt: an agent is bounded to its current workflow step', () => {
  const system = makeSystemPromptFactory({
    goal: { text: 'build the entire product' },
    memory: '',
  })({ role: 'researcher', title: 'Map one module', prompt: 'inspect module A' });
  expect(system).toContain('Complete only the task message for this turn');
  expect(system).toContain('overarching goal below is context');
  expect(system).toContain('Do not invoke omks or another AI-agent CLI');
});

test('runGoal: solo workflow completes and logs events', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const harness = new FakeHarness(() => 'did the thing');
    const out = await runGoal({
      goal: { text: 'do X', workflow: 'solo', cwd: ws.root },
      workspace: ws,
      store,
      harness,
    });
    expect(out.status).toBe('succeeded');
    expect(harness.calls).toHaveLength(1);
    const events = store.getEvents(out.runId).map((e) => e.type);
    expect(events).toContain('run:started');
    expect(events).toContain('agent:completed');
    expect(events).toContain('run:ended');
    const reports = store.listReports(out.runId);
    expect(reports.some((r) => r.kind === 'final')).toBe(true);
  } finally {
    cleanup();
  }
});

test('runGoal: goal workflow plans, builds a pipeline, validates', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const harness = new FakeHarness((req) => {
      if (req.role === 'planner') return 'Step one\nStep two';
      if (req.role === 'reviewer') return 'none';
      return 'done';
    });
    const out = await runGoal({
      goal: { text: 'build a thing', workflow: 'goal', cwd: ws.root },
      workspace: ws,
      store,
      harness,
    });
    expect(out.status).toBe('succeeded');
    // planner(1) + 2 steps * (build + review) = 5 calls minimum
    expect(harness.calls.length).toBeGreaterThanOrEqual(5);
    const roles = harness.calls.map((c) => c.role);
    expect(roles).toContain('planner');
    expect(roles).toContain('worker');
    expect(roles).toContain('reviewer');
  } finally {
    cleanup();
  }
});

test('resume: cached agent results are not re-run', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const first = new FakeHarness(() => 'original output');
    const out = await runGoal({
      goal: { text: 'do Y', workflow: 'solo', cwd: ws.root },
      workspace: ws,
      store,
      harness: first,
    });
    expect(first.calls).toHaveLength(1);

    // Resume with a fresh harness: the solo agent should be served from cache.
    const second = new FakeHarness(() => 'should NOT be called');
    const resumed = await resumeRun(out.runId, { workspace: ws, store, harness: second });
    expect(resumed.status).toBe('succeeded');
    expect(second.calls).toHaveLength(0); // fully cached
  } finally {
    cleanup();
  }
});

test('runGoal: budget exhaustion fails the run and reports the exhaustion', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const harness = new FakeHarness((req) => (req.role === 'planner' ? 'A\nB\nC' : 'done'));
    const out = await runGoal({
      goal: { text: 'big', workflow: 'goal', cwd: ws.root },
      workspace: ws,
      store,
      harness,
      maxAgents: 1,
    });
    const events = store.getEvents(out.runId);
    expect(events.some((e) => e.type === 'agent:failed' && e.payload.error.startsWith('budget:'))).toBe(true);
    // The planner burned the only slot; every later agent was turned away, so the
    // workflow "completed" having built nothing. It must not pass as a success,
    // nor may its final report stand in as the run's summary.
    expect(out.status).toBe('failed');
    expect(store.getRun(out.runId)!.status).toBe('failed');
    expect(out.summary).toContain('max agents reached');
    expect(out.summary).not.toContain('built them');
  } finally {
    cleanup();
  }
});

test('runGoal: a run that lands exactly on its budget still succeeds', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    // 3 steps = 1 planner + 3 × (build + review) = exactly 7 agents. Spending the
    // last slot leaves no headroom, but nothing was ever denied — the work is done.
    const harness = new FakeHarness((req) => (req.role === 'planner' ? 'A\nB\nC' : 'done'));
    const out = await runGoal({
      goal: { text: 'big', workflow: 'goal', cwd: ws.root },
      workspace: ws,
      store,
      harness,
      maxAgents: 7,
    });
    expect(harness.calls).toHaveLength(7);
    const events = store.getEvents(out.runId);
    expect(events.some((e) => e.type === 'agent:failed')).toBe(false);
    expect(out.status).toBe('succeeded');
    expect(out.summary).toContain('built them');
  } finally {
    cleanup();
  }
});

test('verify: a judge criterion spends real money that lands in the run cost', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    // successCriteria are always judged by a model call. That call spends, so it
    // must show up in the run's reported cost — not vanish, leaving the total a lie.
    const harness = new FakeHarness((req) => (req.role === 'validator' ? 'PASS: looks done' : 'built it'));
    const out = await runGoal({
      goal: { text: 'do it', workflow: 'solo', cwd: ws.root, successCriteria: ['the thing is done'] },
      workspace: ws,
      store,
      harness,
    });
    expect(out.status).toBe('succeeded');
    // Exactly one worker + one judge, each 0.001 in the FakeHarness.
    const validators = harness.calls.filter((c) => c.role === 'validator');
    expect(validators).toHaveLength(1);
    expect(store.getRun(out.runId)!.spentCostUsd).toBeCloseTo(0.002, 6);
  } finally {
    cleanup();
  }
});

test('verify: command criterion passes on exit 0, fails otherwise', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const harness = new FakeHarness(() => 'ok');
    const pass = await verifyGoal({
      goal: { text: 'g', checks: [{ kind: 'command', run: 'true' }] },
      cwd: ws.root,
      harness,
      judgeProvider: 'claude',
    });
    expect(pass.met).toBe(true);

    const fail = await verifyGoal({
      goal: { text: 'g', checks: [{ kind: 'command', run: 'false' }] },
      cwd: ws.root,
      harness,
      judgeProvider: 'claude',
    });
    expect(fail.met).toBe(false);
    expect(fail.gaps.length).toBe(1);
  } finally {
    cleanup();
  }
});

test('verify: a passing check runs once per round, not once per caller', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    // The goal workflow closes its Validate phase with w.goalMet(), and the
    // orchestrator verifies straight after. No agent runs in between, so the
    // user's suite must not be executed twice.
    const log = join(ws.root, 'checks.log');
    const harness = new FakeHarness((req) => (req.role === 'planner' ? 'A' : 'ok'));
    const outcome = await runGoal({
      goal: { text: 'g', workflow: 'goal', cwd: ws.root, checks: [{ kind: 'command', run: `echo ran >> ${log}` }] },
      workspace: ws,
      store,
      harness,
    });
    expect(outcome.status).toBe('succeeded');
    expect(readFileSync(log, 'utf8').trim().split('\n').length).toBe(1);
  } finally {
    cleanup();
  }
});

test('sessions: runs attach to a session; --session continues it', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const harness = new FakeHarness(() => 'ok');
    const a = await runGoal({ goal: { text: 'A', workflow: 'solo', cwd: ws.root }, workspace: ws, store, harness });
    const runA = store.getRun(a.runId)!;
    expect(runA.sessionId).toBeTruthy();

    const b = await runGoal({
      goal: { text: 'B', workflow: 'solo', cwd: ws.root },
      workspace: ws,
      store,
      harness,
      sessionId: runA.sessionId!,
    });
    const s = store.getSession(runA.sessionId!)!;
    expect(s.runIds).toEqual(expect.arrayContaining([a.runId, b.runId]));
    expect(s.rollingSummary).toContain('succeeded');
  } finally {
    cleanup();
  }
});

test('params: w.params reaches the workflow', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    writeFileSync(
      join(ws.paths.workflows, 'echoparam.ts'),
      `export default async function echoparam(w){ w.requestReport({kind:'final', title:'p', summary: 'foo=' + String(w.params.foo)}); }\n`,
    );
    const harness = new FakeHarness(() => 'ok');
    const out = await runGoal({
      goal: { text: 'x', workflow: 'echoparam', cwd: ws.root, params: { foo: 'bar' } },
      workspace: ws,
      store,
      harness,
    });
    const rep = store.listReports(out.runId).find((r) => r.kind === 'final');
    expect(rep?.summary).toBe('foo=bar');
  } finally {
    cleanup();
  }
});

test('params: the goal loop feeds gaps to a goal that started without params', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    writeFileSync(
      join(ws.paths.workflows, 'echoround.ts'),
      `export default async function echoround(w){
        w.requestReport({kind:'final', title:'r', summary: 'round=' + String(w.params.round) + ' gaps=' + JSON.stringify(w.params.gaps ?? null)});
      }\n`,
    );
    const harness = new FakeHarness(() => 'ok');
    const out = await runGoal({
      // No params: the common CLI shape, where goal.params starts undefined.
      goal: { text: 'x', workflow: 'echoround', cwd: ws.root, checks: [{ kind: 'command', run: 'false' }] },
      workspace: ws,
      store,
      harness,
    });
    // Assert on round 1's own report rather than the last one: a stalled loop is
    // now offered an advisor and one further round, so "last" is no longer round 1.
    const reports = store.listReports(out.runId).filter((r) => r.kind === 'final');
    const round1 = reports.find((r) => r.summary.includes('round=1'));
    expect(round1).toBeDefined();
    expect(round1!.summary).toContain('exit 1');
  } finally {
    cleanup();
  }
});

test('resume: a failed agent keeps its budget slot rather than being refunded', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    // The planner completes; the first worker charges its slot and then errors,
    // so the run ends fully spent with only ONE agent:completed to replay.
    const first = new FakeHarness((req) =>
      req.role === 'planner' ? 'A' : { status: 'error' as const, text: 'worker down' },
    );
    const out = await runGoal({
      goal: { text: 'x', workflow: 'goal', cwd: ws.root },
      workspace: ws,
      store,
      harness: first,
      maxAgents: 2,
    });
    const started = store.getEvents(out.runId).filter((e) => e.type === 'agent:started').length;
    expect(started).toBe(2);
    expect(buildResumeState(store, out.runId).spentAgents).toBe(2);

    // Resuming must not hand back the failed agent's slot: the planner replays
    // from cache and there is nothing left to spend.
    const second = new FakeHarness(() => 'should NOT be called');
    await resumeRun(out.runId, { workspace: ws, store, harness: second, maxAgents: 2 });
    expect(second.calls).toHaveLength(0);
  } finally {
    cleanup();
  }
}, 15000);

test('verify: an aborted command criterion is torn down instead of answered', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const harness = new FakeHarness(() => 'ok');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const verdict = verifyGoal({
      goal: { text: 'g', checks: [{ kind: 'command', run: 'sleep 5' }] },
      cwd: ws.root,
      harness,
      judgeProvider: null,
      signal: controller.signal,
    });
    // A cancel must not wait out the check, nor come back with a verdict on it.
    expect(verdict).rejects.toThrow();
    await verdict.catch(() => {});
    expect(Date.now() - started).toBeLessThan(3000);
  } finally {
    cleanup();
  }
});

test('isolation: agents run in per-agent subdirs (w.subdir + agent cwd)', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    writeFileSync(
      join(ws.paths.workflows, 'iso.ts'),
      `export default async function iso(w){
        await w.parallel([
          () => w.agent({title:'A', prompt:'x', cwd:'compA'}),
          () => { w.subdir('compB'); return w.agent({title:'B', prompt:'x', cwd:'compB'}); },
        ]);
      }\n`,
    );
    const harness = new FakeHarness(() => 'ok');
    await runGoal({ goal: { text: 'iso', workflow: 'iso', cwd: ws.root }, workspace: ws, store, harness });
    const cwds = harness.calls.map((c) => c.cwd);
    expect(cwds.some((c) => c.endsWith('/compA'))).toBe(true);
    expect(cwds.some((c) => c.endsWith('/compB'))).toBe(true);
    expect(existsSync(join(ws.root, 'compA'))).toBe(true);
    expect(existsSync(join(ws.root, 'compB'))).toBe(true);
  } finally {
    cleanup();
  }
});

const FAKE_CLAUDE_BODY = `
const args = process.argv.slice(2);
const si = args.indexOf('--session-id');
const sessionId = si >= 0 && args[si + 1] ? args[si + 1] : 'fake-sess';
await Bun.stdin.text().catch(() => '');
await Bun.write('built.txt', 'ok');
const out = [
  { type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-1' },
  { type: 'result', subtype: 'success', result: 'Built built.txt', session_id: sessionId, is_error: false, usage: { input_tokens: 5, output_tokens: 10 }, total_cost_usd: 0.0001 },
];
process.stdout.write(out.map((o) => JSON.stringify(o)).join('\\n') + '\\n');
`;

test('FULL STACK: runGoal via real SubprocessHarness + fake binary + command verify', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  const bin = mkdtempSync(join(tmpdir(), 'omks-bin-'));
  try {
    const fake = join(bin, 'fake-claude.ts');
    // Absolute interpreter path — robust across OSes/CI (no PATH lookup).
    writeFileSync(fake, `#!${process.execPath}${FAKE_CLAUDE_BODY}`);
    chmodSync(fake, 0o755);

    // Real spawn/stream-parse path — only the binary is faked.
    const harness = new SubprocessHarness({ commandFor: (id) => (id === 'claude' ? fake : undefined) });
    const out = await runGoal({
      goal: {
        text: 'build the thing',
        workflow: 'solo',
        cwd: ws.root,
        provider: 'claude',
        checks: [{ kind: 'command', run: 'test -f built.txt' }],
      },
      workspace: ws,
      store,
      harness,
    });

    expect(out.status).toBe('succeeded');
    expect(existsSync(join(ws.root, 'built.txt'))).toBe(true);
    const events = store.getEvents(out.runId);
    const completed = events.find((e) => e.type === 'agent:completed');
    expect(completed).toBeTruthy();
    expect(events.some((e) => e.type === 'goal:evaluated' && e.payload.verdict === 'met')).toBe(true);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    cleanup();
  }
}, 30000);

test('auto: self-orchestrated DAG runs deps in order with context passing', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const plan = JSON.stringify({
      steps: [
        { id: 'a', role: 'worker', title: 'Build A', prompt: 'build a', dependsOn: [] },
        { id: 'b', role: 'worker', title: 'Build B', prompt: 'build b', dependsOn: [] },
        { id: 'c', role: 'reviewer', title: 'Review', prompt: 'review', dependsOn: ['a', 'b'] },
      ],
    });
    const harness = new FakeHarness((req) => {
      if (req.title === 'Design the plan') return `Here is the plan:\n${plan}`;
      return `output of ${req.title}`;
    });
    const out = await runGoal({
      goal: { text: 'ship a feature', workflow: 'auto', cwd: ws.root },
      workspace: ws,
      store,
      harness,
    });
    expect(out.status).toBe('succeeded');

    const titles = harness.calls.map((c) => c.title);
    const iA = titles.indexOf('Build A');
    const iB = titles.indexOf('Build B');
    const iC = titles.indexOf('Review');
    expect(iA).toBeGreaterThanOrEqual(0);
    expect(iB).toBeGreaterThanOrEqual(0);
    // The reviewer depends on A and B, so it runs in a later wave.
    expect(iC).toBeGreaterThan(iA);
    expect(iC).toBeGreaterThan(iB);
    // Dependency outputs are passed into the dependent step's prompt.
    const reviewCall = harness.calls.find((c) => c.title === 'Review')!;
    expect(reviewCall.prompt).toContain('Context from earlier steps');
    expect(reviewCall.prompt).toContain('output of Build A');
  } finally {
    cleanup();
  }
});

test('auto: routes a step to the provider chosen by the orchestrator', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const plan = JSON.stringify({
      steps: [
        { id: 'a', role: 'worker', title: 'Build A', prompt: 'build a', provider: 'codex', dependsOn: [] },
        { id: 'b', role: 'reviewer', title: 'Review', prompt: 'review', dependsOn: ['a'] },
      ],
    });
    const harness = new FakeHarness((req) => (req.title === 'Design the plan' ? plan : 'ok'));
    const out = await runGoal({ goal: { text: 'x', workflow: 'auto', cwd: ws.root }, workspace: ws, store, harness });
    expect(out.status).toBe('succeeded');
    const a = harness.calls.find((c) => c.title === 'Build A')!;
    const b = harness.calls.find((c) => c.title === 'Review')!;
    expect(a.provider).toBe('codex'); // routed as the plan requested
    expect(b.provider).toBe('claude'); // default
  } finally {
    cleanup();
  }
});

test('auto: an explicit run provider overrides plan and named-agent provider hints', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    writeFileSync(
      join(ws.paths.agents, 'claude-worker.md'),
      `---\nname: claude-worker\nrole: worker\nprovider: claude\n---\nwork\n`,
    );
    const plan = JSON.stringify({
      steps: [
        { id: 'a', role: 'worker', title: 'Pinned', prompt: 'work', provider: 'claude', agent: 'claude-worker', dependsOn: [] },
      ],
    });
    const harness = new FakeHarness((req) => (req.title === 'Design the plan' ? plan : 'ok'));
    const out = await runGoal({
      goal: { text: 'x', workflow: 'auto', cwd: ws.root, provider: 'codex' },
      workspace: ws,
      store,
      harness,
    });
    expect(out.status).toBe('succeeded');
    expect(harness.calls.every((call) => call.provider === 'codex')).toBe(true);
    expect(harness.calls[0]!.prompt).toContain('pins provider "codex"');
  } finally {
    cleanup();
  }
});

test('accumulation: auto records a recipe and recalls it next time', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const plan = JSON.stringify({ steps: [{ id: 'a', role: 'worker', title: 'Do', prompt: 'do', dependsOn: [] }] });
    const harness = new FakeHarness((req) => (req.title === 'Design the plan' ? plan : 'ok'));

    await runGoal({ goal: { text: 'first goal', workflow: 'auto', cwd: ws.root }, workspace: ws, store, harness });
    expect(store.listWiki().some((e) => e.title.startsWith('recipe:'))).toBe(true);

    await runGoal({ goal: { text: 'second goal', workflow: 'auto', cwd: ws.root }, workspace: ws, store, harness });
    const planCalls = harness.calls.filter((c) => c.title === 'Design the plan');
    expect(planCalls.length).toBe(2);
    // The second run recalls the first run's recipe.
    expect(planCalls[1]!.prompt).toContain('worked before');
  } finally {
    cleanup();
  }
});

test('isolate: parallel work merges back via git worktrees', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const g = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: ws.root, stdout: 'ignore', stderr: 'ignore' });
    g(['init', '-q']);
    g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init']);

    writeFileSync(
      join(ws.paths.workflows, 'iso2.ts'),
      `export default async function iso2(w){
        await w.parallel([
          () => w.isolate('compA', async (dir) => { await Bun.write(dir + '/a.txt', 'A'); }),
          () => w.isolate('compB', async (dir) => { await Bun.write(dir + '/b.txt', 'B'); }),
        ]);
      }\n`,
    );
    const harness = new FakeHarness(() => 'ok');
    await runGoal({ goal: { text: 'iso', workflow: 'iso2', cwd: ws.root }, workspace: ws, store, harness });

    // Both isolated branches merged their distinct files back into the base.
    expect(existsSync(join(ws.root, 'a.txt'))).toBe(true);
    expect(existsSync(join(ws.root, 'b.txt'))).toBe(true);
    expect(readFileSync(join(ws.root, 'a.txt'), 'utf8')).toBe('A');
    // No leftover worktrees.
    const wt = Bun.spawnSync(['git', 'worktree', 'list'], { cwd: ws.root, stdout: 'pipe', stderr: 'ignore' }).stdout.toString();
    expect(wt.split('\n').filter((l) => l.trim()).length).toBe(1);
  } finally {
    cleanup();
  }
}, 20000);

test('isolate: a throwing callback keeps its worktree instead of force-removing it', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  let wtPath = '';
  try {
    const g = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: ws.root, stdout: 'ignore', stderr: 'ignore' });
    g(['init', '-q']);
    g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init']);

    writeFileSync(
      join(ws.paths.workflows, 'iso3.ts'),
      `export default async function iso3(w){
        await w.isolate('compA', async (dir) => {
          await Bun.write(dir + '/agent-work.txt', 'WORK');
          throw new Error('boom');
        });
      }\n`,
    );
    const harness = new FakeHarness(() => 'ok');
    const out = await runGoal({ goal: { text: 'iso', workflow: 'iso3', cwd: ws.root }, workspace: ws, store, harness });
    expect(out.status).toBe('failed');

    // Nothing was committed, so the branch holds none of the work — the worktree
    // is the only copy of it and must survive for the user to recover.
    const list = Bun.spawnSync(['git', 'worktree', 'list'], { cwd: ws.root, stdout: 'pipe', stderr: 'ignore' })
      .stdout.toString()
      .split('\n')
      .filter((l) => l.trim());
    expect(list.length).toBe(2);
    wtPath = list[1]!.split(' ')[0]!;
    expect(readFileSync(join(wtPath, 'agent-work.txt'), 'utf8')).toBe('WORK');
  } finally {
    if (wtPath) rmSync(wtPath, { recursive: true, force: true });
    cleanup();
  }
}, 20000);

test('fallback: switches to the next provider when the first fails', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const harness = new FakeHarness((req) =>
      req.provider === 'claude' ? { status: 'error', text: 'claude down' } : 'ok from codex',
    );
    const out = await runGoal({ goal: { text: 'x', workflow: 'solo', cwd: ws.root }, workspace: ws, store, harness });
    expect(out.status).toBe('succeeded');
    const events = store.getEvents(out.runId);
    expect(events.some((e) => e.type === 'harness:switched' && e.payload.to === 'codex')).toBe(true);
    expect(store.getEvents(out.runId).find((e) => e.type === 'agent:completed')?.payload).toMatchObject({ text: expect.stringContaining('codex') });
  } finally {
    cleanup();
  }
}, 15000);

test('retry: deterministic setup/auth errors fail over without repeating', () => {
  expect(isRetriableAgentError(new Error('Your organization has disabled Claude subscription access'))).toBe(false);
  expect(isRetriableAgentError(new Error("error: unexpected argument '-o' found"))).toBe(false);
  expect(isRetriableAgentError(new Error("gemini cannot run in 'read-only' mode: no flag that expresses it"))).toBe(false);
  expect(isRetriableAgentError(new Error("Error during discovery for MCP server 'codegraph'"))).toBe(false);
  expect(isRetriableAgentError(new Error('connection reset by peer'))).toBe(true);
});

test('model: --model reaches the selected provider but is not leaked into fallback providers', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const harness = new FakeHarness((req) =>
      req.provider === 'codex' ? { status: 'error' as const, text: 'unauthorized: login required' } : 'fallback ok',
    );
    const out = await runGoal({
      goal: { text: 'x', workflow: 'solo', cwd: ws.root, provider: 'codex', model: 'gpt-5' },
      workspace: ws,
      store,
      harness,
    });
    expect(out.status).toBe('succeeded');
    expect(harness.calls.map((c) => [c.provider, c.model])).toEqual([
      ['codex', 'gpt-5'],
      ['claude', undefined],
    ]);
  } finally {
    cleanup();
  }
});

test('model precedence: CLI pin beats workflow hints; workspace default fills an unset model', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    ws.updateSettings({ defaultModel: 'workspace-default' });
    writeFileSync(
      join(ws.paths.workflows, 'model-hint.ts'),
      `export default async function modelHint(w) {
        const result = await w.agent({ role: 'worker', title: 'hinted', prompt: 'x', model: 'workflow-hint' });
        if (result.status !== 'ok') throw new Error(result.text);
      }\n`,
    );
    const pinnedHarness = new FakeHarness(() => 'ok');
    const pinned = await runGoal({
      goal: { text: 'x', workflow: 'model-hint', cwd: ws.root, model: 'cli-pin' },
      workspace: ws,
      store,
      harness: pinnedHarness,
    });
    expect(pinned.status).toBe('succeeded');
    expect(pinnedHarness.calls[0]?.model).toBe('cli-pin');

    const defaultHarness = new FakeHarness(() => 'ok');
    const withDefault = await runGoal({
      goal: { text: 'x', workflow: 'solo', cwd: ws.root },
      workspace: ws,
      store,
      harness: defaultHarness,
    });
    expect(withDefault.status).toBe('succeeded');
    expect(defaultHarness.calls[0]?.model).toBe('workspace-default');
  } finally {
    cleanup();
  }
});

test('built-ins: no required agent failure can become a green run', async () => {
  for (const workflow of ['goal', 'auto', 'mission', 'tdd', 'review', 'research', 'parallel', 'solo']) {
    const { ws, store, cleanup } = tmpWorkspace();
    try {
      const harness = new FakeHarness(() => ({ status: 'error' as const, text: 'unauthorized: login required' }));
      const out = await runGoal({ goal: { text: 'x', workflow, cwd: ws.root }, workspace: ws, store, harness });
      expect({ workflow, status: out.status }).toEqual({ workflow, status: 'failed' });
      expect(store.listReports(out.runId).some((r) => r.kind === 'final')).toBe(false);
    } finally {
      cleanup();
    }
  }
});

test('auto: a failed dependency blocks its dependents and fails the workflow', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const harness = new FakeHarness((req) => {
      if (req.role === 'planner') {
        return JSON.stringify({
          steps: [
            { id: 'source', role: 'researcher', title: 'Source', prompt: 'inspect', dependsOn: [] },
            { id: 'write', role: 'worker', title: 'Write', prompt: 'write it', dependsOn: ['source'] },
          ],
        });
      }
      if (req.title === 'Source') return { status: 'error' as const, text: 'unauthorized: login required' };
      return 'DEPENDENT MUST NOT RUN';
    });
    const out = await runGoal({
      goal: { text: 'make a report', workflow: 'auto', cwd: ws.root },
      workspace: ws,
      store,
      harness,
    });
    expect(out.status).toBe('failed');
    expect(harness.calls.filter((c) => c.title === 'Source')).toHaveLength(2); // one per compatible provider, no retries
    expect(harness.calls.some((c) => c.title === 'Write')).toBe(false);
    expect(store.getRun(out.runId)!.error).toContain('failed: source');
    const logs = store.getEvents(out.runId).filter((e) => e.type === 'log').map((e) => e.payload.message);
    expect(logs.some((m) => m.includes('Skipped write'))).toBe(true);
  } finally {
    cleanup();
  }
});

test('MockHarness: drives every built-in workflow to success (no cost)', async () => {
  for (const wf of ['goal', 'auto', 'mission', 'tdd', 'review', 'research', 'parallel', 'solo']) {
    const { ws, store, cleanup } = tmpWorkspace();
    try {
      const harness = new MockHarness();
      const out = await runGoal({ goal: { text: 'x', workflow: wf, cwd: ws.root }, workspace: ws, store, harness });
      expect(out.status).toBe('succeeded');
      expect(harness.calls.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  }
});

test('journal: run events are mirrored to .omks/runs/<id>.jsonl', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const harness = new FakeHarness(() => 'ok');
    const out = await runGoal({ goal: { text: 'x', workflow: 'solo', cwd: ws.root }, workspace: ws, store, harness });
    const file = join(ws.paths.runs, `${out.runId}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const types = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).type);
    expect(types).toContain('run:started');
    expect(types).toContain('agent:completed');
    expect(types).toContain('run:ended');
  } finally {
    cleanup();
  }
});

test('example: ship-feature (folder format) loads and runs with a mock harness', async () => {
  const exampleDir = join(import.meta.dir, '..', '..', '..', 'examples', 'workflows', 'ship-feature');
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    cpSync(exampleDir, join(ws.paths.workflows, 'ship-feature'), { recursive: true });
    const meta = findWorkflow('ship-feature', { workspace: ws.paths.workflows });
    expect(meta?.version).toBe('1.0.0');
    expect(meta?.scope).toBe('workspace');
    expect(meta?.allowedProviders).toContain('claude');

    const harness = new MockHarness();
    const out = await runGoal({ goal: { text: 'build x', workflow: 'ship-feature', cwd: ws.root }, workspace: ws, store, harness });
    expect(out.status).toBe('succeeded');
    expect(harness.calls.length).toBeGreaterThan(0);
  } finally {
    cleanup();
  }
});

test('case study: the crystallized Grok report workflow remains executable', async () => {
  const exampleDir = join(import.meta.dir, '..', '..', '..', 'examples', 'case-studies', 'grok-build-vs-omakase', 'workflow');
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    cpSync(exampleDir, join(ws.paths.workflows, 'zh-report-v2'), { recursive: true });
    const meta = findWorkflow('zh-report-v2', { workspace: ws.paths.workflows });
    expect(meta?.version).toBe('0.1.0');

    const harness = new MockHarness();
    const out = await runGoal({ goal: { text: 'compare two systems', workflow: 'zh-report-v2', cwd: ws.root }, workspace: ws, store, harness });
    expect(out.status).toBe('succeeded');
    expect(harness.calls).toHaveLength(4);
    expect(harness.calls.find((call) => call.title === '只读审阅内容与版式克制性')?.permission).toBe('read-only');
    const steps = store
      .getEvents(out.runId)
      .filter((event) => event.type === 'agent:started')
      .map((event) => ({ id: event.payload.workflowStepId, dependsOn: event.payload.dependsOn }));
    expect(steps).toEqual([
      { id: 's1', dependsOn: [] },
      { id: 's2', dependsOn: ['s1'] },
      { id: 's3', dependsOn: ['s2'] },
      { id: 's4', dependsOn: ['s3'] },
    ]);
  } finally {
    cleanup();
  }
});

test('ask: uses the answerer, journals the answer, and replays it on resume', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    writeFileSync(
      join(ws.paths.workflows, 'asker.ts'),
      `export default async function asker(w){ const a = await w.ask('color?', {options:['red','blue']}); w.requestReport({kind:'final', title:'picked', summary: a}); }\n`,
    );
    let asks = 0;
    const answerer = async () => {
      asks++;
      return 'blue';
    };
    const harness = new FakeHarness(() => 'ok');
    const out = await runGoal({ goal: { text: 'x', workflow: 'asker', cwd: ws.root }, workspace: ws, store, harness, ask: answerer });
    expect(store.listReports(out.runId).find((r) => r.kind === 'final')?.summary).toBe('blue');
    expect(asks).toBe(1);
    // events journaled the ask + answer
    const types = store.getEvents(out.runId).map((e) => e.type);
    expect(types).toContain('user:asked');
    expect(types).toContain('user:answered');

    // resume: the answer is replayed from cache — the answerer is NOT called again
    const resumed = await resumeRun(out.runId, { workspace: ws, store, harness, ask: answerer });
    expect(asks).toBe(1);
    expect(store.listReports(resumed.runId).filter((r) => r.kind === 'final').at(-1)?.summary).toBe('blue');
  } finally {
    cleanup();
  }
});

test('cancel: an aborted run reports cancelled, not succeeded', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const controller = new AbortController();
    // Abort while the agent is in flight; the workflow then finishes "normally"
    // with an aborted agent and NO success criteria — the run must still be cancelled.
    const harness = new FakeHarness(() => {
      controller.abort();
      return { status: 'error' as const, text: 'Cancelled' };
    });
    const out = await runGoal({
      goal: { text: 'long job', workflow: 'solo', cwd: ws.root },
      workspace: ws,
      store,
      harness,
      signal: controller.signal,
    });
    expect(out.status).toBe('cancelled');
    expect(store.getRun(out.runId)!.status).toBe('cancelled');
  } finally {
    cleanup();
  }
});

test('cancel: an agent cut short mid-turn reports the cancel, not a failure', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const controller = new AbortController();
    // A real turn is a subprocess: cancelling kills it and the call throws.
    const harness = new FakeHarness(() => {
      controller.abort();
      throw new AbortError();
    });
    const out = await runGoal({
      goal: { text: 'long job', workflow: 'solo', cwd: ws.root },
      workspace: ws,
      store,
      harness,
      signal: controller.signal,
    });
    expect(out.status).toBe('cancelled');
    const failed = store.getEvents(out.runId).filter((e) => e.type === 'agent:failed');
    expect(failed).toHaveLength(1);
    // 'agent failed' is the generic initializer — it would read as a real break.
    expect(failed[0]!.payload.error).toBe('aborted');
  } finally {
    cleanup();
  }
});

test('discover: parallel built-in is present', () => {
  const names = discoverWorkflows().map((m) => m.name);
  expect(names).toContain('parallel');
});

test('frontmatter: parses scalars, arrays, block lists + comment meta', () => {
  const { data, body } = parseFrontmatter(
    ['---', 'name: demo', 'version: 1.2.0', 'auto: true', 'tags: [a, b]', 'items:', '  - one', '  - two', '---', '# Body'].join('\n'),
  );
  expect(data.name).toBe('demo');
  expect(data.version).toBe('1.2.0');
  expect(data.auto).toBe(true);
  expect(data.tags).toEqual(['a', 'b']);
  expect(data.items).toEqual(['one', 'two']);
  expect(body.trim()).toBe('# Body');

  const cm = parseCommentMeta('// name: X\n// version: 0.3.0\nexport default 1;');
  expect(cm.name).toBe('X');
  expect(cm.version).toBe('0.3.0');
});

test('advisor: a stalled loop is advised once, and the advice reaches the agents', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    // A check that never passes: the fix agents will close two rounds on the
    // same gap, which is exactly the stall the advisor exists for.
    const seen: string[] = [];
    const harness = new FakeHarness((req) => {
      seen.push(`${req.role}:${req.title}`);
      if (req.role === 'advisor') {
        return '{"headline":"the check greps a file nobody writes","advice":"create docs/api.md before re-running the check"}';
      }
      // Record whether a worker was briefed with the advice.
      if (req.role === 'worker' && req.systemPrompt?.includes('ADVICE')) seen.push('worker-briefed');
      return req.role === 'planner' ? 'Write the doc' : 'done';
    });
    const out = await runGoal({
      goal: { text: 'document the API', workflow: 'goal', cwd: ws.root, checks: [{ kind: 'command', run: 'false' }] },
      workspace: ws,
      store,
      harness,
      maxRounds: 4,
    });

    const advisorCalls = harness.calls.filter((c) => c.role === 'advisor');
    expect(advisorCalls).toHaveLength(1); // consulted, and only once
    // The advisor is handed the evidence, not asked to go dig for it.
    expect(advisorCalls[0]!.prompt).toContain('document the API');
    // Read-only is enforced through the provider's own sandbox flags now,
    // not merely requested.
    expect(advisorCalls[0]!.permission).toBe('read-only');
    // Its suggestion then briefs the agents that run afterwards.
    expect(seen).toContain('worker-briefed');
    // It buys a round, but a loop that stalls again still ends.
    expect(out.status).toBe('failed');
    const logs = store.getEvents(out.runId).filter((e) => e.type === 'log').map((e) => e.payload.message);
    expect(logs.some((m) => m.startsWith('Advice:'))).toBe(true);
  } finally {
    cleanup();
  }
});

test('crystallize: a run is saved as a workflow that runs again', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    // A run with two phases and a genuinely parallel pair, so the saved source
    // has to reproduce both the ordering and the concurrency.
    const harness = new FakeHarness((req) => (req.role === 'planner' ? 'A\nB' : 'done'));
    const first = await runGoal({
      goal: { text: 'audit the API surface', workflow: 'goal', cwd: ws.root },
      workspace: ws,
      store,
      harness,
    });

    const built = crystallize({
      name: 'api-audit',
      goalText: 'audit the API surface',
      events: store.getEvents(first.runId),
      sourceWorkflow: 'goal',
    })!;
    expect(built).not.toBeNull();
    expect(built.phases).toEqual(['Plan', 'Build', 'Validate'].slice(0, built.phases.length));
    // The original goal is gone from the prompts, replaced by the interpolation
    // that produced it — otherwise the workflow would only ever fit one goal.
    expect(built.script).not.toContain('audit the API surface');
    expect(built.script).toContain('${w.goal.text}');
    expect(built.script).toContain('w.parallel('); // the concurrent build steps
    expect(built.doc).toContain('name: api-audit');
    expect(built.doc).toContain('version: 0.1.0');
    expect(built.doc).toContain('when_to_use:');

    // The real assertion: write it where a workflow lives and run it.
    const dir = join(ws.paths.workflows, 'api-audit');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workflow.ts'), built.script);
    writeFileSync(join(dir, 'WORKFLOW.md'), built.doc);

    const replay = new FakeHarness(() => 'done');
    const second = await runGoal({
      goal: { text: 'audit the auth module instead', workflow: 'api-audit', cwd: ws.root },
      workspace: ws,
      store,
      harness: replay,
    });
    expect(second.status).toBe('succeeded');
    expect(replay.calls.length).toBeGreaterThanOrEqual(built.stepCount);
    // It is running against its *own* goal, not the one it was saved from.
    expect(replay.calls.some((c) => c.prompt.includes('audit the auth module instead'))).toBe(true);
  } finally {
    cleanup();
  }
});

test('crystallize: refuses runs with nothing to save, and survives odd prompts', async () => {
  // A run that never dispatched an agent is not a workflow.
  expect(crystallize({ name: 'x', goalText: 'g', events: [], sourceWorkflow: 'goal' })).toBeNull();

  // Backticks and ${} in a prompt must not break out of the template literal
  // they are pasted into — that would emit source that does not parse.
  const hostile = 'use `code` and ${injected} and a backslash \\ here';
  const events = [
    { runId: 'r', seq: 1, type: 'phase:started', payload: { name: 'Go', index: 0 }, createdAt: 0 },
    {
      runId: 'r', seq: 2, type: 'agent:started',
      payload: { callId: 'a1', stepKey: 's', role: 'worker', title: "it's tricky", provider: 'claude', model: null, prompt: hostile, attempt: 1 },
      createdAt: 0,
    },
    {
      runId: 'r', seq: 3, type: 'agent:completed',
      payload: { callId: 'a1', stepKey: 's', text: 'ok', status: 'ok', providerSessionId: null, tokens: 1, costUsd: 0, durationMs: 1 },
      createdAt: 0,
    },
  ] as never;
  const built = crystallize({ name: 'Odd Name!', goalText: 'g', events, sourceWorkflow: 'auto' })!;
  expect(built.name).toBe('odd-name'); // slugified into a usable workflow name
  expect(built.script).toContain('\\`code\\`');
  expect(built.script).toContain('\\${injected}');
  expect(built.script).toContain("title: 'it\\'s tricky'");

  // Escaping is only correct if the emitted source actually parses and runs —
  // asserting on the text alone would not catch a broken template literal.
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    const dir = join(ws.paths.workflows, built.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workflow.ts'), built.script);
    const harness = new FakeHarness(() => 'ok');
    const out = await runGoal({ goal: { text: 'anything', workflow: built.name, cwd: ws.root }, workspace: ws, store, harness });
    expect(out.status).toBe('succeeded');
    // The hostile characters reached the agent intact, not mangled by escaping.
    expect(harness.calls[0]!.prompt).toContain('`code`');
    expect(harness.calls[0]!.prompt).toContain('${injected}');
  } finally {
    cleanup();
  }
});

test('lint: flags real nondeterminism, ignores it in comments and strings', () => {
  const src = [
    '// name: x   Math.random() here is prose, not code',
    "const a = 'Date.now() in a string';",
    'const b = `a prompt telling an agent to avoid Math.random()`;',
    '/* Date.now() in a block comment */',
    'const real = Math.random();',
    'const stamp = Date.now();',
    'await w.agent({ role: "worker", title: "t", prompt: "p" });',
  ].join('\n');
  const { findings, ok } = lintWorkflow(src);
  const errors = findings.filter((f) => f.level === 'error');
  // Exactly the two real calls, on their real lines — the four decoys are quiet.
  expect(errors).toHaveLength(2);
  expect(errors[0]!.line).toBe(5);
  expect(errors[0]!.rule).toBe('no-random');
  expect(errors[1]!.line).toBe(6);
  expect(errors[1]!.rule).toBe('no-clock');
  expect(ok).toBe(false);
});

test('lint: an interpolation is code, so it is still checked', () => {
  // The literal parts of a template are text, but ${...} is not — a workflow
  // cannot smuggle a clock read through it.
  const { findings } = lintWorkflow('const p = `run at ${Date.now()} ok`;\nawait w.agent({});');
  expect(findings.some((f) => f.rule === 'no-clock' && f.level === 'error')).toBe(true);
});

test('lint: a clean workflow passes; a silent one is only advised', () => {
  const clean = "await w.phase('Go', async () => { await w.agent({ role: 'worker', title: 't', prompt: 'p' }); });";
  expect(lintWorkflow(clean).findings).toHaveLength(0);

  // Doing nothing is suspicious but legal — it must not fail a build on its own.
  const silent = "w.log('hello');";
  const res = lintWorkflow(silent);
  expect(res.ok).toBe(true);
  expect(res.findings.some((f) => f.level === 'warning' && f.rule === 'no-dispatch')).toBe(true);
});

test('lint: every built-in workflow is clean', () => {
  // The rules exist to protect resume; the workflows omakase ships must obey them.
  for (const meta of discoverWorkflows()) {
    const { findings } = lintWorkflow(readFileSync(meta.entry, 'utf8'));
    const errors = findings.filter((f) => f.level === 'error');
    expect({ workflow: meta.name, errors }).toEqual({ workflow: meta.name, errors: [] });
  }
});

test('crystallize output passes lint, even when agents talked about the clock', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    // The two features have to agree: --save-as embeds prompts as template
    // literals, and lint treats a template body as text. Otherwise a run whose
    // agents merely *discussed* Math.random() would emit a workflow that its
    // own linter rejects.
    const harness = new FakeHarness((req) =>
      req.role === 'planner' ? 'Audit Math.random() calls\nAudit Date.now() calls' : 'done',
    );
    const out = await runGoal({
      goal: { text: 'audit timing code', workflow: 'goal', cwd: ws.root },
      workspace: ws,
      store,
      harness,
    });
    const built = crystallize({
      name: 'gen',
      goalText: 'audit timing code',
      events: store.getEvents(out.runId),
      sourceWorkflow: 'goal',
    })!;
    expect(built.script).toContain('Math.random()'); // it really is in there, as prompt text
    expect(lintWorkflow(built.script).ok).toBe(true); // and lint knows that is text
  } finally {
    cleanup();
  }
});

test('advisor: stays silent rather than run with write access it cannot drop', () => {
  // gemini has one all-or-nothing switch, so "look but do not touch" is not
  // something it can promise. Better no advice than an advisor able to edit the
  // repository it was asked to diagnose.
  expect(supportsPermission('gemini', 'read-only')).toBe(false);
  expect(supportsPermission('claude', 'read-only')).toBe(true);
});

test('permission: a per-agent override beats the run-wide mode', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    writeFileSync(
      join(ws.paths.workflows, 'mixed.ts'),
      `export default async function mixed(w){
        await w.agent({ role: 'worker', title: 'build', prompt: 'do it' });
        await w.agent({ role: 'reviewer', title: 'review', prompt: 'look', permission: 'read-only' });
      }\n`,
    );
    const harness = new FakeHarness(() => 'ok');
    await runGoal({
      goal: { text: 'g', workflow: 'mixed', cwd: ws.root },
      workspace: ws,
      store,
      harness,
      permission: 'edit',
    });
    // The run is allowed to edit; the reviewer explicitly is not.
    expect(harness.calls[0]!.permission).toBe('edit');
    expect(harness.calls[1]!.permission).toBe('read-only');
  } finally {
    cleanup();
  }
});

test('crystallize: the turn that designed the plan is not saved into it', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    // `auto` pays a planner to choose a shape, then executes it. Once that shape
    // is written into source the decision is fixed, so keeping the planner would
    // spend a turn per run on output nothing reads — which is exactly what the
    // first real --save-as produced.
    const harness = new FakeHarness((req) =>
      req.role === 'planner'
        ? '{"steps":[{"id":"a","role":"worker","title":"Do it","prompt":"work","dependsOn":[]}]}'
        : 'done',
    );
    const out = await runGoal({
      goal: { text: 'ship the thing', workflow: 'auto', cwd: ws.root },
      workspace: ws,
      store,
      harness,
    });
    const built = crystallize({
      name: 'saved',
      goalText: 'ship the thing',
      events: store.getEvents(out.runId),
      sourceWorkflow: 'auto',
    })!;
    expect(built.script).not.toContain("role: 'planner'");
    expect(built.script).toContain("title: 'Do it'"); // the work it planned is kept
    expect(built.doc).toContain('planning turn'); // and the omission is stated
  } finally {
    cleanup();
  }
});

test('crystallize: preserves a dynamic DAG and named-agent safety without freezing runtime output', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    writeFileSync(
      join(ws.paths.agents, 'strict-reviewer.md'),
      `---\nname: strict-reviewer\nrole: reviewer\nprovider: codex\npermission: read-only\nisolate: true\n---\nCite exact evidence.\n`,
    );
    const planner = JSON.stringify({
      steps: [
        { id: 'source', role: 'researcher', title: 'Gather evidence', prompt: 'inspect audit one', dependsOn: [] },
        { id: 'review', role: 'reviewer', title: 'Review evidence', prompt: 'review it', agent: 'strict-reviewer', dependsOn: ['source'] },
      ],
    });
    const firstHarness = new FakeHarness((req) => {
      if (req.role === 'planner') return planner;
      if (req.title === 'Gather evidence') return 'RUNTIME OUTPUT MUST NOT BE FROZEN';
      return 'approved';
    });
    const first = await runGoal({
      goal: { text: 'audit one', workflow: 'auto', cwd: ws.root },
      workspace: ws,
      store,
      harness: firstHarness,
    });
    expect(first.status).toBe('succeeded');

    const started = store.getEvents(first.runId).filter((e) => e.type === 'agent:started');
    const gather = started.find((e) => e.payload.title === 'Gather evidence')!;
    const review = started.find((e) => e.payload.title === 'Review evidence')!;
    expect(gather.payload).toMatchObject({ workflowStepId: 'source', dependsOn: [], sourcePrompt: 'inspect audit one' });
    expect(review.payload).toMatchObject({
      workflowStepId: 'review',
      dependsOn: ['source'],
      agentName: 'strict-reviewer',
      permission: 'read-only',
      isolated: true,
      sourcePrompt: 'review it',
    });
    expect(review.payload.prompt).toContain('RUNTIME OUTPUT MUST NOT BE FROZEN');

    const built = crystallize({
      name: 'safe-review',
      goalText: 'audit one',
      events: store.getEvents(first.runId),
      sourceWorkflow: 'auto',
    })!;
    expect(built.script).not.toContain('RUNTIME OUTPUT MUST NOT BE FROZEN');
    expect(built.script).toContain("as: 'strict-reviewer'");
    expect(built.script).toContain("permission: 'read-only'");
    expect(built.script).toContain('isolate: true');
    expect(built.script).toContain('stepResults');
    expect(built.script).toContain("workflowStep: {");
    expect(built.script).toContain("id: 'review'");
    expect(built.script).toContain("dependsOn: [\"source\"]");
    expect(built.script).toContain("status !== 'ok'");

    const dir = join(ws.paths.workflows, built.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workflow.ts'), built.script);
    writeFileSync(join(dir, 'WORKFLOW.md'), built.doc);
    const replay = new FakeHarness((req) => (req.title === 'Gather evidence' ? 'FRESH EVIDENCE' : 'approved'));
    const second = await runGoal({
      goal: { text: 'audit two', workflow: built.name, cwd: ws.root },
      workspace: ws,
      store,
      harness: replay,
    });
    expect(second.status).toBe('succeeded');
    const replayReview = replay.calls.find((c) => c.title === 'Review evidence')!;
    expect(replayReview.prompt).toContain('FRESH EVIDENCE');
    expect(replayReview.prompt).not.toContain('RUNTIME OUTPUT MUST NOT BE FROZEN');
    expect(replayReview.permission).toBe('read-only');
    expect(replay.calls.find((c) => c.title === 'Gather evidence')!.prompt).toContain('audit two');

    const replayStarted = store.getEvents(second.runId).filter((e) => e.type === 'agent:started');
    expect(replayStarted.find((e) => e.payload.title === 'Gather evidence')!.payload).toMatchObject({
      workflowStepId: 'source',
      dependsOn: [],
      sourcePrompt: 'inspect audit two',
    });
    expect(replayStarted.find((e) => e.payload.title === 'Review evidence')!.payload).toMatchObject({
      workflowStepId: 'review',
      dependsOn: ['source'],
      agentName: 'strict-reviewer',
      permission: 'read-only',
    });
    expect(store.getRun(second.runId)?.summary).toBe('safe-review completed 2 step(s).');

    // A saved recipe is not allowed to coast past a failed prerequisite into
    // a stale verifier result. The generated guard must stop the DAG here.
    const failedReplay = new FakeHarness((req) =>
      req.title === 'Gather evidence'
        ? { status: 'error' as const, text: 'model not supported' }
        : 'must not run',
    );
    const failed = await runGoal({
      goal: { text: 'audit three', workflow: built.name, cwd: ws.root },
      workspace: ws,
      store,
      harness: failedReplay,
    });
    expect(failed.status).toBe('failed');
    expect(failedReplay.calls.some((c) => c.title === 'Review evidence')).toBe(false);
  } finally {
    cleanup();
  }
});

test('crystallize: failed and interrupted calls are never saved as proven steps', () => {
  const events = [
    { runId: 'r', seq: 1, type: 'phase:started', payload: { name: 'Go', index: 0 }, createdAt: 0 },
    {
      runId: 'r', seq: 2, type: 'agent:started',
      payload: { callId: 'a1', stepKey: 's', role: 'worker', title: 'broken', provider: 'claude', model: null, prompt: 'p', attempt: 1 },
      createdAt: 0,
    },
    { runId: 'r', seq: 3, type: 'agent:failed', payload: { callId: 'a1', stepKey: 's', error: 'boom', attempt: 1 }, createdAt: 0 },
  ] as never;
  expect(crystallize({ name: 'broken', goalText: 'goal', events, sourceWorkflow: 'auto' })).toBeNull();
});

test('agent definitions: a named agent supplies defaults the call can override', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    // .omks/agents/ has always been created and never read. A definition is how
    // a "role" stops being just a paragraph of prompt.
    writeFileSync(
      join(ws.paths.agents, 'strict-reviewer.md'),
      `---\nname: strict-reviewer\ndescription: Reviews and never edits\nrole: reviewer\nprovider: codex\npermission: read-only\n---\nBe unsparing. Cite files.\n`,
    );
    writeFileSync(
      join(ws.paths.workflows, 'usesdef.ts'),
      `export default async function usesdef(w){
        await w.agent({ as: 'strict-reviewer', title: 'Review', prompt: 'look' });
        await w.agent({ as: 'strict-reviewer', title: 'Review on claude', prompt: 'look', provider: 'claude' });
      }\n`,
    );
    const harness = new FakeHarness(() => 'ok');
    await runGoal({ goal: { text: 'g', workflow: 'usesdef', cwd: ws.root }, workspace: ws, store, harness });

    const [first, second] = harness.calls;
    // The definition fills in role, provider and permission…
    expect(first!.role).toBe('reviewer');
    expect(first!.provider).toBe('codex');
    expect(first!.permission).toBe('read-only');
    expect(first!.systemPrompt).toContain('Be unsparing'); // and its guidance
    // …but the call site keeps the last word.
    expect(second!.provider).toBe('claude');
  } finally {
    cleanup();
  }
});

test('agent definitions: an unknown name warns and runs the call as written', async () => {
  const { ws, store, cleanup } = tmpWorkspace();
  try {
    writeFileSync(
      join(ws.paths.workflows, 'missingdef.ts'),
      `export default async function missingdef(w){
        await w.agent({ as: 'nobody', role: 'worker', title: 'Go', prompt: 'do it' });
      }\n`,
    );
    const harness = new FakeHarness(() => 'ok');
    const out = await runGoal({ goal: { text: 'g', workflow: 'missingdef', cwd: ws.root }, workspace: ws, store, harness });
    // A typo in a definition name must not take the run down with it.
    expect(out.status).toBe('succeeded');
    expect(harness.calls[0]!.role).toBe('worker');
    const logs = store.getEvents(out.runId).filter((e) => e.type === 'log').map((e) => e.payload.message);
    expect(logs.some((m) => m.includes('no agent definition named "nobody"'))).toBe(true);
  } finally {
    cleanup();
  }
});

test('agent definitions: parseAgentDefinition ignores junk and needs a name', () => {
  expect(parseAgentDefinition('no frontmatter here', '/x.md')).toBeNull();
  const def = parseAgentDefinition(
    `---\nname: Odd Name!\npermission: nonsense\nisolate: yes\n---\nbody\n`,
    '/x.md',
  )!;
  expect(def.name).toBe('odd-name'); // slugified into something addressable
  expect(def.permission).toBeUndefined(); // an invalid mode is dropped, not trusted
  expect(def.isolate).toBe(true);
  expect(def.guidance).toBe('body');
});

test('isolate: parallel writers get their own tree instead of one shared cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omks-iso-'));
  try {
    // The hazard the grok-build run would have hit with two parallel *writers*:
    // a self-designed DAG could not ask for separation, so both would edit the
    // same files. A step can now say so, and the engine hands it a worktree.
    Bun.spawnSync(['git', 'init', '-q', '.'], { cwd: dir });
    Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
    const ws = Workspace.init(dir);
    const store = new Store(':memory:');
    writeFileSync(
      join(ws.paths.workflows, 'twowriters.ts'),
      `export default async function twowriters(w){
        await w.parallel([
          () => w.agent({ role: 'worker', title: 'left', prompt: 'x', isolate: true }),
          () => w.agent({ role: 'worker', title: 'right', prompt: 'y', isolate: true }),
        ]);
      }\n`,
    );
    const seen: string[] = [];
    const harness = new FakeHarness((req) => {
      seen.push(req.cwd);
      return 'ok';
    });
    const out = await runGoal({ goal: { text: 'g', workflow: 'twowriters', cwd: dir }, workspace: ws, store, harness });
    expect(out.status).toBe('succeeded');
    expect(seen).toHaveLength(2);
    // Two different directories, and neither is the shared run cwd.
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen).not.toContain(dir);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
