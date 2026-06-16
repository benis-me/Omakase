/**
 * Pure key → action mapping for the TUI. The view executes Actions; this table
 * is the testable spec of every non-text keybinding (factory + opencode style).
 * Printable input and in-line editing are handled by the native <textarea>.
 */
export interface KeyLike {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export interface KeyCtx {
  leaderArmed: boolean;
  bashMode: boolean;
  overlayOpen: boolean;
  runActive: boolean;
}

export type Action =
  | { type: 'none' }
  | { type: 'close-overlay' }
  | { type: 'palette' }
  | { type: 'arm-leader' }
  | { type: 'sessions' }
  | { type: 'new-session' }
  | { type: 'pick-agent' }
  | { type: 'cycle-agent'; dir: 1 | -1 }
  | { type: 'cycle-mode' }
  | { type: 'toggle-detail' }
  | { type: 'exit-bash' }
  | { type: 'interrupt' }
  | { type: 'help' }
  | { type: 'scroll'; by: number | 'top' | 'bottom' };

const LEADER: Record<string, Action> = {
  l: { type: 'sessions' },
  n: { type: 'new-session' },
  m: { type: 'pick-agent' },
  s: { type: 'sessions' },
  h: { type: 'help' },
};

export function mapKey(key: KeyLike, ctx: KeyCtx): Action {
  const name = (key.name ?? '').toLowerCase();

  if (ctx.overlayOpen) return name === 'escape' ? { type: 'close-overlay' } : { type: 'none' };

  if (ctx.leaderArmed) return LEADER[name] ?? { type: 'none' };

  if (key.ctrl && name === 'x') return { type: 'arm-leader' };
  if (key.ctrl && name === 'p') return { type: 'palette' };
  if (key.ctrl && name === 'n') return { type: 'cycle-agent', dir: 1 };
  if (key.ctrl && name === 'o') return { type: 'toggle-detail' };
  if (name === 'tab' && key.shift) return { type: 'cycle-mode' };
  if (name === 'f2') return { type: 'cycle-agent', dir: 1 };

  if (name === 'pageup') return { type: 'scroll', by: -10 };
  if (name === 'pagedown') return { type: 'scroll', by: 10 };
  if (key.meta && name === 'up') return { type: 'scroll', by: -1 };
  if (key.meta && name === 'down') return { type: 'scroll', by: 1 };

  if (name === 'escape') {
    if (ctx.bashMode) return { type: 'exit-bash' };
    if (ctx.runActive) return { type: 'interrupt' };
    return { type: 'none' };
  }
  return { type: 'none' };
}
