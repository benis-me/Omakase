import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureDaemon,
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
