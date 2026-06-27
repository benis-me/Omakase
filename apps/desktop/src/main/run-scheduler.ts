/**
 * The RunScheduler turns triggers (automations) into self-starting runs — the
 * mechanism behind unattended, self-iterating loops ("patrol"). Each enabled
 * trigger arms either an interval timer or a debounced file watcher; when it
 * fires it starts a run from its spec/prompt via the RunHost.
 *
 * Runaway protection (a watch trigger must not re-trigger itself off the agent's
 * own file writes): while a trigger's run is live we ignore changes entirely, and
 * after a fire a cooldown window absorbs trailing writes / fs settling.
 */
import { watch, type FSWatcher } from 'chokidar';
import { listTriggers, markTriggerFired, type Trigger } from '@omakase/storage';
import type { RunHost } from './run-host.js';
import type { WorkspaceHost } from './workspace-host.js';

interface ArmedTrigger {
  trigger: Trigger;
  timer?: NodeJS.Timeout;
  watcher?: FSWatcher;
  debounce?: NodeJS.Timeout;
  lastRunId?: string;
  lastFiredAt?: number;
}

const IGNORED = /(?:^|[\\/])(?:\.omks|\.git|node_modules|dist|out|release|\.next|coverage)(?:[\\/]|$)/;

/** Minimum gap between fires of the same trigger. */
export const TRIGGER_COOLDOWN_MS = 30_000;

/**
 * The fire decision (pure, exported for testing): skip while the trigger's prior
 * run is still live, and during the cooldown window after the last fire. Together
 * these stop a watch trigger from retriggering itself off its own run's edits.
 */
export function shouldFire(
  state: { lastRunId?: string; lastFiredAt?: number },
  isLive: (runId: string) => boolean,
  now: number,
  cooldownMs = TRIGGER_COOLDOWN_MS,
): boolean {
  if (state.lastRunId && isLive(state.lastRunId)) return false;
  if (state.lastFiredAt !== undefined && now - state.lastFiredAt < cooldownMs) return false;
  return true;
}

/** Milliseconds from `now` until the next local "HH:MM" (today if still ahead, else tomorrow). */
export function nextDailyDelayMs(now: number, hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? '').trim());
  const hours = m ? Math.min(23, Math.max(0, Number(m[1]))) : 2;
  const minutes = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0;
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now;
}

export class RunScheduler {
  private root: string | null = null;
  private readonly armed = new Map<string, ArmedTrigger>();

  constructor(
    private readonly host: WorkspaceHost,
    private readonly runs: RunHost,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Re-arm to the active workspace's enabled triggers. Idempotent — call on
   * workspace switch and whenever triggers change. */
  reconfigure(): void {
    this.teardown();
    const ws = this.host.activeWorkspace;
    this.root = ws?.root ?? null;
    if (!ws) return;
    for (const trigger of listTriggers(ws.root)) {
      if (trigger.enabled) this.arm(trigger);
    }
  }

  private isLive(runId: string): boolean {
    return this.runs.listRuns().some((r) => r.id === runId && r.live);
  }

  private arm(trigger: Trigger): void {
    const entry: ArmedTrigger = { trigger, lastFiredAt: trigger.lastFiredAt };
    if (trigger.kind === 'interval') {
      const ms = Math.max(1, trigger.intervalMinutes ?? 30) * 60_000;
      entry.timer = setInterval(() => this.fire(trigger.id), ms);
      entry.timer.unref?.();
    } else if (trigger.kind === 'daily') {
      this.armDaily(entry);
    } else if (this.root) {
      const watcher = watch(this.root, { ignored: IGNORED, ignoreInitial: true, persistent: true });
      const onChange = (): void => {
        // While this trigger's run is executing, the changes are the agent's own —
        // ignore them entirely (don't even schedule), or the run retriggers itself.
        if (entry.lastRunId && this.isLive(entry.lastRunId)) return;
        if (entry.debounce) clearTimeout(entry.debounce);
        entry.debounce = setTimeout(() => this.fire(trigger.id), Math.max(500, trigger.debounceMs ?? 5000));
        entry.debounce.unref?.();
      };
      watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
      entry.watcher = watcher;
    }
    this.armed.set(trigger.id, entry);
  }

  private armDaily(entry: ArmedTrigger): void {
    const delay = nextDailyDelayMs(this.now(), entry.trigger.dailyTime ?? '02:00');
    entry.timer = setTimeout(() => {
      this.fire(entry.trigger.id);
      // Re-arm for the next day, unless this entry was torn down meanwhile.
      if (this.armed.get(entry.trigger.id) === entry) this.armDaily(entry);
    }, delay);
    entry.timer.unref?.();
  }

  private fire(id: string): void {
    const entry = this.armed.get(id);
    if (!entry || !this.root) return;
    const { trigger } = entry;
    if (!trigger.specId && !trigger.prompt) return;
    if (!shouldFire(entry, (rid) => this.isLive(rid), this.now())) return;
    try {
      entry.lastRunId = this.runs.startRun({
        mode: trigger.mode,
        autonomy: trigger.autonomy,
        triggeredBy: trigger.name,
        ...(trigger.specId ? { specId: trigger.specId } : {}),
        ...(trigger.prompt ? { prompt: trigger.prompt } : {}),
        ...(trigger.agentId ? { agentId: trigger.agentId } : {}),
        ...(trigger.maxTokens ? { maxTokens: trigger.maxTokens } : {}),
      });
      entry.lastFiredAt = this.now();
      markTriggerFired(this.root, trigger.id, entry.lastFiredAt);
    } catch {
      // No active workspace / invalid source — stay armed and try again next fire.
    }
  }

  private teardown(): void {
    for (const entry of this.armed.values()) {
      if (entry.timer) clearInterval(entry.timer);
      if (entry.debounce) clearTimeout(entry.debounce);
      void entry.watcher?.close();
    }
    this.armed.clear();
  }

  shutdown(): void {
    this.teardown();
  }
}
