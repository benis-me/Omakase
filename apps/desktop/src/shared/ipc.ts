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

  // Events (main → renderer)
  EvtWorkspacesChanged: 'evt:workspacesChanged',
  EvtActiveWorkspaceChanged: 'evt:activeWorkspaceChanged',
  EvtSettingsChanged: 'evt:settingsChanged',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
