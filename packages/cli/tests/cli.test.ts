import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { MemoryRunStore, Orchestrator, projectKnowledgeStore, type WorkMode } from '@omakase/core';
import { openWorkspace, SqliteRunStore } from '@omakase/storage';
import { createCli, parseArgs } from '../src/cli.js';

const OFFLINE = { env: { PATH: '' }, includeWellKnownPathDirs: false } as const;

function bunAvailable(): boolean {
  return existsSync('/opt/homebrew/bin/bun') || existsSync('/usr/local/bin/bun') || Boolean(process.env.PATH?.includes('bun'));
}

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const cli = createCli({
    write: (t) => out.push(t),
    error: (t) => err.push(t),
    detectionOptions: OFFLINE,
    createRuntime: () => createAgentRuntime({ fallbackToBuiltin: true, detection: OFFLINE }),
    createOrchestrator: (runtime, mode: WorkMode, options) =>
      new Orchestrator({
        runtime,
        store: new MemoryRunStore(),
        defaultMode: mode,
        ...(options?.cwd ? { knowledgeStore: projectKnowledgeStore(options.cwd) } : {}),
        detectionOptions: OFFLINE,
      }),
  });
  return { cli, out: () => out.join('\n'), err: () => err.join('\n') };
}

describe('parseArgs', () => {
  it('parses commands, flags, and values', () => {
    const parsed = parseArgs(['run', 'do a thing', '--mode', 'max-power', '--json']);
    expect(parsed.command).toBe('run');
    expect(parsed.positionals).toEqual(['run', 'do a thing']);
    expect(parsed.options).toEqual({ mode: 'max-power', json: true });
  });
  it('supports --key=value', () => {
    expect(parseArgs(['agents', '--cwd=/tmp']).options).toEqual({ cwd: '/tmp' });
  });
  it('does not let a boolean flag swallow the following positional', () => {
    const parsed = parseArgs(['run', '--json', 'summarize this project']);
    expect(parsed.options.json).toBe(true);
    expect(parsed.positionals).toContain('summarize this project');
  });
  it('treats -- as end-of-options so a dash-leading task survives', () => {
    const parsed = parseArgs(['run', '--', '--weird task']);
    expect(parsed.positionals).toContain('--weird task');
  });
  it('still consumes values for value-taking flags', () => {
    const parsed = parseArgs(['run', 'task', '--mode', 'max-power', '--max-cost', '0.5']);
    expect(parsed.options.mode).toBe('max-power');
    expect(parsed.options['max-cost']).toBe('0.5');
    expect(parsed.positionals).toContain('task');
  });
});

describe('omakase agents', () => {
  it('lists detected agents as a table', async () => {
    const { cli, out } = harness();
    const code = await cli.main(['agents']);
    expect(code).toBe(0);
    expect(out()).toContain('ID');
    expect(out()).toContain('claude');
    expect(out()).toMatch(/agents runnable/);
  });

  it('emits JSON with --json', async () => {
    const { cli, out } = harness();
    await cli.main(['agents', '--json']);
    const parsed = JSON.parse(out());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty('id');
  });
});

