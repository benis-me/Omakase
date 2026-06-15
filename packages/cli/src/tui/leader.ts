/**
 * The leader-key map (opencode uses ctrl+x). After the leader is pressed, the
 * next key resolves to an action via {@link resolveLeader}. Pure so the binding
 * table is unit-testable; the App owns the pending-state + timeout.
 */
export type LeaderAction =
  | 'sessions'
  | 'new-session'
  | 'model'
  | 'agent'
  | 'stop'
  | 'web'
  | 'help'
  | 'quit'
  | 'sidebar';

export const LEADER_KEYS: Readonly<Record<string, LeaderAction>> = {
  l: 'sessions',
  n: 'new-session',
  m: 'model',
  a: 'agent',
  s: 'stop',
  w: 'web',
  h: 'help',
  q: 'quit',
  o: 'sidebar',
};

export function resolveLeader(input: string): LeaderAction | null {
  return LEADER_KEYS[input.toLowerCase()] ?? null;
}

export const LEADER_HINT =
  'leader (ctrl+x): l sessions · n new · m model · a agent · s stop · w web · o sidebar · q quit';

/** Default leader timeout, mirroring opencode's 2000ms. */
export const LEADER_TIMEOUT_MS = 2000;
