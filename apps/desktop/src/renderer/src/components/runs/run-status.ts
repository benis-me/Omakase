import type { DotStatus } from '../StatusDot';

/** Map a run status to its status-dot color. */
export const RUN_DOT: Record<string, DotStatus> = {
  running: 'omk',
  paused: 'warn',
  pending: 'warn',
  'waiting-for-user': 'warn',
  incomplete: 'warn',
  interrupted: 'idle',
  succeeded: 'run',
  failed: 'fail',
  cancelled: 'idle',
};

/** Non-terminal statuses — a run with one of these is mid-flight when actually
 *  in-process, or interrupted when not. */
export const LIVE_STATUSES = new Set(['running', 'paused', 'pending', 'waiting-for-user']);

/**
 * What to SHOW for a run. A persisted non-terminal status (e.g. `running`) only
 * means live if the run is actually in-process (`live`). After an app restart the
 * record still says `running` but nothing runs — surface that honestly as
 * `interrupted` so the UI never claims work is happening when it isn't.
 */
export function effectiveStatus(status: string, live: boolean): string {
  if (live) return status;
  return LIVE_STATUSES.has(status) ? 'interrupted' : status;
}
