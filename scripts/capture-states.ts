#!/usr/bin/env bun
// Capture what `omks run` actually prints, in every state a run can end in.
//
// This drives the real engine and the real CLI renderer — only the model is
// scripted, so the output is reproducible and the page can never drift from the
// code. Writes ANSI transcripts to states.json.
//
//   bun run scripts/capture-states.ts [out.json]

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AbortError, Workspace, Store, type AnyRunEvent } from '@omakase/core';
import { runGoal, type Harness, type HarnessRequest, type HarnessResult, type RunGoalOptions } from '@omakase/engine';
import { createEventRenderer } from '@omakase/cli';

process.env.FORCE_COLOR = '1'; // keep the colours through the pipe

// retry.ts jitters its backoff with Math.random() — the engine's only caller.
// Pin it to the low end of the window: the sleeps still really happen (these
// are real retries), they're just the same length on every capture, and a demo
// shouldn't spend a full rate-limit backoff waiting.
Math.random = () => 0;

type Reply = string | Partial<HarnessResult>;

/** Spend varies the way real turns do — a planner is cheap, a build isn't. */
const ROLE_COST: Record<string, number> = { planner: 0.0091, reviewer: 0.0117, validator: 0.0068 };
const WORKER_COST = 0.0234;

/** A harness whose "model" is a function — deterministic, but real plumbing. */
class ScriptedHarness implements Harness {
  readonly id = 'scripted';
  calls: HarnessRequest[] = [];
  constructor(
    private reply: (req: HarnessRequest, nth: number) => Reply,
    private activities: (req: HarnessRequest) => string[] = () => [],
  ) {}

  async runAgent(req: HarnessRequest): Promise<HarnessResult> {
    const nth = this.calls.push(req);
    // A real turn is a subprocess: it notices a cancel and dies mid-flight.
    if (req.signal?.aborted) throw new AbortError();
    for (const summary of this.activities(req)) {
      req.onActivity?.({ kind: 'tool', summary, at: 0 });
      await new Promise((r) => setTimeout(r, 4)); // let concurrent agents interleave
      if (req.signal?.aborted) throw new AbortError();
    }
    const r = this.reply(req, nth);
    const base: HarnessResult = {
      text: '',
      status: 'ok',
      sessionId: `sess-${nth}`,
      tokens: 1180 + nth * 137,
      // No two turns cost the same: the nth-call term stands in for the context
      // each turn drags along.
      costUsd: Number(((ROLE_COST[req.role] ?? WORKER_COST) + nth * 0.0016).toFixed(4)),
      activities: [],
      durationMs: 900 + nth * 60,
      provider: req.provider,
    };
    return typeof r === 'string' ? { ...base, text: r } : { ...base, ...r };
  }

  async listProviders() {
    return [
      { id: 'claude', command: 'claude', label: 'Claude Code', available: true, version: '2.0', path: '/claude', models: ['sonnet'] },
      { id: 'codex', command: 'codex', label: 'Codex', available: true, version: '0.5', path: '/codex', models: ['gpt-5'] },
    ];
  }
}

interface Fixture {
  ws: Workspace;
  store: Store;
  /** The run cwd — a throwaway project the scripted agents really write into. */
  cwd: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'omks-states-'));
  const ws = Workspace.init(dir);
  const store = new Store(':memory:');
  return {
    ws,
    store,
    cwd: ws.root,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The scripted model edits the workspace like a real agent does — every check
 *  below is a real shell command, so something has to actually write the file. */
function agentWrites(cwd: string, rel: string, body: string): void {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

interface Scenario {
  id: string;
  title: string;
  eyebrow: string;
  command: string;
  note: string;
  transcript: string;
}

/** Run one goal and capture the CLI's rendered stream. `watch` sees the raw
 *  events (a scenario cancels itself that way). */
async function capture(opts: RunGoalOptions, watch?: (e: AnyRunEvent) => void): Promise<string> {
  const render = createEventRenderer();
  const lines: string[] = [];
  await runGoal({
    ...opts,
    onEvent: (e) => {
      const line = render(e);
      if (line !== null) lines.push(line);
      watch?.(e);
    },
  });
  return lines.join('\n');
}

/** The same run under `--json`: one JSON.stringify(event) per line, verbatim. */
async function captureJson(opts: RunGoalOptions): Promise<string[]> {
  const lines: string[] = [];
  await runGoal({ ...opts, onEvent: (e) => lines.push(JSON.stringify(e)) });
  return lines;
}

/** A page can't show sixty JSON lines. Keep the opening ones as they came, then
 *  the first line of every type the head missed — so the tail of the run (the
 *  verdict, the report, the end) is in there. Lines are picked, never edited. */
function sampleJsonLines(lines: string[], head = 10, max = 18): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const { type } = JSON.parse(line) as AnyRunEvent;
    if (out.length < head || !seen.has(type)) out.push(line);
    seen.add(type);
    if (out.length >= max) break;
  }
  return out;
}

