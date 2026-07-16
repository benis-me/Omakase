import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, Store } from '@omakase/core';
import type { ProviderInfo } from '@omakase/providers';
import { runGoal, resumeRun } from './orchestrator.ts';
import { discoverWorkflows, findWorkflow } from './workflows.ts';
import { parseFrontmatter, parseCommentMeta } from './frontmatter.ts';
import { verifyGoal } from './verify.ts';
import { SubprocessHarness, MockHarness, type Harness, type HarnessRequest, type HarnessResult } from './harness.ts';

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

test('runGoal: budget exhaustion emits agent:failed', async () => {
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
    expect(events.some((e) => e.type === 'agent:failed')).toBe(true);
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
