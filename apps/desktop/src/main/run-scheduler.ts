/**
 * The RunScheduler turns triggers (automations) into self-starting runs — the
 * mechanism behind unattended, self-iterating loops ("patrol"). Each enabled
 * trigger arms either an interval timer or a debounced file watcher; when it
 * fires it starts a run from its spec/prompt via the RunHost, unless that
 * trigger's previous run is still live (no pile-ups).
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
}

const IGNORED = /(?:^|[\\/])(?:\.omks|\.git|node_modules|dist|out|release|\.next|coverage)(?:[\\/]|$)/;

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

  private arm(trigger: Trigger): void {
    const entry: ArmedTrigger = { trigger };
    if (trigger.kind === 'interval') {
      const ms = Math.max(1, trigger.intervalMinutes ?? 30) * 60_000;
      entry.timer = setInterval(() => this.fire(trigger.id), ms);
      entry.timer.unref?.();
    } else if (this.root) {
      const watcher = watch(this.root, { ignored: IGNORED, ignoreInitial: true, persistent: true });
      const onChange = (): void => {
        if (entry.debounce) clearTimeout(entry.debounce);
        entry.debounce = setTimeout(() => this.fire(trigger.id), Math.max(500, trigger.debounceMs ?? 5000));
        entry.debounce.unref?.();
      };
      watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
      entry.watcher = watcher;
    }
    this.armed.set(trigger.id, entry);
  }

  private fire(id: string): void {
    const entry = this.armed.get(id);
    if (!entry || !this.root) return;
    const { trigger } = entry;
    // Don't stack runs: skip if this trigger's previous run is still executing.
    if (entry.lastRunId && this.runs.listRuns().some((r) => r.id === entry.lastRunId && r.live)) return;
    if (!trigger.specId && !trigger.prompt) return;
    try {
      entry.lastRunId = this.runs.startRun({
        mode: trigger.mode,
        autonomy: trigger.autonomy,
        ...(trigger.specId ? { specId: trigger.specId } : {}),
        ...(trigger.prompt ? { prompt: trigger.prompt } : {}),
        ...(trigger.agentId ? { agentId: trigger.agentId } : {}),
      });
      markTriggerFired(this.root, trigger.id, this.now());
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
