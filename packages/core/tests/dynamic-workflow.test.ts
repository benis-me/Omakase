import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAgentRuntime,
  createScriptedAgent,
  type AgentEvent,
  type AgentExecutor,
} from '@omakase/daemon';
import { createModelPolicy } from '../src/modes/policy.js';
import { MemoryRunStore } from '../src/supervisor/run-store.js';
import {
  BunWorkflowScriptRunner,
  DynamicWorkflowRun,
  MemoryWorkflowScriptRunner,
  WorkflowScriptValidationError,
  validateWorkflowScriptSource,
  type DynamicWorkflowApi,
} from '../src/workflows/dynamic/index.js';

const OFFLINE = { env: { PATH: '' }, includeWellKnownPathDirs: false } as const;

function bunAvailable(): boolean {
  return existsSync('/opt/homebrew/bin/bun') || existsSync('/usr/local/bin/bun') || Boolean(process.env.PATH?.includes('bun'));
}

describe('dynamic workflow script validation', () => {
  it('allows pure workflow API scripts and rejects direct filesystem or shell access', () => {
    expect(() =>
      validateWorkflowScriptSource(`
        export default async function workflow(w) {
          await w.phase("Discovery", async () => {
            await w.agent({ title: "Inspect", prompt: "Inspect the project" });
          });
        }
      `),
    ).not.toThrow();

    expect(() => validateWorkflowScriptSource('import fs from "node:fs";')).toThrow(WorkflowScriptValidationError);
    expect(() => validateWorkflowScriptSource('export default async () => Bun.spawn(["ls"])')).toThrow(/Bun/);
    expect(() => validateWorkflowScriptSource('export default async () => require("child_process")')).toThrow(/require/);
  });
});

