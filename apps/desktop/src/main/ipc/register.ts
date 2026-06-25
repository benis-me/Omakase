/**
 * Wire the renderer's `window.omakase` calls to the {@link WorkspaceHost}.
 * Handlers are thin: validate args, call the host, broadcast change events.
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IPC } from '@shared/ipc';
import type { WorkspaceHost } from '../workspace-host.js';
import type { DevController } from '../dev-controller.js';

export function registerIpc(
  host: WorkspaceHost,
  dev: DevController,
  getWindow: () => BrowserWindow | null,
): void {
  const send = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload);
  };
  const emitWorkspaces = (): void => send(IPC.EvtWorkspacesChanged, host.listWorkspaces());
  const emitActive = (): void => send(IPC.EvtActiveWorkspaceChanged, host.getActiveDto());
  const emitSettings = (): void => send(IPC.EvtSettingsChanged, host.getSettings());

  ipcMain.handle(IPC.WorkspacesList, () => host.listWorkspaces());
  ipcMain.handle(IPC.WorkspacesActive, () => host.getActiveDto());

  ipcMain.handle(IPC.WorkspacesPickFolder, async () => {
    const win = getWindow();
    const options = {
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC.WorkspacesCreate, (_e, parentDir: string, name: string) => {
    const ws = host.create(parentDir, name);
    emitWorkspaces();
    emitActive();
    return ws;
  });

  ipcMain.handle(IPC.WorkspacesAdd, (_e, target: string) => {
    const ws = host.add(target);
    emitWorkspaces();
    emitActive();
    return ws;
  });

  ipcMain.handle(IPC.WorkspacesOpen, (_e, target: string) => {
    const ws = host.open(target);
    emitWorkspaces();
    emitActive();
    return ws;
  });

  ipcMain.handle(IPC.WorkspacesClose, () => {
    host.close();
    emitActive();
  });

  ipcMain.handle(IPC.WorkspacesRemove, (_e, target: string) => {
    const list = host.remove(target);
    emitActive();
    return list;
  });

  ipcMain.handle(IPC.WorkspacesReorder, (_e, paths: string[]) => host.reorder(paths));
  ipcMain.handle(IPC.WorkspacesSetPinned, (_e, target: string, pinned: boolean) =>
    host.setPinned(target, pinned),
  );
  ipcMain.handle(IPC.WorkspacesHasLegacy, (_e, target: string) => host.hasLegacy(target));
  ipcMain.handle(IPC.WorkspacesImportLegacy, (_e, target: string) => host.importLegacy(target));

  ipcMain.handle(IPC.SettingsGet, () => host.getSettings());
  ipcMain.handle(IPC.SettingsSet, (_e, partial) => {
    const settings = host.setSettings(partial);
    emitSettings();
    return settings;
  });

  ipcMain.handle(IPC.ShellOpenPath, (_e, target: string) => shell.openPath(target));
  ipcMain.handle(IPC.ShellOpenExternal, (_e, url: string) => shell.openExternal(url));

  // Dev workbench
  ipcMain.handle(IPC.DevScan, () => dev.scan());
  ipcMain.handle(IPC.ScriptsStart, (_e, id: string) => dev.start(id));
  ipcMain.handle(IPC.ScriptsStop, (_e, id: string) => dev.stop(id));
  ipcMain.handle(IPC.ScriptsRestart, (_e, id: string) => dev.restart(id));
  ipcMain.handle(IPC.ScriptsSessions, () => dev.sessions());
  ipcMain.handle(IPC.TerminalWrite, (_e, id: string, data: string) => dev.write(id, data));
  ipcMain.handle(IPC.TerminalResize, (_e, id: string, cols: number, rows: number) =>
    dev.resize(id, cols, rows),
  );
  ipcMain.handle(IPC.TerminalGetBuffer, (_e, id: string) => dev.getBuffer(id));
  ipcMain.handle(IPC.TerminalClear, (_e, id: string) => dev.clear(id));
}
