import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/ipc';
import type { OmakaseApi } from '@shared/api';

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: OmakaseApi = {
  workspaces: {
    list: () => ipcRenderer.invoke(IPC.WorkspacesList),
    active: () => ipcRenderer.invoke(IPC.WorkspacesActive),
    pickFolder: () => ipcRenderer.invoke(IPC.WorkspacesPickFolder),
    create: (parentDir, name) => ipcRenderer.invoke(IPC.WorkspacesCreate, parentDir, name),
    add: (path) => ipcRenderer.invoke(IPC.WorkspacesAdd, path),
    open: (path) => ipcRenderer.invoke(IPC.WorkspacesOpen, path),
    close: () => ipcRenderer.invoke(IPC.WorkspacesClose),
    remove: (path) => ipcRenderer.invoke(IPC.WorkspacesRemove, path),
    reorder: (paths) => ipcRenderer.invoke(IPC.WorkspacesReorder, paths),
    setPinned: (path, pinned) => ipcRenderer.invoke(IPC.WorkspacesSetPinned, path, pinned),
    hasLegacy: (path) => ipcRenderer.invoke(IPC.WorkspacesHasLegacy, path),
    importLegacy: (path) => ipcRenderer.invoke(IPC.WorkspacesImportLegacy, path),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SettingsGet),
    set: (partial) => ipcRenderer.invoke(IPC.SettingsSet, partial),
  },
  shell: {
    openPath: (path) => ipcRenderer.invoke(IPC.ShellOpenPath, path),
    openExternal: (url) => ipcRenderer.invoke(IPC.ShellOpenExternal, url),
  },
  versions: {
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    chrome: process.versions.chrome ?? '',
    app: '0.1.0',
  },
  onWorkspacesChanged: (cb) => sub(IPC.EvtWorkspacesChanged, cb),
  onActiveWorkspaceChanged: (cb) => sub(IPC.EvtActiveWorkspaceChanged, cb),
  onSettingsChanged: (cb) => sub(IPC.EvtSettingsChanged, cb),
};

contextBridge.exposeInMainWorld('omakase', api);