describe('DynamicWorkflowRun', () => {
  it('executes dynamic phases, parallel agents, reporter requests, and wiki updates as persisted run state', async () => {
    let active = 0;
    let maxActive = 0;
    const exec: AgentExecutor = (ctx) => {
      const role = String(ctx.input.metadata?.role ?? 'worker');
      async function* gen(): AsyncGenerator<AgentEvent> {
        active += 1;
        maxActive = Math.max(maxActive, active);
        yield { type: 'status', label: 'working' };
        await new Promise((resolve) => setTimeout(resolve, role === 'worker' ? 15 : 1));
        yield { type: 'text_delta', delta: `${role}:${ctx.input.prompt}` };
        yield { type: 'tool_use', id: 'tool-1', name: 'read', input: { prompt: ctx.input.prompt } };
        yield { type: 'usage', usage: { totalTokens: role === 'worker' ? 13 : 5 } };
        active -= 1;
      }
      return gen();
    };
    const store = new MemoryRunStore();
    const run = new DynamicWorkflowRun({
      runtime: createAgentRuntime({ executors: { codex: exec }, detection: OFFLINE, now: () => 0 }),
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'codex' } } }),
      store,
      scriptRunner: new MemoryWorkflowScriptRunner(async (workflow: DynamicWorkflowApi) => {
        await workflow.phase('Discovery', async () => {
          const [packageResult, docsResult] = await workflow.parallel([
            workflow.agent({ title: 'Inspect package', prompt: 'inspect package.json' }),
            workflow.agent({ title: 'Inspect docs', prompt: 'inspect docs' }),
          ]);
          await workflow.requestReport({
            title: 'Discovery report',
            reason: 'phase-complete',
            summary: `${packageResult.text} / ${docsResult.text}`,
          });
          await workflow.updateWiki({
            kind: 'decision',
            title: 'Dynamic workflows use JSONL IPC',
            body: 'Workflow scripts request work from the host instead of touching files or shells directly.',
          });
        });
      }),
      script: {
        id: 'workflow-script-1',
        path: '/tmp/workflow.js',
        source: 'export default async function workflow() {}',
        runtime: 'memory',
        createdAt: 0,
      },
      request: { prompt: 'run a dynamic workflow', cwd: process.cwd(), mode: 'normal' },
      clock: () => 0,
      detectionOptions: OFFLINE,
      maxConcurrency: 2,
    });

    const result = await run.start().result;
    const record = await store.load(result.id);

    expect(result.status).toBe('succeeded');
    expect(maxActive).toBe(2);
    expect(result.plan.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Inspect package', status: 'succeeded', tags: ['Discovery'] }),
        expect.objectContaining({ title: 'Inspect docs', status: 'succeeded', tags: ['Discovery'] }),
      ]),
    );
    expect(result.workflow.phases).toEqual([
      expect.objectContaining({ name: 'Discovery', status: 'succeeded', agentRunIds: expect.any(Array) }),
    ]);
    expect(result.reports[0]).toEqual(expect.objectContaining({ title: 'Discovery report', source: 'agent' }));
    expect(result.knowledgeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Dynamic workflows use JSONL IPC', kind: 'decision' }),
      ]),
    );
    expect(result.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'workflow-created',
        'workflow-phase-started',
        'workflow-phase-finished',
        'planned',
        'agent-assigned',
        'agent-event',
        'report-requested',
        'report-created',
        'knowledge-event-created',
        'run-finished',
      ]),
    );
    expect(record?.workflow?.status).toBe('succeeded');
    expect(record?.workflow?.script.id).toBe('workflow-script-1');
    expect(record?.plan.tasks).toHaveLength(2);
  });

  it('exposes loop primitives: pipeline, bounded loopUntil, and budget', async () => {
    const exec = createScriptedAgent((input) => [{ type: 'text_delta', delta: `ok:${input.prompt}` }]);
    const store = new MemoryRunStore();
    const piped: string[] = [];
    let observedRemaining = -1;
    let rounds = 0;

    const run = new DynamicWorkflowRun({
      runtime: createAgentRuntime({ executors: { codex: exec }, detection: OFFLINE, now: () => 0 }),
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'codex' } } }),
      store,
      scriptRunner: new MemoryWorkflowScriptRunner(async (w: DynamicWorkflowApi) => {
        observedRemaining = (await w.budget()).remaining;
        // Each item flows item → generate(agent) → review, independently.
        const out = (await w.pipeline(
          ['a', 'b', 'c'],
          (_value, item) => w.agent({ title: `gen ${item}`, prompt: `gen ${item}` }),
          (gen) => `reviewed:${(gen as { text: string }).text}`,
        )) as string[];
        piped.push(...out);
        // Bounded loop-until-dry: round 0 yields work, round 1 is dry → stop (not maxRounds).
        await w.loopUntil(
          (round) => {
            rounds = round + 1;
            return round < 1 ? [round] : [];
          },
          { maxRounds: 5 },
        );
      }),
      script: {
        id: 'wf-loop',
        path: '/tmp/wf.js',
        source: 'export default async function w() {}',
        runtime: 'memory',
        createdAt: 0,
      },
      request: { prompt: 'loop primitives', cwd: process.cwd(), mode: 'normal' },
      clock: () => 0,
      detectionOptions: OFFLINE,
      maxConcurrency: 3,
      maxAgents: 10,
    });

    const result = await run.start().result;

    expect(result.status).toBe('succeeded');
    expect(piped).toEqual(['reviewed:ok:gen a', 'reviewed:ok:gen b', 'reviewed:ok:gen c']);
    expect(observedRemaining).toBe(10); // full agent allowance before any agent ran
    expect(rounds).toBe(2); // stopped on the dry round, well under maxRounds=5
  });

  it('enforces the workflow agent cap before spawning unbounded sub-agents', async () => {
    const store = new MemoryRunStore();
    const run = new DynamicWorkflowRun({
      runtime: createAgentRuntime({
        executors: { codex: createScriptedAgent(() => [{ type: 'text_delta', delta: 'done' }]) },
        detection: OFFLINE,
      }),
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'codex' } } }),
      store,
      scriptRunner: new MemoryWorkflowScriptRunner(async (workflow: DynamicWorkflowApi) => {
        await workflow.agent({ title: 'one', prompt: 'one' });
        await workflow.agent({ title: 'two', prompt: 'two' });
      }),
      script: {
        id: 'workflow-script-2',
        path: '/tmp/workflow.js',
        source: 'export default async function workflow() {}',
        runtime: 'memory',
        createdAt: 0,
      },
      request: { prompt: 'cap agents' },
      clock: () => 0,
      detectionOptions: OFFLINE,
      maxAgents: 1,
    });

    const result = await run.start().result;

    expect(result.status).toBe('failed');
    expect(result.summary).toMatch(/max agents/i);
    expect(result.plan.tasks).toHaveLength(1);
    expect(result.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'error', phase: 'workflow-script' })]),
    );
  });

  it('still emits a visible run lifecycle when workflow script validation fails', async () => {
    const run = new DynamicWorkflowRun({
      runtime: createAgentRuntime({ detection: OFFLINE }),
      store: new MemoryRunStore(),
      scriptRunner: new MemoryWorkflowScriptRunner(async () => {}),
      script: {
        id: 'workflow-script-invalid',
        path: '/tmp/workflow.js',
        source: 'import fs from "node:fs"; export default async function workflow() {}',
        runtime: 'memory',
        createdAt: 0,
      },
      request: { prompt: 'invalid script' },
      detectionOptions: OFFLINE,
    });

    const result = await run.start().result;

    expect(result.status).toBe('failed');
    expect(result.events.map((event) => event.type).slice(0, 3)).toEqual([
      'run-started',
      'workflow-created',
      'error',
    ]);
    expect(result.events.at(-1)).toEqual(expect.objectContaining({ type: 'run-finished', status: 'failed' }));
  });

  it('allocates unique run ids across independent workflow runs by default', () => {
    const runtime = createAgentRuntime({ detection: OFFLINE });
    const options = {
      runtime,
      scriptRunner: new MemoryWorkflowScriptRunner(async () => {}),
      script: {
        id: 'workflow-script-unique',
        path: '/tmp/workflow.js',
        source: 'export default async function workflow() {}',
        runtime: 'memory' as const,
        createdAt: 0,
      },
      request: { prompt: 'unique ids' },
      detectionOptions: OFFLINE,
    };

    expect(new DynamicWorkflowRun(options).id).not.toBe(new DynamicWorkflowRun(options).id);
  });
});

