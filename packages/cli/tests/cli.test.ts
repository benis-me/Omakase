import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createScriptedAgent } from '@omakase/daemon';
import { MemoryRunStore, Orchestrator, projectKnowledgeStore, type WorkMode } from '@omakase/core';
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
    expect(readFileSync(path.join(cwd, '.omakase', 'wiki-pages.json'), 'utf8')).toContain('Project summary');
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
    expect(readFileSync(path.join(cwd, '.omakase', 'wiki.json'), 'utf8')).toContain('Deployment decision');
    expect(readFileSync(path.join(cwd, '.omakase', 'wiki-pages.md'), 'utf8')).toContain('Architecture Decisions');

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
    const runFile = readdirSync(path.join(cwd, '.omakase', 'runs')).find((file) => file.endsWith('.json'));

    expect(code).toBe(0);
    expect(err.join('\n')).toBe('');
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['workflow-created', 'workflow-phase-started', 'agent-event', 'workflow-finished']),
    );
    expect(runFile).toBeTruthy();
    const record = JSON.parse(readFileSync(path.join(cwd, '.omakase', 'runs', runFile!), 'utf8'));
    expect(record.workflow.status).toBe('succeeded');
    expect(record.workflow.phases[0].name).toBe('CLI Workflow');
    expect(record.plan.tasks[0].title).toBe('CLI worker');
    expect(readFileSync(path.join(cwd, '.omakase', 'knowledge-events.json'), 'utf8')).toContain('CLI workflow ran');
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

describe('omakase tui', () => {
  it('ensures a daemon, submits the task, and launches the client TUI', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-tui-'));
    let ensured: string | undefined;
    let captured: { hasClient: boolean; task?: string; token?: string; cwd?: string; mode?: string; readOnlyUrl?: string } = {
      hasClient: false,
    };
    const cli = createCli({
      write: () => {},
      detectionOptions: OFFLINE,
      createRuntime: () => createAgentRuntime({ fallbackToBuiltin: true, detection: OFFLINE }),
      ensureDaemon: async (c) => {
        ensured = c;
        return { pid: 1, startedAt: 0, version: '0', cwd: c };
      },
      launchTui: async (opts) => {
        captured = {
          hasClient: Boolean(opts.client),
          task: opts.task,
          token: opts.token,
          cwd: opts.cwd,
          mode: opts.mode,
          readOnlyUrl: opts.readOnlyUrl,
        };
      },
    });
    const code = await cli.main(['tui', 'do a thing', '--cwd', cwd, '--mode', 'max-power']);
    expect(code).toBe(0);
    expect(ensured).toBe(cwd); // a detached daemon was ensured
    expect(captured).toMatchObject({ hasClient: true, task: 'do a thing', cwd, mode: 'max-power' });
    expect(captured.readOnlyUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(captured.token).toBeTruthy(); // initial task submitted → correlation token
    // a queue file was dropped for the daemon (no in-process Orchestrator)
    const queue = path.join(cwd, '.omakase', 'queue');
    expect(readdirSync(queue).some((f) => f.endsWith('.prompt'))).toBe(true);
  });

  it('wires the TUI wiki editor to the project knowledge store', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-tui-wiki-'));
    const cli = createCli({
      write: () => {},
      detectionOptions: OFFLINE,
      createRuntime: () => createAgentRuntime({ fallbackToBuiltin: true, detection: OFFLINE }),
      ensureDaemon: async (c) => ({ pid: 1, startedAt: 0, version: '0', cwd: c }),
      launchTui: async (opts) => {
        await opts.addWikiEntry?.({
          title: 'TUI editable knowledge',
          body: 'Manual wiki edits from the TUI persist beside agent-authored knowledge.',
          kind: 'note',
          tags: ['knowledge', 'manual', 'tui'],
        });
      },
    });
    const code = await cli.main(['tui', '--cwd', cwd]);
    expect(code).toBe(0);
    expect(readFileSync(path.join(cwd, '.omakase', 'wiki.json'), 'utf8')).toContain('TUI editable knowledge');
    expect(readFileSync(path.join(cwd, '.omakase', 'wiki-pages.md'), 'utf8')).toContain('TUI editable knowledge');
  });

  it('forwards the resolved dirs + flags to the spawned daemon (serveArgs)', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-tui-'));
    let serveArgs: string[] | undefined;
    const cli = createCli({
      write: () => {},
      detectionOptions: OFFLINE,
      createRuntime: () => createAgentRuntime({ fallbackToBuiltin: true, detection: OFFLINE }),
      ensureDaemon: async (c, sa) => {
        serveArgs = sa;
        return { pid: 1, startedAt: 0, version: '0', cwd: c };
      },
      launchTui: async () => {},
    });
    await cli.main(['tui', 'do a thing', '--cwd', cwd, '--mode', 'max-power', '--agent', 'codex']);
    expect(serveArgs).toContain('--mode');
    expect(serveArgs).toContain('max-power');
    expect(serveArgs).toContain('--agent');
    expect(serveArgs).toContain('codex');
    expect(serveArgs).toContain('--runs-dir');
    expect(serveArgs).toContain('--queue-dir');
  });

  it('pins the initial tui task in the queue when --agent is provided', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-tui-agent-'));
    const cli = createCli({
      write: () => {},
      detectionOptions: OFFLINE,
      createRuntime: () => createAgentRuntime({ fallbackToBuiltin: true, detection: OFFLINE }),
      ensureDaemon: async (c) => ({ pid: 1, startedAt: 0, version: '0', cwd: c }),
      launchTui: async () => {},
    });
    await cli.main(['tui', 'do a thing', '--cwd', cwd, '--agent', 'codex']);
    const queue = path.join(cwd, '.omakase', 'queue');
    const queued = readdirSync(queue).find((file) => file.endsWith('.prompt'));
    expect(queued).toBeTruthy();
    expect(readFileSync(path.join(queue, queued!), 'utf8')).toBe('@agent codex\ndo a thing');
  });

  it('does not hang the TUI without an interactive terminal', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-tui-'));
    const out: string[] = [];
    const cli = createCli({
      write: (t) => out.push(t),
      detectionOptions: OFFLINE,
      createRuntime: () => createAgentRuntime({ fallbackToBuiltin: true, detection: OFFLINE }),
      ensureDaemon: async (c) => ({ pid: 1, startedAt: 0, version: '0', cwd: c }),
      // launchTui NOT injected → exercises the real launcher's non-TTY guard
    });
    const code = await cli.main(['tui', 'do a thing', '--cwd', cwd]);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/no interactive terminal/);
  });

  it('launches the run-list TUI when given no task (nothing submitted)', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'omakase-cli-tui-'));
    let captured: { hasClient: boolean; task?: string; token?: string } = { hasClient: false };
    const cli = createCli({
      write: () => {},
      detectionOptions: OFFLINE,
      createRuntime: () => createAgentRuntime({ fallbackToBuiltin: true, detection: OFFLINE }),
      ensureDaemon: async (c) => ({ pid: 1, startedAt: 0, version: '0', cwd: c }),
      launchTui: async (opts) => {
        captured = { hasClient: Boolean(opts.client), task: opts.task, token: opts.token };
      },
    });
    const code = await cli.main(['tui', '--cwd', cwd]);
    expect(code).toBe(0);
    expect(captured.hasClient).toBe(true);
    expect(captured.task).toBeUndefined();
    expect(captured.token).toBeUndefined();
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
