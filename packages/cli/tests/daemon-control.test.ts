import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  daemonStatus,
  ensureDaemon,
  stopDaemon,
  touchHeartbeat,
  writeDaemonInfo,
  type DaemonInfo,
  type SpawnedDaemon,
} from '../src/daemon-control.js';

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'omakase-daemon-'));
}

const base = {
  now: () => 1000,
  execPath: '/usr/bin/node',
  scriptPath: '/opt/omakase/bin/omakase.mjs',
};

describe('ensureDaemon', () => {
  it('spawns a serve --watch daemon when none exists', async () => {
    const cwd = tmp();
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawn = (command: string, args: string[]): SpawnedDaemon => {
      calls.push({ command, args });
      return { pid: 4242, unref: () => {} };
    };
    const info = await ensureDaemon(cwd, { ...base, spawn, isAlive: () => true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('/usr/bin/node');
    expect(calls[0]!.args).toEqual([
      '/opt/omakase/bin/omakase.mjs',
      'serve',
      '--watch',
      '--cwd',
      cwd,
    ]);
    expect(info.pid).toBe(4242);
    const onDisk = JSON.parse(readFileSync(path.join(cwd, '.omakase', 'daemon.json'), 'utf8'));
    expect(onDisk.pid).toBe(4242);
  });

  it('reuses a live daemon (does not spawn a second)', async () => {
    const cwd = tmp();
    await writeDaemonInfo(cwd, { pid: 999, startedAt: 1, version: '0.1.0', cwd });
    const spawn = (): SpawnedDaemon => {
      throw new Error('must not spawn when a live daemon exists');
    };
    const info = await ensureDaemon(cwd, { ...base, spawn, isAlive: (pid) => pid === 999 });
    expect(info.pid).toBe(999);
  });

  it('respawns when the recorded pid is dead', async () => {
    const cwd = tmp();
    await writeDaemonInfo(cwd, { pid: 111, startedAt: 1, version: '0.1.0', cwd });
    let spawned = 0;
    const spawn = (): SpawnedDaemon => {
      spawned += 1;
      return { pid: 222, unref: () => {} };
    };
    const info = await ensureDaemon(cwd, { ...base, spawn, isAlive: (pid) => pid === 222 });
    expect(spawned).toBe(1);
    expect(info.pid).toBe(222);
  });

  it('respawns when the pid is alive but the daemon is stale (pid reuse / wedged)', async () => {
    const cwd = tmp();
    // startedAt long ago, no heartbeat file → not fresh, even though pid "alive".
    await writeDaemonInfo(cwd, { pid: 999, startedAt: 1, version: '0.1.0', cwd });
    let spawned = 0;
    const spawn = (): SpawnedDaemon => {
      spawned += 1;
      return { pid: 222, unref: () => {} };
    };
    const info = await ensureDaemon(cwd, {
      spawn,
      isAlive: () => true,
      now: () => 10_000_000,
      execPath: '/usr/bin/node',
      scriptPath: '/opt/omakase/bin/omakase.mjs',
    });
    expect(spawned).toBe(1);
    expect(info.pid).toBe(222);
  });

  it('forwards serveArgs to the spawned daemon', async () => {
    const cwd = tmp();
    let captured: string[] = [];
    const spawn = (_c: string, args: string[]): SpawnedDaemon => {
      captured = args;
      return { pid: 7, unref: () => {} };
    };
    await ensureDaemon(
      cwd,
      { ...base, spawn, isAlive: () => true },
      { serveArgs: ['--runs-dir', '/r', '--mode', 'max-power'] },
    );
    expect(captured).toEqual([
      '/opt/omakase/bin/omakase.mjs',
      'serve',
      '--watch',
      '--cwd',
      cwd,
      '--runs-dir',
      '/r',
      '--mode',
      'max-power',
    ]);
  });

  it('runs a .ts dev entry through the tsx loader', async () => {
    const cwd = tmp();
    let captured: { command: string; args: string[] } = { command: '', args: [] };
    const spawn = (command: string, args: string[]): SpawnedDaemon => {
      captured = { command, args };
      return { pid: 8, unref: () => {} };
    };
    await ensureDaemon(cwd, {
      ...base,
      scriptPath: '/repo/packages/cli/src/dev.ts',
      spawn,
      isAlive: () => true,
    });
    expect(captured.command).toBe('/usr/bin/node');
    expect(captured.args.slice(0, 3)).toEqual(['--import', 'tsx', '/repo/packages/cli/src/dev.ts']);
    expect(captured.args).toContain('serve');
  });
});

describe('daemon registration helpers', () => {
  it('writeDaemonInfo + touchHeartbeat round-trip on disk', async () => {
    const cwd = tmp();
    const info: DaemonInfo = { pid: 7, startedAt: 5, version: '0.1.0', cwd };
    await writeDaemonInfo(cwd, info);
    expect(JSON.parse(readFileSync(path.join(cwd, '.omakase', 'daemon.json'), 'utf8'))).toEqual(info);
    await touchHeartbeat(cwd, 12345);
    expect(readFileSync(path.join(cwd, '.omakase', 'daemon-heartbeat'), 'utf8')).toBe('12345');
    expect(existsSync(path.join(cwd, '.omakase', 'daemon.json'))).toBe(true);
  });
});

describe('daemonStatus / stopDaemon', () => {
  it('reports not-running when there is no daemon', async () => {
    expect((await daemonStatus(tmp())).running).toBe(false);
  });

  it('reports running with the heartbeat for a live, registered daemon', async () => {
    const cwd = tmp();
    await writeDaemonInfo(cwd, { pid: 321, startedAt: 1, version: '0.1.0', cwd });
    await touchHeartbeat(cwd, 9999);
    const s = await daemonStatus(cwd, { isAlive: (pid) => pid === 321 });
    expect(s).toMatchObject({ running: true, pid: 321, version: '0.1.0', heartbeatAt: 9999 });
  });

  it('stopDaemon signals a live daemon and clears its files', async () => {
    const cwd = tmp();
    await writeDaemonInfo(cwd, { pid: 321, startedAt: 1, version: '0.1.0', cwd });
    await touchHeartbeat(cwd, 1);
    const killed: Array<[number, string]> = [];
    const r = await stopDaemon(cwd, {
      isAlive: (pid) => pid === 321,
      kill: (pid, sig) => killed.push([pid, sig]),
    });
    expect(r).toEqual({ stopped: true, pid: 321 });
    expect(killed).toEqual([[321, 'SIGTERM']]);
    expect(existsSync(path.join(cwd, '.omakase', 'daemon.json'))).toBe(false);
    expect(existsSync(path.join(cwd, '.omakase', 'daemon-heartbeat'))).toBe(false);
  });

  it('stopDaemon is a no-op (stopped:false) when nothing is running', async () => {
    const r = await stopDaemon(tmp(), { isAlive: () => false, kill: () => {} });
    expect(r.stopped).toBe(false);
  });
});
