/**
 * Watches the active workspace's authored `.omks/` content (specs, agents, memory,
 * commands, workflows, triggers) and fires when it changes — whether the user
 * edits it or an agent autonomously authors a file mid-run — so the renderer can
 * refresh its lists. The high-volume run/event SQLite (`omks.db`) and the control
 * channel are excluded.
 */
import { watch, type FSWatcher } from 'chokidar';
import { join } from 'node:path';
import type { WorkspaceHost } from './workspace-host.js';

const IGNORED = /(?:^|[\\/])(?:omks\.db|omks\.db-.*|control)(?:[\\/]|$)/;

export class ContentWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly host: WorkspaceHost,
    private readonly onChange: () => void,
  ) {}

  /** Re-point at the active workspace's `.omks/`. Call on workspace switch. */
  reconfigure(): void {
    void this.watcher?.close();
    this.watcher = null;
    const ws = this.host.activeWorkspace;
    if (!ws) return;
    const w = watch(join(ws.root, '.omks'), {
      ignored: IGNORED,
      ignoreInitial: true,
      persistent: true,
      depth: 3,
    });
    const fire = (): void => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.onChange(), 300);
      this.timer.unref?.();
    };
    w.on('add', fire).on('change', fire).on('unlink', fire);
    this.watcher = w;
  }

  shutdown(): void {
    if (this.timer) clearTimeout(this.timer);
    void this.watcher?.close();
    this.watcher = null;
  }
}