describe('omakase run', () => {
  it('runs a simple task with the injected deterministic runtime', async () => {
    const { cli, out } = harness();
    const code = await cli.main(['run', 'summarize this project', '--cwd', process.cwd()]);
    expect(code).toBe(0);
    expect(out()).toContain('Project summary');
    expect(out()).toMatch(/run finished: succeeded/);
  });

  it('runs a complex task end to end (router→planner→workers→reviewer)', async () => {
    const { cli, out } = harness();
    const code = await cli.main([
      'run',
      'build a parser and add a CLI and write tests',
    ]);
    expect(code).toBe(0);
    expect(out()).toContain('planned');
    expect(out()).toMatch(/run finished: succeeded/);
  });

  it('errors when no task is given', async () => {
    const { cli, err } = harness();
    const code = await cli.main(['run']);
    expect(code).toBe(1);
    expect(err()).toMatch(/task description is required/);
  });

  it('rejects a non-numeric --max-tokens instead of silently dropping the budget', async () => {
    const { cli, err } = harness();
    const code = await cli.main(['run', 'do a thing', '--max-tokens', '5k']);
    expect(code).toBe(1);
    expect(err()).toMatch(/max-tokens must be a positive number/);
  });

  it('rejects --agent without a value', async () => {
    const { cli, err } = harness();
    const code = await cli.main(['run', 'do a thing', '--agent']);
    expect(code).toBe(1);
    expect(err()).toMatch(/--agent requires an agent id/);
  });

  it('emits one JSON object per event with --json', async () => {
    const { cli, out } = harness();
    await cli.main(['run', 'summarize', '--json']);
    const lines = out().split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    expect(events[0]).toHaveProperty('type', 'run-started');
    expect(events.at(-1)).toHaveProperty('type', 'run-finished');
  });

  it('persists project knowledge pages for direct --cwd runs', async () => {
    const cli = createCli({
      write: () => {},
      error: () => {},
      detectionOptions: OFFLINE,
      createRuntime: () =>
        createAgentRuntime({
          executors: {
            codex: createScriptedAgent((input) => {
              const role = String(input.metadata?.role ?? 'worker');
              if (role === 'reporter') return [{ type: 'text_delta', delta: 'Project summary report' }];
              if (role === 'wiki-curator') return [{ type: 'text_delta', delta: 'Project summary: durable agent-authored page.' }];
              return [{ type: 'text_delta', delta: 'worker done' }];
            }),
          },
          detection: OFFLINE,
          now: () => 0,
        }),
    });
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-run-knowledge-'));
    const code = await cli.main(['run', 'summarize project knowledge', '--cwd', cwd, '--agent', 'codex']);
    expect(code).toBe(0);
    // The run persisted to the project's `.omks` workspace (omks.db), and the
    // agent-authored knowledge rendered to the git-friendly markdown projection.
    expect(existsSync(path.join(cwd, '.omks', 'omks.db'))).toBe(true);
    expect(readFileSync(path.join(cwd, '.omks', 'memory', 'wiki-pages.md'), 'utf8')).toContain('Project summary');
    const ws = openWorkspace(cwd);
    try {
      const runStore = new SqliteRunStore(ws.db);
      expect((await runStore.list()).length).toBeGreaterThanOrEqual(1);
    } finally {
      ws.close();
    }
  });

  it('persists an --offline run to the .omks workspace (no injected orchestrator)', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-run-offline-'));
    // No injected createOrchestrator: --offline forces the built-in agent, so the
    // run completes with no model calls and persists through the real `.omks` path.
    const cli = createCli({
      write: () => {},
      error: () => {},
      detectionOptions: OFFLINE,
      createRuntime: () => createAgentRuntime({ fallbackToBuiltin: true, detection: OFFLINE }),
    });
    const code = await cli.main(['run', '--offline', 'summarize', '--cwd', cwd]);
    expect(code).toBe(0);
    expect(existsSync(path.join(cwd, '.omks', 'omks.db'))).toBe(true);
    const ws = openWorkspace(cwd);
    try {
      const runStore = new SqliteRunStore(ws.db);
      expect((await runStore.list()).length).toBe(1);
    } finally {
      ws.close();
    }
  });
});

describe('omakase wiki', () => {
  it('adds a manual editable wiki entry and renders refreshed project knowledge', async () => {
    const { cli, out } = harness();
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-wiki-'));

    const addCode = await cli.main([
      'wiki',
      'add',
      'Deployment decision',
      '--kind',
      'decision',
      '--body',
      'Use blue-green deploys for risky releases.',
      '--tags',
      'release,manual',
      '--cwd',
      cwd,
    ]);
    expect(addCode).toBe(0);
    expect(out()).toContain('wiki: added decision "Deployment decision"');
    // The entry is durable in `.omks` (omks.db, surfaced via the knowledge store)
    // and rendered into the git-friendly wiki-pages markdown projection.
    const ws = openWorkspace(cwd);
    try {
      const wiki = await ws.knowledgeStore.loadWiki();
      expect(wiki?.entries.map((e) => e.title)).toContain('Deployment decision');
    } finally {
      ws.close();
    }
    expect(readFileSync(path.join(cwd, '.omks', 'memory', 'wiki-pages.md'), 'utf8')).toContain('Architecture Decisions');

    const show = harness();
    const showCode = await show.cli.main(['wiki', '--cwd', cwd]);
    expect(showCode).toBe(0);
    expect(show.out()).toContain('Project Knowledge Base');
    expect(show.out()).toContain('Deployment decision');
    expect(show.out()).toContain('Use blue-green deploys');
  });

  it('rejects wiki add without a title', async () => {
    const { cli, err } = harness();
    const code = await cli.main(['wiki', 'add', '--body', 'missing title']);
    expect(code).toBe(1);
    expect(err()).toContain('wiki add: a title is required');
  });

  it('persists a manual wiki entry to the .omks workspace via the real store', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-wiki-add-'));
    // No injected openWorkspace → exercises the real `.omks` persistence path.
    const cli = createCli({
      write: () => {},
      detectionOptions: OFFLINE,
      createRuntime: () => createAgentRuntime({ fallbackToBuiltin: true, detection: OFFLINE }),
    });
    const code = await cli.main([
      'wiki',
      'add',
      'CLI editable knowledge',
      '--body',
      'Manual wiki edits persist beside agent-authored knowledge.',
      '--cwd',
      cwd,
    ]);
    expect(code).toBe(0);
    expect(existsSync(path.join(cwd, '.omks', 'omks.db'))).toBe(true);
    const ws = openWorkspace(cwd);
    try {
      const wiki = await ws.knowledgeStore.loadWiki();
      expect(wiki?.entries.map((e) => e.title)).toContain('CLI editable knowledge');
    } finally {
      ws.close();
    }
  });
});

