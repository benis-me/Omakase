/**
 * IPC channel names. Centralised so the preload bridge and the main-process
 * handlers can't drift. `Evt*` channels are main → renderer pushes.
 */
export const IPC = {
  // Workspaces
  WorkspacesList: 'workspaces:list',
  WorkspacesActive: 'workspaces:active',
  WorkspacesPickFolder: 'workspaces:pickFolder',
  WorkspacesCreate: 'workspaces:create',
  WorkspacesAdd: 'workspaces:add',
  WorkspacesOpen: 'workspaces:open',
  WorkspacesClose: 'workspaces:close',
  WorkspacesRemove: 'workspaces:remove',
  WorkspacesReorder: 'workspaces:reorder',
  WorkspacesSetPinned: 'workspaces:setPinned',
  WorkspacesHasLegacy: 'workspaces:hasLegacy',
  WorkspacesImportLegacy: 'workspaces:importLegacy',

  // Settings
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',

  // Shell
  ShellOpenPath: 'shell:openPath',
  ShellOpenExternal: 'shell:openExternal',

  // Dev workbench
  DevScan: 'dev:scan',
  ScriptsStart: 'scripts:start',
  ScriptsStop: 'scripts:stop',
  ScriptsRestart: 'scripts:restart',
  ScriptsSessions: 'scripts:sessions',
  TerminalWrite: 'terminal:write',
  TerminalResize: 'terminal:resize',
  TerminalGetBuffer: 'terminal:getBuffer',
  TerminalClear: 'terminal:clear',
  PortsWho: 'ports:who',
  PortsKill: 'ports:kill',
  PortsKillPid: 'ports:killPid',
  GitStatus: 'git:status',
  AppsList: 'apps:list',
  AppsOpenWith: 'apps:openWith',
  AppsOpenTerminal: 'apps:openTerminal',
  EnvRead: 'env:read',
  EnvWrite: 'env:write',

  // Specs
  SpecsList: 'specs:list',
  SpecsGet: 'specs:get',
  SpecsCreate: 'specs:create',
  SpecsSave: 'specs:save',
  SpecsDelete: 'specs:delete',

  // Agents (authored definitions + local detection)
  AgentsList: 'agents:list',
  AgentsGet: 'agents:get',
  AgentsCreate: 'agents:create',
  AgentsSave: 'agents:save',
  AgentsDelete: 'agents:delete',
  AgentsDetect: 'agents:detect',

  // Memory
  MemoryReadAgentsMd: 'memory:readAgentsMd',
  MemoryWriteAgentsMd: 'memory:writeAgentsMd',
  MemoryReadWiki: 'memory:readWiki',
  MemoryListRules: 'memory:listRules',
  MemoryWriteRule: 'memory:writeRule',
  MemoryDeleteRule: 'memory:deleteRule',
  MemoryKnowledgeEvents: 'memory:knowledgeEvents',

  // Workflows
  WorkflowsList: 'workflows:list',
  WorkflowsGet: 'workflows:get',
  WorkflowsCreate: 'workflows:create',
  WorkflowsSave: 'workflows:save',
  WorkflowsDelete: 'workflows:delete',

  // Runs cockpit
  RunsList: 'runs:list',
  RunsGet: 'runs:get',
  RunsStart: 'runs:start',
  RunsResume: 'runs:resume',
  RunsControl: 'runs:control',
  RunsDelete: 'runs:delete',

  // Events (main → renderer)
  EvtWorkspacesChanged: 'evt:workspacesChanged',
  EvtActiveWorkspaceChanged: 'evt:activeWorkspaceChanged',
  EvtSettingsChanged: 'evt:settingsChanged',
  EvtScriptData: 'evt:scriptData',
  EvtScriptStatus: 'evt:scriptStatus',
  EvtScriptUrl: 'evt:scriptUrl',
  EvtProjectsUpdated: 'evt:projectsUpdated',
  EvtPortConflict: 'evt:portConflict',
  EvtRunEvent: 'evt:runEvent',
  EvtRunStatus: 'evt:runStatus',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
