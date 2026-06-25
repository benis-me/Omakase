/**
 * A menu-bar tray so the app stays useful when its window is closed. On macOS
 * the process keeps running after the last window closes (so in-process runs
 * keep executing) — the tray shows how many runs are live and lets the user
 * reopen the window or quit. Tray is macOS-only; other platforms quit on close.
 */
import { app, Menu, nativeImage, Tray } from 'electron';

export class TrayController {
  private tray: Tray | null = null;

  constructor(private readonly showWindow: () => void) {}

  init(): void {
    if (process.platform !== 'darwin') return;
    this.tray = new Tray(nativeImage.createEmpty());
    this.tray.setToolTip('Omakase');
    this.update(0);
  }

  update(liveRuns: number): void {
    if (!this.tray) return;
    this.tray.setTitle(liveRuns > 0 ? `✳ ${liveRuns}` : '✳');
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: liveRuns > 0 ? `${liveRuns} run${liveRuns === 1 ? '' : 's'} running` : 'No active runs',
          enabled: false,
        },
        { type: 'separator' },
        { label: 'Open Omakase', click: () => this.showWindow() },
        { label: 'Quit Omakase', click: () => app.quit() },
      ]),
    );
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