const itWithBun = bunAvailable() ? it : it.skip;

describe('BunWorkflowScriptRunner', () => {
  itWithBun('runs a real JavaScript workflow script through Bun JSONL IPC', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-dynamic-workflow-'));
    const scriptPath = path.join(dir, 'workflow.js');
    writeFileSync(
      scriptPath,
      `
        export default async function workflow(w) {
          await w.phase("Bun Phase", async () => {
            const result = await w.agent({ title: "Bun worker", prompt: "hello from bun" });
            await w.updateWiki({ kind: "fact", title: "Bun workflow completed", body: result.text });
          });
        }
      `,
      'utf8',
    );
    const store = new MemoryRunStore();
    const run = new DynamicWorkflowRun({
      runtime: createAgentRuntime({
        executors: { codex: createScriptedAgent((input) => [{ type: 'text_delta', delta: `agent saw ${input.prompt}` }]) },
        detection: OFFLINE,
      }),
      policy: createModelPolicy('custom', { custom: { default: { agentId: 'codex' } } }),
      store,
      scriptRunner: new BunWorkflowScriptRunner({ bunPath: 'bun' }),
      script: {
        id: 'workflow-script-bun',
        path: scriptPath,
        source: readFileSync(scriptPath, 'utf8'),
        runtime: 'bun',
        createdAt: 0,
      },
      request: { prompt: 'bun workflow', cwd: dir },
      clock: () => 0,
      detectionOptions: OFFLINE,
    });

    const result = await run.start().result;

    expect(result.status).toBe('succeeded');
    expect(result.plan.tasks[0]).toEqual(expect.objectContaining({ title: 'Bun worker', status: 'succeeded' }));
    expect(result.knowledgeEvents[0]).toEqual(expect.objectContaining({ title: 'Bun workflow completed' }));
    expect(result.workflow.script.runtime).toBe('bun');
  });
});