const scenarios: Scenario[] = [];

// ─── 01 · success, parallel build ────────────────────────────────────────────
//
// The default `goal` workflow: plan, then build+review each step as its own
// pipeline lane, so three agents are in flight at once. The check is a real
// `bun test` against the files the agents really wrote.

const HEALTHZ_HANDLER = `export function healthz(): Response {
  return Response.json({ ok: true, uptime: process.uptime() });
}
`;
const HEALTHZ_TEST = `import { expect, test } from 'bun:test';
import { healthz } from '../src/routes/healthz.ts';

test('healthz answers 200 with ok:true', async () => {
  const res = healthz();
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
});
`;
const ROUTER = `import { healthz } from './routes/healthz.ts';

export const routes = { 'GET /healthz': healthz };
`;

/** Which of the three planned steps this request belongs to. */
function healthzStep(req: HarnessRequest): 'handler' | 'test' | 'router' {
  return req.title.includes('handler') ? 'handler' : req.title.includes('test') ? 'test' : 'router';
}

function healthzHarness(cwd: string): ScriptedHarness {
  return new ScriptedHarness(
    (req) => {
      if (req.role === 'planner') {
        return 'Add the GET /healthz handler\nWrite an integration test for it\nWire the route into the router';
      }
      const step = healthzStep(req);
      if (req.role === 'reviewer') {
        return {
          handler: 'Handler is correct — Response.json sets the content type and the 200. No gaps.',
          test: 'Test asserts the status and the body shape; I would add a 404 case later, but nothing blocking.',
          router: 'Route table wiring is fine and the import path matches the handler module.',
        }[step];
      }
      if (step === 'handler') {
        agentWrites(cwd, 'src/routes/healthz.ts', HEALTHZ_HANDLER);
        return 'Added src/routes/healthz.ts returning {ok, uptime} as JSON with a 200.';
      }
      if (step === 'test') {
        agentWrites(cwd, 'tests/healthz.test.ts', HEALTHZ_TEST);
        return 'Added tests/healthz.test.ts covering the status code and body; bun test is green (1 pass).';
      }
      agentWrites(cwd, 'src/router.ts', ROUTER);
      return "Wired 'GET /healthz' into src/router.ts and re-exported the handler.";
    },
    (req) => {
      if (req.role !== 'worker') return [];
      const step = healthzStep(req);
      if (step === 'handler') return ['Reading src/app.ts', 'Writing src/routes/healthz.ts', 'Running bun test'];
      if (step === 'test') return ['Reading src/routes/healthz.ts', 'Writing tests/healthz.test.ts', 'Running bun test'];
      return ['Reading src/router.ts', 'Editing src/router.ts', 'Running bun test'];
    },
  );
}

function healthzGoal(cwd: string): RunGoalOptions['goal'] {
  return {
    text: 'Add a /healthz endpoint and a test',
    workflow: 'goal',
    cwd,
    checks: [{ kind: 'command', run: 'bun test' }],
  };
}

{
  const fx = fixture();
  scenarios.push({
    id: 'success',
    title: 'Success · parallel build',
    eyebrow: 'State 01',
    command: 'omks run "Add a /healthz endpoint and a test" --check "bun test"',
    note: 'Three agents build concurrently. Each line carries the agent’s real call id — the same id in the journal and <code>--json</code> — so interleaved work stays readable. The loop only finishes once <code>bun test</code> actually passes.',
    transcript: await capture({
      goal: healthzGoal(fx.cwd),
      workspace: fx.ws,
      store: fx.store,
      harness: healthzHarness(fx.cwd),
    }),
  });
  fx.cleanup();
}

// ─── 02 · auto, prompt self-orchestration ────────────────────────────────────
//
// The `auto` workflow asks an agent to design the plan as JSON, then executes
// the DAG: dependencies force the waves, independent steps run together, and a
// step may name its own provider.

