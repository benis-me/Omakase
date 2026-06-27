// @omakase/storage — .omks workspace files + per-workspace SQLite persistence.
export const STORAGE_VERSION = '0.1.0';

// ── Database ─────────────────────────────────────────────────────────────────
export { openDatabase, runMigrations, schemaVersion } from './db/database.js';
export type { Db, OpenDatabaseOptions } from './db/database.js';
export { WORKSPACE_MIGRATIONS, REGISTRY_MIGRATIONS } from './db/migrations.js';

// ── Stores (implement the @omakase/core persistence interfaces) ──────────────
export { SqliteRunStore } from './run-store.js';
export type { RunSummary } from './run-store.js';
export { SqliteSessionStore } from './session-store.js';
export { SqliteKnowledgeStore } from './knowledge-store.js';
export type { SqliteKnowledgeStoreOptions } from './knowledge-store.js';

// ── Workspace (.omks scaffold + open factory) ────────────────────────────────
export {
  OMKS_DIR,
  omksDir,
  dbPath,
  specsDir,
  agentsDir,
  memoryDir,
  rulesDir,
  commandsDir,
  workflowsDir,
  workspaceFile,
  isWorkspace,
  readWorkspace,
  writeWorkspace,
  ensureWorkspace,
  openWorkspace,
  WORKFLOW_TEMPLATES,
  workflowTemplateSource,
} from './omks/workspace.js';
export type {
  WorkspaceManifest,
  WorkspaceSettings,
  EnsureWorkspaceOptions,
  OpenWorkspace,
  OpenWorkspaceOptions,
  WorkflowTemplate,
} from './omks/workspace.js';

// ── Authored documents ───────────────────────────────────────────────────────
export {
  parseFrontmatter,
  stringifyFrontmatter,
  asString,
  asNumber,
  asStringArray,
} from './omks/frontmatter.js';
export type { FrontmatterDoc } from './omks/frontmatter.js';
export { slugify, shortId, slugId } from './omks/slug.js';

export { listSpecs, readSpec, writeSpec, createSpec, deleteSpec } from './omks/specs.js';
export type { SpecDoc, SpecStatus, CreateSpecInput } from './omks/specs.js';
export { listTriggers, saveTrigger, deleteTrigger, markTriggerFired } from './omks/triggers.js';
export type { Trigger, TriggerKind, SaveTriggerInput } from './omks/triggers.js';

export { listAgents, readAgent, writeAgent, createAgent, deleteAgent } from './omks/agents.js';
export type { AgentDoc, CreateAgentInput } from './omks/agents.js';

export {
  readAgentsMd,
  writeAgentsMd,
  readWikiMarkdown,
  listRules,
  writeRule,
  deleteRule,
  snapshotInstructionMemory,
  diffInstructionMemory,
  instructionMemoryDrifted,
  describeInstructionDrift,
} from './omks/memory.js';
export type {
  RuleDoc,
  InstructionMemorySnapshot,
  InstructionMemoryDrift,
} from './omks/memory.js';

export { listCommands, readCommand, writeCommand, deleteCommand } from './omks/commands.js';
export type { CommandDoc } from './omks/commands.js';

export {
  listWorkflows,
  readWorkflow,
  writeWorkflow,
  createWorkflow,
  deleteWorkflow,
} from './omks/workflows.js';
export type { WorkflowDoc } from './omks/workflows.js';

// ── Global registry ──────────────────────────────────────────────────────────
export { Registry } from './registry.js';
export type { WorkspaceEntry, AppEntry } from './registry.js';

// ── Legacy import ────────────────────────────────────────────────────────────
export { importLegacyOmakase, hasLegacyOmakase } from './import-legacy.js';
export type { LegacyImportResult, LegacyImportTarget } from './import-legacy.js';
