/**
 * Find and free TCP ports via `lsof`. Ported from DevDock. Runner/killer/sleeper
 * are injectable for tests; `parseLsof` is pure.
 */
import { execFile } from 'node:child_process';
import type { PortInfo } from '@shared/types';

export type Runner = (cmd: string, args: string[]) => Promise<string>;
export type Killer = (pid: number, signal: NodeJS.Signals) => void;
export type Sleeper = (ms: number) => Promise<void>;

const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (_err, stdout) => resolve(stdout ?? ''));
  });

const defaultKiller: Killer = (pid, signal) => {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
};

const defaultSleeper: Sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse `lsof -nP -iTCP:<port> -sTCP:LISTEN`, deduped by pid. */
export function parseLsof(output: string, port: number): PortInfo[] {
  const out: PortInfo[] = [];
  const seen = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const pid = Number(cols[1]);
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    out.push({ port, pid, command: cols[0] });
  }
  return out;
}

export class PortService {
  constructor(
    private readonly run: Runner = defaultRunner,
    private readonly kill: Killer = defaultKiller,
    private readonly sleep: Sleeper = defaultSleeper,
  ) {}

  async whoListens(port: number): Promise<PortInfo[]> {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return [];
    const out = await this.run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
    return parseLsof(out, port);
  }

  /** SIGTERM listeners, then SIGKILL survivors; returns the handled pids. */
  async killPort(port: number): Promise<number[]> {
    const procs = await this.whoListens(port);
    if (procs.length === 0) return [];
    const pids = procs.map((p) => p.pid);
    for (const pid of pids) this.kill(pid, 'SIGTERM');
    await this.sleep(400);
    const survivors = (await this.whoListens(port)).map((p) => p.pid);
    for (const pid of survivors) this.kill(pid, 'SIGKILL');
    return pids;
  }

  async killPid(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) return;
    this.kill(pid, 'SIGTERM');
    await this.sleep(400);
    this.kill(pid, 'SIGKILL');
  }
}
