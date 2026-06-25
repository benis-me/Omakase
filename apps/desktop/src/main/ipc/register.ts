/**
 * Wire the renderer's `window.omakase` calls to the {@link WorkspaceHost}.
 * Handlers are thin: validate args, call the host, broadcast change events.
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IPC } from '@shared/ipc';
import type { AgentDoc, AutonomyLevel, RunControl, RunStartInput, SpecDoc } from '@shared/types';
import type { WorkspaceHost } from '../workspace-host.js';
import type { DevController } from '../dev-controller.js';
import type { ContentController } from '../content-controller.js';
import type { RunHost } from '../run-host.js';

export function registerIpc(
  host: WorkspaceHost,
  dev: DevController,
  content: ContentController,
  runs: RunHost,
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

  ipcMain.handle(IPC.PortsWho, (_e, port: number) => dev.portsWho(port));
  ipcMain.handle(IPC.PortsKill, (_e, port: number) => dev.portsKill(port));
  ipcMain.handle(IPC.PortsKillPid, (_e, pid: number) => dev.portsKillPid(pid));
  ipcMain.handle(IPC.GitStatus, () => dev.gitStatus());
  ipcMain.handle(IPC.AppsList, () => dev.listApps());
  ipcMain.handle(IPC.AppsOpenWith, (_e, appId: string, target?: string) => dev.openWith(appId, target));
  ipcMain.handle(IPC.AppsOpenTerminal, (_e, appId: string) => dev.openTerminal(appId));
  ipcMain.handle(IPC.EnvRead, (_e, absPath: string) => dev.readEnv(absPath));
  ipcMain.handle(IPC.EnvWrite, (_e, absPath: string, value: string) => dev.writeEnv(absPath, value));

  // Specs
  ipcMain.handle(IPC.SpecsList, () => content.listSpecs());
  ipcMain.handle(IPC.SpecsGet, (_e, id: string) => content.getSpec(id));
  ipcMain.handle(IPC.SpecsCreate, (_e, title: string) => content.createSpec(title));
  ipcMain.handle(IPC.SpecsSave, (_e, doc: SpecDoc) => content.saveSpec(doc));
  ipcMain.handle(IPC.SpecsDelete, (_e, id: string) => content.deleteSpec(id));

  // Agents
  ipcMain.handle(IPC.AgentsList, () => content.listAgents());
  ipcMain.handle(IPC.AgentsGet, (_e, id: string) => content.getAgent(id));
  ipcMain.handle(IPC.AgentsCreate, (_e, name: string) => content.createAgent(name));
  ipcMain.handle(IPC.AgentsSave, (_e, doc: AgentDoc) => content.saveAgent(doc));
  ipcMain.handle(IPC.AgentsDelete, (_e, id: string) => content.deleteAgent(id));
  ipcMain.handle(IPC.AgentsDetect, () => content.detectAgents());

  // Memory
  ipcMain.handle(IPC.MemoryReadAgentsMd, () => content.readAgentsMd());
  ipcMain.handle(IPC.MemoryWriteAgentsMd, (_e, text: string) => content.writeAgentsMd(text));
  ipcMain.handle(IPC.MemoryReadWiki, () => content.readWiki());
  ipcMain.handle(IPC.MemoryListRules, () => content.listRules());
  ipcMain.handle(IPC.MemoryWriteRule, (_e, name: string, body: string) => content.writeRule(name, body));
  ipcMain.handle(IPC.MemoryDeleteRule, (_e, name: string) => content.deleteRule(name));
  ipcMain.handle(IPC.MemoryKnowledgeEvents, () => content.knowledgeEvents());

  // Workflows
  ipcMain.handle(IPC.WorkflowsList, () => content.listWorkflows());
  ipcMain.handle(IPC.WorkflowsGet, (_e, id: string) => content.getWorkflow(id));
  ipcMain.handle(IPC.WorkflowsCreate, (_e, name: string) => content.createWorkflow(name));
  ipcMain.handle(IPC.WorkflowsSave, (_e, id: string, source: string) => content.saveWorkflow(id, source));
  ipcMain.handle(IPC.WorkflowsDelete, (_e, id: string) => content.deleteWorkflow(id));

  // Runs cockpit
  ipcMain.handle(IPC.RunsList, () => runs.listRuns());
  ipcMain.handle(IPC.RunsGet, (_e, id: string) => runs.getRun(id));
  ipcMain.handle(IPC.RunsStart, (_e, input: RunStartInput) => runs.startRun(input));
  ipcMain.handle(IPC.RunsResume, (_e, id: string, autonomy: AutonomyLevel) => runs.resumeRun(id, autonomy));
  ipcMain.handle(IPC.RunsControl, (_e, id: string, command: RunControl) => runs.control(id, command));
  ipcMain.handle(IPC.RunsDelete, (_e, id: string) => runs.deleteRun(id));
}
