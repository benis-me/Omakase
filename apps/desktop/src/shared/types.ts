/**
 * DTOs crossing the IPC boundary. Kept isomorphic (no Node/DOM imports) so both
 * the main process and the renderer can depend on them.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type AutonomyLevel = 'off' | 'low' | 'medium' | 'high';
export type WorkModeName = 'normal' | 'max-power' | 'custom';

export interface AppSettings {
  theme: ThemeMode;
  defaultAutonomy: AutonomyLevel;
  defaultMode: WorkModeName;
  /** Last active workspace path, restored on launch. */
  lastWorkspace: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  defaultAutonomy: 'low',
  defaultMode: 'normal',
  lastWorkspace: null,
};

/** A workspace as listed in the sidebar (from the global registry). */
export interface WorkspaceInfo {
  path: string;
  id: string;
  name: string;
  pinned: boolean;
  sortOrder: number;
  lastOpened: number;
  missing: boolean;
}

export interface WorkspaceManifestDto {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  projectRoots: string[];
}

/** The currently-open workspace (its manifest; stores live in the main process). */
export interface ActiveWorkspace {
  path: string;
  manifest: WorkspaceManifestDto;
}

export interface LegacyImportSummary {
  runs: number;
  sessions: number;
  wikiEntries: number;
  knowledgeEvents: number;
  codegraph: boolean;
}

export interface AppVersions {
  electron: string;
  node: string;
  chrome: string;
  app: string;
}
