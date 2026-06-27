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
  dev: {
    scan: () => ipcRenderer.invoke(IPC.DevScan),
  },
  scripts: {
    start: (scriptId) => ipcRenderer.invoke(IPC.ScriptsStart, scriptId),
    stop: (scriptId) => ipcRenderer.invoke(IPC.ScriptsStop, scriptId),
    restart: (scriptId) => ipcRenderer.invoke(IPC.ScriptsRestart, scriptId),
    sessions: () => ipcRenderer.invoke(IPC.ScriptsSessions),
  },
  terminal: {
    write: (scriptId, data) => ipcRenderer.invoke(IPC.TerminalWrite, scriptId, data),
    resize: (scriptId, cols, rows) => ipcRenderer.invoke(IPC.TerminalResize, scriptId, cols, rows),
    getBuffer: (scriptId) => ipcRenderer.invoke(IPC.TerminalGetBuffer, scriptId),
    clear: (scriptId) => ipcRenderer.invoke(IPC.TerminalClear, scriptId),
  },
  ports: {
    who: (port) => ipcRenderer.invoke(IPC.PortsWho, port),
    kill: (port) => ipcRenderer.invoke(IPC.PortsKill, port),
    killPid: (pid) => ipcRenderer.invoke(IPC.PortsKillPid, pid),
  },
  git: {
    status: () => ipcRenderer.invoke(IPC.GitStatus),
  },
  apps: {
    list: () => ipcRenderer.invoke(IPC.AppsList),
    openWith: (appId, target) => ipcRenderer.invoke(IPC.AppsOpenWith, appId, target),
    openTerminal: (appId) => ipcRenderer.invoke(IPC.AppsOpenTerminal, appId),
  },
  env: {
    read: (absPath) => ipcRenderer.invoke(IPC.EnvRead, absPath),
    write: (absPath, content) => ipcRenderer.invoke(IPC.EnvWrite, absPath, content),
  },
  specs: {
    list: () => ipcRenderer.invoke(IPC.SpecsList),
    get: (id) => ipcRenderer.invoke(IPC.SpecsGet, id),
    create: (title) => ipcRenderer.invoke(IPC.SpecsCreate, title),
    save: (doc) => ipcRenderer.invoke(IPC.SpecsSave, doc),
    delete: (id) => ipcRenderer.invoke(IPC.SpecsDelete, id),
    advance: (id) => ipcRenderer.invoke(IPC.SpecsAdvance, id),
  },
  agents: {
    list: () => ipcRenderer.invoke(IPC.AgentsList),
    get: (id) => ipcRenderer.invoke(IPC.AgentsGet, id),
    create: (name) => ipcRenderer.invoke(IPC.AgentsCreate, name),
    save: (doc) => ipcRenderer.invoke(IPC.AgentsSave, doc),
    delete: (id) => ipcRenderer.invoke(IPC.AgentsDelete, id),
    detect: () => ipcRenderer.invoke(IPC.AgentsDetect),
  },
  memory: {
    readAgentsMd: () => ipcRenderer.invoke(IPC.MemoryReadAgentsMd),
    writeAgentsMd: (text) => ipcRenderer.invoke(IPC.MemoryWriteAgentsMd, text),
    readWiki: () => ipcRenderer.invoke(IPC.MemoryReadWiki),
    listRules: () => ipcRenderer.invoke(IPC.MemoryListRules),
    writeRule: (name, body) => ipcRenderer.invoke(IPC.MemoryWriteRule, name, body),
    deleteRule: (name) => ipcRenderer.invoke(IPC.MemoryDeleteRule, name),
    knowledgeEvents: () => ipcRenderer.invoke(IPC.MemoryKnowledgeEvents),
  },
  workflows: {
    list: () => ipcRenderer.invoke(IPC.WorkflowsList),
    templates: () => ipcRenderer.invoke(IPC.WorkflowsTemplates),
    get: (id) => ipcRenderer.invoke(IPC.WorkflowsGet, id),
    create: (name, templateId) => ipcRenderer.invoke(IPC.WorkflowsCreate, name, templateId),
    save: (id, source) => ipcRenderer.invoke(IPC.WorkflowsSave, id, source),
    delete: (id) => ipcRenderer.invoke(IPC.WorkflowsDelete, id),
  },
  commands: {
    list: () => ipcRenderer.invoke(IPC.CommandsList),
    get: (name) => ipcRenderer.invoke(IPC.CommandsGet, name),
    create: (name) => ipcRenderer.invoke(IPC.CommandsCreate, name),
    save: (name, body) => ipcRenderer.invoke(IPC.CommandsSave, name, body),
    delete: (name) => ipcRenderer.invoke(IPC.CommandsDelete, name),
  },
  runs: {
    list: () => ipcRenderer.invoke(IPC.RunsList),
    get: (id) => ipcRenderer.invoke(IPC.RunsGet, id),
    start: (input) => ipcRenderer.invoke(IPC.RunsStart, input),
    startWorkflow: (workflowId, autonomy) => ipcRenderer.invoke(IPC.RunsStartWorkflow, workflowId, autonomy),
    resume: (id, autonomy) => ipcRenderer.invoke(IPC.RunsResume, id, autonomy),
    control: (id, command) => ipcRenderer.invoke(IPC.RunsControl, id, command),
    delete: (id) => ipcRenderer.invoke(IPC.RunsDelete, id),
  },
  triggers: {
    list: () => ipcRenderer.invoke(IPC.TriggersList),
    save: (input) => ipcRenderer.invoke(IPC.TriggersSave, input),
    delete: (id) => ipcRenderer.invoke(IPC.TriggersDelete, id),
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
  onScriptData: (cb) => sub(IPC.EvtScriptData, cb),
  onScriptStatus: (cb) => sub(IPC.EvtScriptStatus, cb),
  onScriptUrl: (cb) => sub(IPC.EvtScriptUrl, cb),
  onProjectsUpdated: (cb) => sub(IPC.EvtProjectsUpdated, cb),
  onPortConflict: (cb) => sub(IPC.EvtPortConflict, cb),
  onRunEvent: (cb) => sub(IPC.EvtRunEvent, cb),
  onRunStatus: (cb) => sub(IPC.EvtRunStatus, cb),
};

contextBridge.exposeInMainWorld('omakase', api);
