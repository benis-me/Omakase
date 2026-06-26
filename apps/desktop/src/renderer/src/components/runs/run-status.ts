import type { DotStatus } from '../StatusDot';

/** Map a run status to its status-dot color. */
export const RUN_DOT: Record<string, DotStatus> = {
  running: 'omk',
  paused: 'warn',
  pending: 'warn',
  'waiting-for-user': 'warn',
  incomplete: 'warn',
  succeeded: 'run',
  failed: 'fail',
  cancelled: 'idle',
};

/** Statuses for which a run is still live and controllable. */
export const LIVE_STATUSES = new Set(['running', 'paused', 'pending', 'waiting-for-user']);