const AUTO_PLAN = {
  steps: [
    {
      id: 's1',
      role: 'worker',
      title: 'Extract the shared parser interface',
      prompt: 'Pull the stream-parser surface out of providers.ts into parsers/types.ts.',
      dependsOn: [],
    },
    {
      id: 's2',
      role: 'worker',
      title: 'Port the Claude stream parser',
      prompt: 'Move ClaudeStreamParser onto the extracted interface, keeping its tests green.',
      dependsOn: ['s1'],
    },
    {
      id: 's3',
      role: 'worker',
      title: 'Port the Codex JSON parser',
      prompt: 'Move CodexJsonParser onto the extracted interface, keeping its tests green.',
      dependsOn: ['s1'],
    },
    {
      id: 's4',
      role: 'reviewer',
      title: 'Cross-review both ports',
      prompt: 'Compare both ports against the interface and flag drift.',
      provider: 'codex',
      dependsOn: ['s2', 's3'],
    },
  ],
};

{
  const fx = fixture();
  const harness = new ScriptedHarness(
    (req) => {
      if (req.role === 'planner') return JSON.stringify(AUTO_PLAN);
      if (req.title.startsWith('Cross-review')) {
        return 'Both parsers now implement StreamParser identically; the Codex one still swallows a trailing newline — filed as a follow-up, not a blocker.';
      }
      if (req.title.startsWith('Extract')) return 'Extracted StreamParser + ParsedTurn into parsers/types.ts; no behaviour change.';
      if (req.title.includes('Claude')) return 'ClaudeStreamParser now implements StreamParser; 14 tests still pass.';
      return 'CodexJsonParser now implements StreamParser; 9 tests still pass.';
    },
    (req) => (req.role === 'worker' ? ['Reading packages/providers/src/parsers.ts', 'Editing parsers/types.ts'] : []),
  );
  scenarios.push({
    id: 'auto',
    title: 'Auto · the workflow writes itself',
    eyebrow: 'State 02',
    command: 'omks run "Split the provider parsers into modules" --workflow auto',
    note: 'An orchestrator agent returns a JSON DAG instead of prose. The engine runs it in dependency waves — the two ports go in parallel once the interface lands — and routes the cross-review to <code>codex</code>. The plan’s shape is filed to the wiki so the next <code>auto</code> run starts warmer.',
    transcript: await capture({
      goal: { text: 'Split the provider parsers into modules', workflow: 'auto', cwd: fx.cwd },
      workspace: fx.ws,
      store: fx.store,
      harness,
    }),
  });
  fx.cleanup();
}

// ─── 03 · retry, then provider fallback ──────────────────────────────────────
//
// The first turn hits a rate limit and backs off; the next two attempts die on
// a broken stream, which exhausts the attempt budget for that provider — so the
// engine tries the next candidate instead of failing the run.

{
  const fx = fixture();
  const harness = new ScriptedHarness((_req, nth) => {
    if (nth === 1) return { status: 'error', text: 'claude: 429 Too Many Requests — rate limit exceeded (retry-after 21s)' };
    if (nth <= 3) return { status: 'error', text: 'claude: stream closed before the final message (exit 1)' };
    return 'Drafted release notes for 0.4: resume, the run journal, provider fallback, and the new TUI canvas. Grouped by theme with the breaking change called out first.';
  });
  scenarios.push({
    id: 'fallback',
    title: 'Rate limit · retry, then fall back',
    eyebrow: 'State 03',
    command: 'omks run "Draft the 0.4 release notes" --workflow solo',
    note: 'A rate limit is retried with an exponential backoff, not surfaced as a failure. When the provider keeps refusing, the engine switches to the next available one mid-agent (<code>harness:switched</code>) and the run carries on — same prompt, different CLI.',
    transcript: await capture({
      goal: { text: 'Draft the 0.4 release notes', workflow: 'solo', cwd: fx.cwd },
      workspace: fx.ws,
      store: fx.store,
      harness,
    }),
  });
  fx.cleanup();
}

// ─── 04 · goal UNMET, then the fix loop ──────────────────────────────────────
//
// The check is a real file test the workflow's first pass never satisfies: the
// verifier says UNMET, the outer goal-loop re-drives the workflow, and the fix
// agent finally writes the page.