describe('omakase workflow', () => {
  const itWithBun = bunAvailable() ? it : it.skip;

  itWithBun('runs a JavaScript workflow script through Bun and persists the run', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-workflow-'));
    const scriptPath = path.join(cwd, 'workflow.js');
    writeFileSync(
      scriptPath,
      `
        export default async function workflow(w) {
          await w.phase("CLI Workflow", async () => {
            const result = await w.agent({ title: "CLI worker", prompt: "inspect cli workflow" });
            await w.updateWiki({ kind: "fact", title: "CLI workflow ran", body: result.text });
          });
        }
      `,
      'utf8',
    );
    const out: string[] = [];
    const err: string[] = [];
    const cli = createCli({
      write: (t) => out.push(t),
      error: (t) => err.push(t),
      detectionOptions: OFFLINE,
      createRuntime: () =>
        createAgentRuntime({
          executors: {
            codex: createScriptedAgent((input) => [{ type: 'text_delta', delta: `done ${input.prompt}` }]),
          },
          detection: OFFLINE,
        }),
    });

    const code = await cli.main(['workflow', 'run', scriptPath, '--cwd', cwd, '--agent', 'codex', '--json']);
    const events = out.filter(Boolean).map((line) => JSON.parse(line) as { type: string });

    expect(code).toBe(0);
    expect(err.join('\n')).toBe('');
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['workflow-created', 'workflow-phase-started', 'agent-event', 'workflow-finished']),
    );
    // The workflow run persisted to the project's `.omks` workspace (omks.db),
    // and its updateWiki knowledge rendered to the git-friendly markdown.
    expect(existsSync(path.join(cwd, '.omks', 'omks.db'))).toBe(true);
    const ws = openWorkspace(cwd);
    try {
      const runStore = new SqliteRunStore(ws.db);
      const ids = await runStore.list();
      expect(ids.length).toBeGreaterThanOrEqual(1);
      const record = await runStore.load(ids[0]!);
      expect(record?.workflow?.status).toBe('succeeded');
      expect(record?.workflow?.phases[0]?.name).toBe('CLI Workflow');
      expect(record?.plan.tasks[0]?.title).toBe('CLI worker');
    } finally {
      ws.close();
    }
    expect(readFileSync(path.join(cwd, '.omks', 'memory', 'knowledge-events.md'), 'utf8')).toContain('CLI workflow ran');
  });
});

describe('omakase serve', () => {
  it('processes queued tasks one-shot and exits 0', async () => {
    const { cli, out } = harness();
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-serve-'));
    const code = await cli.main(['serve', 'summarize the project', '--cwd', cwd]);
    expect(code).toBe(0);
    expect(out()).toMatch(/processed 1 run/);
  });
});

describe('omakase daemon', () => {
  it('status reports not-running for a project with no daemon', async () => {
    const { cli, out } = harness();
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-daemon-'));
    const code = await cli.main(['daemon', 'status', '--cwd', cwd]);
    expect(code).toBe(0);
    expect(out()).toMatch(/not running/);
  });

  it('stop is a no-op when nothing is running', async () => {
    const { cli, out } = harness();
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-daemon-'));
    const code = await cli.main(['daemon', 'stop', '--cwd', cwd]);
    expect(code).toBe(0);
    expect(out()).toMatch(/no running daemon/);
  });
});

describe('omakase misc', () => {
  it('prints version', async () => {
    const { cli, out } = harness();
    await cli.main(['version']);
    expect(out()).toMatch(/omakase \d+\.\d+\.\d+/);
  });
  it('reports unknown commands', async () => {
    const { cli, err } = harness();
    const code = await cli.main(['frobnicate']);
    expect(code).toBe(1);
    expect(err()).toMatch(/unknown command/);
  });
});
