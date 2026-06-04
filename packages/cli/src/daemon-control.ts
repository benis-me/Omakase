/**
 * Per-project detached-daemon lifecycle. The TUI/desktop app calls
 * {@link ensureDaemon} to guarantee an `omakase serve --watch` process is
 * running for a project, then talks to it purely through the filesystem
 * (RunStore + control files). The daemon survives the client quitting — that is
 * what makes a submitted run persistent.
 *
 * Discovery is via `<cwd>/.omakase/daemon.json` + a liveness check; spawning is
 * guarded by an exclusive lock so two clients can't race two daemons onto the
 * same runs dir (which would double-drive runs). `spawn`/`isAlive`/`now` are
 * injectable so the discover/reuse/respawn logic is unit-testable without real
 * processes.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { openSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

const DAEMON_VERSION = '0.1.0';

export interface DaemonInfo {
  pid: number;
  startedAt: number;
  version: string;
  cwd: string;
}

export interface SpawnedDaemon {
  pid: number | undefined;
  unref(): void;
}

export type DaemonSpawn = (command: string, args: string[], logPath: string) => SpawnedDaemon;

export interface EnsureDaemonDeps {
  spawn?: DaemonSpawn;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  execPath?: string;
  scriptPath?: string;
}

/** True if a process with this pid exists (EPERM = exists but not ours). */
export function isDaemonAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

function paths(cwd: string) {
  const dir = path.join(cwd, '.omakase');
  return {
    dir,
    info: path.join(dir, 'daemon.json'),
    lock: path.join(dir, 'daemon.lock'),
    log: path.join(dir, 'daemon.log'),
    heartbeat: path.join(dir, 'daemon-heartbeat'),
  };
}

async function readDaemonInfo(infoPath: string): Promise<DaemonInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(infoPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof (parsed as DaemonInfo).pid === 'number') {
      return parsed as DaemonInfo;
    }
  } catch {
    /* missing / torn */
  }
  return null;
}

export async function writeDaemonInfo(cwd: string, info: DaemonInfo): Promise<void> {
  const p = paths(cwd);
  await mkdir(p.dir, { recursive: true });
  const tmp = `${p.info}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(info, null, 2), 'utf8');
  await rename(tmp, p.info);
}

/** Record a fresh liveness timestamp; the client uses it to judge run staleness. */
export async function touchHeartbeat(cwd: string, at: number): Promise<void> {
  const p = paths(cwd);
  await mkdir(p.dir, { recursive: true });
  await writeFile(p.heartbeat, String(at), 'utf8');
}

const defaultSpawn: DaemonSpawn = (command, args, logPath) => {
  const fd = openSync(logPath, 'a');
  const child = nodeSpawn(command, args, { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  return { pid: child.pid, unref: () => undefined };
};

async function waitForDaemon(
  infoPath: string,
  isAlive: (pid: number) => boolean,
  timeoutMs: number,
): Promise<DaemonInfo | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await readDaemonInfo(infoPath);
    if (info && isAlive(info.pid)) return info;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Ensure a daemon is running for `cwd`, returning its {@link DaemonInfo}. Reuses
 * a live one; otherwise spawns `serve --watch` detached, guarded by an exclusive
 * lock so concurrent clients converge on a single daemon.
 */
export async function ensureDaemon(cwd: string, deps: EnsureDaemonDeps = {}): Promise<DaemonInfo> {
  const p = paths(cwd);
  const isAlive = deps.isAlive ?? isDaemonAlive;
  const now = deps.now ?? (() => Date.now());
  const spawnFn = deps.spawn ?? defaultSpawn;
  const execPath = deps.execPath ?? process.execPath;
  const scriptPath = deps.scriptPath ?? process.argv[1] ?? '';

  const existing = await readDaemonInfo(p.info);
  if (existing && isAlive(existing.pid)) return existing;

  await mkdir(p.dir, { recursive: true });

  // Claim the spawn so two clients don't start two daemons on the same runs dir.
  let claimed = false;
  try {
    await writeFile(p.lock, String(now()), { flag: 'wx' });
    claimed = true;
  } catch {
    // Another client is spawning — wait for its daemon.json, else take over a
    // stale lock left by a spawner that died mid-start.
    const info = await waitForDaemon(p.info, isAlive, 3000);
    if (info) return info;
    await rm(p.lock, { force: true });
    await writeFile(p.lock, String(now()), { flag: 'wx' }).catch(() => undefined);
  }

  try {
    const args = [scriptPath, 'serve', '--watch', '--cwd', cwd];
    const child = spawnFn(execPath, args, p.log);
    const info: DaemonInfo = {
      pid: child.pid ?? -1,
      startedAt: now(),
      version: DAEMON_VERSION,
      cwd,
    };
    await writeDaemonInfo(cwd, info);
    return info;
  } finally {
    void claimed; // (claimed only documents which branch took the lock)
    await rm(p.lock, { force: true });
  }
}