const METRICS_DOC = `# GET /metrics

Prometheus exposition format. One gauge per run state, plus \`omks_agent_calls_total\`.

    curl -s localhost:8080/metrics | head
`;

{
  const fx = fixture();
  let fixAttempts = 0;
  const harness = new ScriptedHarness((req) => {
    if (req.role === 'planner') return 'Write docs/api/metrics.md describing the /metrics endpoint';
    if (req.role === 'reviewer') {
      return 'The endpoint description reads well, but I can’t find docs/api/metrics.md anywhere in the tree — it was never committed.';
    }
    if (req.title === 'Fix gap') {
      fixAttempts++;
      // The first pass's fixers flail — which is the whole point of an oracle.
      const flails = [
        'Looked for a docs template to copy; docs/ has no api/ directory yet, so I left the reference in the PR body.',
        'Regenerated the OpenAPI snippet instead — it lives in build output, not in docs/.',
        'Blocked: I documented /metrics in the handler’s doc comment rather than a docs page.',
      ];
      if (fixAttempts <= flails.length) return flails[fixAttempts - 1]!;
      agentWrites(fx.cwd, 'docs/api/metrics.md', METRICS_DOC);
      return 'Wrote docs/api/metrics.md: exposition format, the gauge list, and a curl example.';
    }
    return 'Described /metrics (labels, cardinality, scrape interval) in the PR description; no docs page yet.';
  });
  scenarios.push({
    id: 'unmet',
    title: 'Goal UNMET · the loop keeps going',
    eyebrow: 'State 04',
    command: 'omks run "Document the /metrics endpoint" --check "test -f docs/api/metrics.md"',
    note: 'Agents don’t get to mark their own homework. The workflow finished and reported itself done — the verifier ran the check, disagreed, and the goal-loop re-drove the whole workflow with the gap in hand. The run only ends when the check passes.',
    transcript: await capture({
      goal: {
        text: 'Document the /metrics endpoint',
        workflow: 'goal',
        cwd: fx.cwd,
        checks: [{ kind: 'command', run: 'test -f docs/api/metrics.md' }],
      },
      workspace: fx.ws,
      store: fx.store,
      harness,
    }),
  });
  fx.cleanup();
}

// ─── 05 · human in the loop ──────────────────────────────────────────────────
//
// No built-in workflow asks a question, so this one is a workspace workflow —
// dropped into .omks/workflows/ exactly like a user's own, and picked up by
// name. `w.ask` blocks the run until the host answers.

const RELEASE_WORKFLOW = `// name: release
// description: Cut a release — a human picks the bump and approves the tag.
// version: 0.1.0
// when_to_use: Releases, where the irreversible step needs a human on the hook.

export default async function release(w) {
  const bump = await w.ask('Which version bump?', { options: ['patch', 'minor', 'major'], default: 'patch' });

  const notes = await w.agent({
    role: 'worker',
    title: 'Draft the ' + bump + ' release notes',
    prompt: 'Summarize every change since the last tag as ' + bump + ' release notes.',
  });

  const go = await w.ask('Tag v0.4.0 and push?', { options: ['yes', 'no'], default: 'no' });
  if (go !== 'yes') {
    w.requestReport({ kind: 'final', title: 'Release held', summary: 'Notes drafted; tagging skipped at your request.' });
    return;
  }

  await w.agent({ role: 'worker', title: 'Tag and push v0.4.0', prompt: 'Tag v0.4.0 with these notes and push:\\n' + notes.text });
  w.requestReport({ kind: 'final', title: 'Release cut', summary: 'v0.4.0 tagged and pushed with the drafted notes.' });
}
`;

{
  const fx = fixture();
  writeFileSync(join(fx.ws.paths.workflows, 'release.ts'), RELEASE_WORKFLOW);
  const harness = new ScriptedHarness((req) =>
    req.title.startsWith('Draft')
      ? 'Minor bump: resumable runs, the JSONL journal, provider fallback, and the rebuilt TUI. No breaking changes.'
      : 'Tagged v0.4.0, pushed the tag, and opened the release draft on GitHub.',
  );
  scenarios.push({
    id: 'ask',
    title: 'Human in the loop',
    eyebrow: 'State 05',
    command: 'omks run "Cut the 0.4 release" --workflow release',
    note: 'A workflow can stop and ask. <code>w.ask</code> blocks the run until you answer on the terminal, and the answer is journaled — so a resumed run replays your decision instead of asking twice.',
    transcript: await capture({
      goal: { text: 'Cut the 0.4 release', workflow: 'release', cwd: fx.cwd },
      workspace: fx.ws,
      store: fx.store,
      harness,
      ask: async (req) => (req.question.startsWith('Which') ? 'minor' : 'yes'),
    }),
  });
  fx.cleanup();
}

