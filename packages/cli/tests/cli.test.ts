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
});

describe('omakase agents', () => {
  it('lists detected agents as a table', async () => {
    const { cli, out } = harness();
    const code = await cli.main(['agents']);
    expect(code).toBe(0);
    expect(out()).toContain('ID');
    expect(out()).toContain('claude');
    expect(out()).toMatch(/agents available/);
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
  it('runs a simple task offline via the builtin agent', async () => {
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

  it('emits one JSON object per event with --json', async () => {
    const { cli, out } = harness();
    await cli.main(['run', 'summarize', '--json']);
    const lines = out().split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    expect(events[0]).toHaveProperty('type', 'run-started');
    expect(events.at(-1)).toHaveProperty('type', 'run-finished');
  });
});

describe('omakase tui', () => {
  it('forwards --cwd and --mode to the TUI launcher', async () => {
    let captured: { task?: string; cwd?: string; mode?: string } = {};
    const cli = createCli({
      write: () => {},
      detectionOptions: OFFLINE,
      createRuntime: () => createAgentRuntime({ fallbackToBuiltin: true, detection: OFFLINE }),
      launchTui: async (opts) => {
        captured = { task: opts.task, cwd: opts.cwd, mode: opts.mode };
      },
    });
    const code = await cli.main(['tui', 'do a thing', '--cwd', '/some/dir', '--mode', 'max-power']);
    expect(code).toBe(0);
    expect(captured).toMatchObject({ task: 'do a thing', cwd: '/some/dir', mode: 'max-power' });
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
