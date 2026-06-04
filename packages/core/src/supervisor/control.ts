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
 * timers, no model calls.
 */

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