// ─── 06 · budget stop ────────────────────────────────────────────────────────
//
// Every agent call is charged against the run's budget before it is made. Once
// the budget is out the remaining calls fail closed, and a run that never met
// its check ends failed rather than quietly half-done.

{
  const fx = fixture();
  const harness = new ScriptedHarness((req) => {
    if (req.role === 'planner') return 'Port the v1 routes onto the v2 router\nRewrite the pagination contract';
    if (req.role === 'reviewer') return 'Routes look mechanical and safe; the pagination cursor still needs an encoder before this ships.';
    return req.title.includes('pagination')
      ? 'Replaced offset paging with an opaque cursor in the v2 handlers; the encoder is still stubbed.'
      : 'Moved 14 v1 route handlers onto the v2 router with the compatibility shim in place.';
  });
  scenarios.push({
    id: 'budget',
    title: 'Budget stop',
    eyebrow: 'State 06',
    command: 'omks run "Migrate the REST API to v2" --check "test -f dist/api-v2.js" --max-agents 4',
    note: 'The budget is a hard stop, not a suggestion: the fifth agent call is refused before it spends anything, and the fix loop fails closed behind it. The check never passed, so the run ends <code>failed</code> — an autonomous loop that can’t run away.',
    transcript: await capture({
      goal: {
        text: 'Migrate the REST API to v2',
        workflow: 'goal',
        cwd: fx.cwd,
        checks: [{ kind: 'command', run: 'test -f dist/api-v2.js' }],
      },
      workspace: fx.ws,
      store: fx.store,
      harness,
      maxAgents: 4,
    }),
  });
  fx.cleanup();
}

// ─── 07 · cancelled ──────────────────────────────────────────────────────────
//
// Ctrl-C aborts the signal mid-build. The in-flight agent dies, the queued ones
// are never spent, and — however rosy the workflow's own closing report is —
// the run reports the cancel.

{
  const fx = fixture();
  const controller = new AbortController();
  let started = 0;
  scenarios.push({
    id: 'cancel',
    title: 'Cancelled',
    eyebrow: 'State 07',
    command: 'omks run "Add a /healthz endpoint and a test"   # ^C during the build',
    note: 'Ctrl-C aborts the run’s signal. The agent already in flight is killed, every queued call is refused before it spends a cent, and the run ends <code>cancelled</code> — not with the workflow’s own closing summary.',
    transcript: await capture(
      {
        goal: healthzGoal(fx.cwd),
        workspace: fx.ws,
        store: fx.store,
        harness: healthzHarness(fx.cwd),
        signal: controller.signal,
      },
      // Ctrl-C as soon as the build fans out (the planner is agent 1).
      (e) => {
        if (e.type === 'agent:started' && ++started === 2) controller.abort();
      },
    ),
  });
  fx.cleanup();
}

// ─── 08 · machine output ─────────────────────────────────────────────────────
//
// The same run as State 01, under `--json`: the renderer is the only thing that
// changes — one JSON event per line, straight off the same event log.

{
  const fx = fixture();
  const lines = await captureJson({
    goal: healthzGoal(fx.cwd),
    workspace: fx.ws,
    store: fx.store,
    harness: healthzHarness(fx.cwd),
  });
  scenarios.push({
    id: 'json',
    title: 'Machine output · --json',
    eyebrow: 'State 08',
    command: 'omks run "Add a /healthz endpoint and a test" --check "bun test" --json',
    note: 'State 01’s run again, with the pretty printer swapped out: one event per line, typed and sequenced, the same records the durable log and <code>.omks/runs/*.jsonl</code> hold. Pipe it into <code>jq</code>, a CI annotation, or your own UI. (Sampled — a full run streams a few dozen lines.)',
    transcript: sampleJsonLines(lines).join('\n'),
  });
  fx.cleanup();
}

await Bun.write(process.argv[2] ?? 'states.json', JSON.stringify(scenarios, null, 2));
console.log(`captured ${scenarios.length} scenario(s)`);
