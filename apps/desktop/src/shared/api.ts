/**
 * The typed `window.omakase` surface exposed by the preload bridge. The renderer
 * never imports Node/Electron/@omakase packages directly — it goes through this.
 */
import type {
  ActiveWorkspace,
  AppSettings,
  AppVersions,
  LegacyImportSummary,
  WorkspaceInfo,
} from './types.js';

export interface OmakaseApi {
  workspaces: {
    list(): Promise<WorkspaceInfo[]>;
    active(): Promise<ActiveWorkspace | null>;
    /** Open a native folder picker; returns the chosen path or null. */
    pickFolder(): Promise<string | null>;
    /** Create a new workspace folder `<parentDir>/<name>` and activate it. */
    create(parentDir: string, name: string): Promise<ActiveWorkspace>;
    /** Register an existing folder as a workspace (scaffolding `.omks` if needed) and activate it. */
    add(path: string): Promise<ActiveWorkspace>;
    /** Activate a known workspace. */
    open(path: string): Promise<ActiveWorkspace>;
    close(): Promise<void>;
    remove(path: string): Promise<WorkspaceInfo[]>;
    reorder(paths: string[]): Promise<WorkspaceInfo[]>;
    setPinned(path: string, pinned: boolean): Promise<WorkspaceInfo[]>;
    hasLegacy(path: string): Promise<boolean>;
    importLegacy(path: string): Promise<LegacyImportSummary>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(partial: Partial<AppSettings>): Promise<AppSettings>;
  };
  shell: {
    openPath(path: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  versions: AppVersions;

  onWorkspacesChanged(cb: (list: WorkspaceInfo[]) => void): () => void;
  onActiveWorkspaceChanged(cb: (ws: ActiveWorkspace | null) => void): () => void;
  onSettingsChanged(cb: (settings: AppSettings) => void): () => void;
}

declare global {
  interface Window {
    omakase: OmakaseApi;
  }
}
