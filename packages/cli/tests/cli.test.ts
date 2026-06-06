import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '@omakase/daemon';
import { MemoryRunStore, Orchestrator, type WorkMode } from '@omakase/core';
import { createCli, parseArgs } from '../src/cli.js';

const OFFLINE = { env: { PATH: '' }, includeWellKnownPathDirs: false } as const;

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const cli = createCli({
    write: (t) => out.push(t),
    error: (t) => err.push(t),
    detectionOptions: OFFLINE,
    createRuntime: () => createAgentRuntime({ fallbackToBuiltin: true, detection: OFFLINE }),
    createOrchestrator: (runtime, mode: WorkMode) =>
      new Orchestrator({
        runtime,
        store: new MemoryRunStore(),
        defaultMode: mode,
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
