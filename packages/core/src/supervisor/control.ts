/**
 * Cross-process run control.
 *
 * A detached supervisor (e.g. `omakase serve`) owns the live {@link RunHandle};
 * a separate process (a relaunched TUI / the desktop app) cannot call its
 * `pause`/`resume`/`cancel` methods directly. The only shared channel is the
 * filesystem. A {@link ControlSource} abstracts "is there a pending command for
 * this run?", and the {@link RunController} consults it *inside its own run loop*
 * — the one place that runs concurrently with an in-flight agent (the supervisor
 * itself is blocked in `await handle.result` and observes nothing mid-run).
 *
 * The seam is injectable so the whole control path is unit-testable in-process
 * with {@link FakeControlSource} and a manually-pumped poll — no daemon, no real
 * timers, no model calls. {@link FileControlSource} + {@link writeControl} are the
 * real, cross-process wiring over `<runsDir>/<id>.control.json`.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ControlCommandKind = 'stop' | 'pause' | 'resume' | 'input';

export interface ControlCommand {
  /** Monotonic per-run sequence; a command is applied at most once (seq > last). */
  seq: number;
  command: ControlCommandKind;
  /** For `input`: the text to append to the run's inbox. */
  text?: string;
}

export interface ControlSource {
  /** The latest pending command for a run, or null if none. */
  read(runId: string): Promise<ControlCommand | null>;
}

/**
 * Registers a recurring poll that calls `tick`; returns a disposer. The
 * RunController calls this once per run and disposes it when the run ends. A
 * production wiring uses an unref'd `setInterval`; tests pass a fake that
 * captures `tick` and pumps it manually for determinism.
 */
export type ControlPoll = (tick: () => void) => () => void;

export function isValidControlCommand(value: unknown): value is ControlCommand {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<ControlCommand>;
  return (
    typeof c.seq === 'number' &&
    (c.command === 'stop' ||
      c.command === 'pause' ||
      c.command === 'resume' ||
      c.command === 'input') &&
    (c.text === undefined || typeof c.text === 'string')
  );
}

/** In-memory {@link ControlSource} for tests. */
export class FakeControlSource implements ControlSource {
  private readonly commands = new Map<string, ControlCommand>();

  set(runId: string, command: ControlCommand): void {
    this.commands.set(runId, command);
  }

  async read(runId: string): Promise<ControlCommand | null> {
    return this.commands.get(runId) ?? null;
  }
}

function controlPath(dir: string, runId: string): string {
  return path.join(dir, `${runId}.control.json`);
}

/**
 * Reads the latest control command for a run from `<dir>/<id>.control.json`.
 * Tolerant: a missing, torn, or malformed file reads as null (no pending
 * command), so a poll never throws on a half-written file.
 */
export class FileControlSource implements ControlSource {
  constructor(private readonly dir: string) {}

  async read(runId: string): Promise<ControlCommand | null> {
    let raw: string;
    try {
      raw = await readFile(controlPath(this.dir, runId), 'utf8');
    } catch {
      return null; // no command file yet
    }
    try {
      const parsed = JSON.parse(raw);
      return isValidControlCommand(parsed) ? parsed : null;
    } catch {
      return null; // torn / not-yet-renamed write
    }
  }
}

/**
 * Atomically write a control command for a run (temp + rename), so a reader
 * never observes a partially-written file. The TUI/desktop app is the SOLE
 * writer of the `.control.json`; the daemon is the SOLE writer of the run record.
 */
export async function writeControl(
  dir: string,
  runId: string,
  command: ControlCommand,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = controlPath(dir, runId);
  const tmp = `${target}.${process.pid}.${command.seq}.tmp`;
  await writeFile(tmp, JSON.stringify(command), 'utf8');
  await rename(tmp, target);
}
