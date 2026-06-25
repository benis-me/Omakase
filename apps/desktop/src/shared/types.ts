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

// ── Dev workbench (DevDock-parity) ───────────────────────────────────────────

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
export type ScriptKind = 'long-running' | 'one-shot';
export type ScriptStatus = 'idle' | 'starting' | 'running' | 'exited' | 'errored';

export interface ScriptInfo {
  /** Stable id: `${projectRel}::${name}`. */
  id: string;
  name: string;
  command: string;
  /** Absolute directory the script runs in. */
  cwd: string;
  /** Project-relative path within the workspace ('.' = root). */
  projectRel: string;
  kind: ScriptKind;
}

export interface ProjectInfo {
  rel: string;
  name: string;
  path: string;
  packageManager: PackageManager;
  type: string | null;
  scripts: ScriptInfo[];
  /** Relative paths of `.env*` files under the project. */
  envFiles: string[];
}

export interface ScriptSession {
  id: string;
  status: ScriptStatus;
  pid: number | null;
  url: string | null;
  startedAt: number | null;
  exitCode: number | null;
}

export interface PortInfo {
  port: number;
  pid: number;
  command: string;
}

export interface GitInfo {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  changes: number;
}

export interface AppInfo {
  id: string;
  name: string;
  path: string;
  kind: 'editor' | 'terminal';
  icon: string | null;
}
