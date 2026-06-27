/**
 * DTOs crossing the IPC boundary. Kept isomorphic (no Node/DOM imports) so both
 * the main process and the renderer can depend on them.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type Language = 'en' | 'zh';
export type AutonomyLevel = 'off' | 'low' | 'medium' | 'high';
export type WorkModeName = 'normal' | 'max-power' | 'custom';

export interface AppSettings {
  theme: ThemeMode;
  /** UI language. */
  language: Language;
  defaultAutonomy: AutonomyLevel;
  defaultMode: WorkModeName;
  /** Last active workspace path, restored on launch. */
  lastWorkspace: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  language: 'en',
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
  kind: 'editor' | 'terminal' | 'other';
  icon: string | null;
}

// ── Authored content (specs / agents / memory / workflows) ───────────────────

export type SpecPhase = 'idea' | 'spec' | 'acceptance' | 'test-plan' | 'tasks' | 'done';
export type SpecStatus = 'draft' | 'ready' | 'running' | 'done' | 'archived';

/** One recorded phase advance — mirrors @omakase/core's SpecTransition (kept local to avoid a core import in the renderer bundle). */
export interface SpecTransition {
  from: string;
  to: string;
  at: number;
}

export interface SpecDoc {
  id: string;
  title: string;
  phase: SpecPhase;
  status: SpecStatus;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  body: string;
  acceptanceCriteria: string[];
  testPlan: string[];
  tasks: string[];
  history: SpecTransition[];
}

export interface AgentDoc {
  id: string;
  name: string;
  role: string;
  agentId: string;
  model: string | null;
  reasoning: string | null;
  tools: string[];
  createdAt: number;
  updatedAt: number;
  body: string;
}

export interface WorkflowDoc {
  id: string;
  name: string;
  source: string;
  path: string;
}

/** A reusable prompt recipe ("skill") under `.omks/commands/<name>.md`. Mirrors storage's CommandDoc. */
export interface CommandDocDto {
  name: string;
  description: string;
  body: string;
}

/** A starter workflow offered in the "New workflow" menu (source resolved in main). */
export interface WorkflowTemplateDto {
  id: string;
  name: string;
  description: string;
}

export interface RuleDoc {
  name: string;
  body: string;
}

export interface KnowledgeEventDto {
  id: string;
  runId: string;
  kind: string;
  title: string;
  body: string;
  createdAt: number;
}

/** A locally-detected agent CLI (claude, codex, …) from the daemon. */
export interface DetectedAgentDto {
  id: string;
  name: string;
  available: boolean;
  version: string | null;
  models: string[];
}

// ── Runs cockpit ─────────────────────────────────────────────────────────────

export type RunMode = 'normal' | 'max-power' | 'custom';

export interface RunStartInput {
  mode: RunMode;
  autonomy: AutonomyLevel;
  prompt?: string;
  specId?: string;
  /** Pin every role of this run to a specific agent CLI (detected id). Omit = auto. */
  agentId?: string;
  /** Hard token budget — the run stops once it's spent (0/undefined = no cap). */
  maxTokens?: number;
  /** Name of the automation that started this run (for the "auto" badge). */
  triggeredBy?: string;
}

// ── Triggers (automations) ───────────────────────────────────────────────────

export type TriggerKind = 'interval' | 'daily' | 'watch';

/** A saved automation that starts a run on an interval or on file changes. */
export interface TriggerDto {
  id: string;
  name: string;
  enabled: boolean;
  kind: TriggerKind;
  specId?: string;
  prompt?: string;
  mode: 'normal' | 'max-power';
  autonomy: AutonomyLevel;
  agentId?: string;
  maxTokens?: number;
  intervalMinutes?: number;
  dailyTime?: string;
  debounceMs?: number;
  lastFiredAt?: number;
}

export interface SaveTriggerInput {
  id?: string;
  name: string;
  enabled?: boolean;
  kind: TriggerKind;
  specId?: string;
  prompt?: string;
  mode?: 'normal' | 'max-power';
  autonomy?: AutonomyLevel;
  agentId?: string;
  maxTokens?: number;
  intervalMinutes?: number;
  dailyTime?: string;
  debounceMs?: number;
}

export interface RunSummaryDto {
  id: string;
  mode: string;
  status: string;
  summary: string;
  spentTokens: number | null;
  spentCostUsd: number | null;
  createdAt: number;
  updatedAt: number;
  /** True if this run is executing in-process right now (vs. interrupted/done). */
  live: boolean;
  /** True if a non-live, non-terminal run can be resumed. */
  resumable: boolean;
  /** Name of the automation that started this run, if any (this session). */
  triggeredBy?: string;
}

export type CockpitEventKind =
  | 'status'
  | 'route'
  | 'plan'
  | 'task'
  | 'agent'
  | 'tool'
  | 'review'
  | 'report'
  | 'knowledge'
  | 'gate'
  | 'gate-answered'
  | 'iteration'
  | 'error'
  | 'finished'
  | 'note';

export type CockpitLevel = 'info' | 'warn' | 'error' | 'success';

export interface CockpitEvent {
  seq: number;
  kind: CockpitEventKind;
  title: string;
  detail?: string;
  role?: string;
  status?: string;
  level: CockpitLevel;
  gateId?: string;
  /** For 'agent' events: the spawned sub-agent's identity + resolved CLI/model. */
  agentRunId?: string;
  agentId?: string;
  model?: string | null;
  /** Links an 'agent'/'task' event to its plan task, so a roster can join status. */
  taskId?: string;
}

export interface RunDetailDto {
  summary: RunSummaryDto;
  events: CockpitEvent[];
}

/** A control command the cockpit sends to a run. */
export interface RunControl {
  command: 'stop' | 'pause' | 'resume' | 'input' | 'answer-gate';
  text?: string;
  gateId?: string;
  answer?: string;
}
