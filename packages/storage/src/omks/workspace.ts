/**
 * The `.omks/` workspace: a directory of git-friendly authored content (specs,
 * agents, memory, commands, workflows) plus a per-workspace SQLite database for
 * high-volume run/event data. {@link openWorkspace} is the single entrypoint the
 * desktop app and CLI use to get the three core stores wired to one workspace.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { openDatabase, type Db } from '../db/database.js';
import { WORKSPACE_MIGRATIONS } from '../db/migrations.js';
import { SqliteRunStore } from '../run-store.js';
import { SqliteSessionStore } from '../session-store.js';
import { SqliteKnowledgeStore } from '../knowledge-store.js';

export const OMKS_DIR = '.omks';

export interface WorkspaceSettings {
  /** Default work mode for new runs ('max-power' | 'normal' | 'custom'). */
  defaultMode?: string;
  /** Default autonomy level for new runs ('off' | 'low' | 'medium' | 'high'). */
  defaultAutonomy?: string;
  /** Default role → agent-id assignments. */
  defaultAgents?: Record<string, string>;
  [key: string]: unknown;
}

export interface WorkspaceManifest {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  settings: WorkspaceSettings;
  /** Relative paths (from the workspace root) to dev projects to scan. */
  projectRoots: string[];
}

export const omksDir = (root: string): string => path.join(root, OMKS_DIR);
export const dbPath = (root: string): string => path.join(omksDir(root), 'omks.db');
export const specsDir = (root: string): string => path.join(omksDir(root), 'specs');
export const agentsDir = (root: string): string => path.join(omksDir(root), 'agents');
export const memoryDir = (root: string): string => path.join(omksDir(root), 'memory');
export const rulesDir = (root: string): string => path.join(memoryDir(root), 'rules');
export const commandsDir = (root: string): string => path.join(omksDir(root), 'commands');
export const workflowsDir = (root: string): string => path.join(omksDir(root), 'workflows');
export const workspaceFile = (root: string): string => path.join(omksDir(root), 'workspace.json');

/** True if `root` already holds an Omakase workspace. */
export function isWorkspace(root: string): boolean {
  return existsSync(workspaceFile(root));
}

export function readWorkspace(root: string): WorkspaceManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(workspaceFile(root), 'utf8')) as Partial<WorkspaceManifest>;
    if (!parsed || typeof parsed.id !== 'string') return null;
    return {
      id: parsed.id,
      name: typeof parsed.name === 'string' ? parsed.name : path.basename(path.resolve(root)),
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      settings:
        parsed.settings && typeof parsed.settings === 'object'
          ? (parsed.settings as WorkspaceSettings)
          : {},
      projectRoots: Array.isArray(parsed.projectRoots)
        ? parsed.projectRoots.filter((p): p is string => typeof p === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

export function writeWorkspace(root: string, manifest: WorkspaceManifest): void {
  mkdirSync(omksDir(root), { recursive: true });
  writeFileSync(workspaceFile(root), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

const GITIGNORE = `# Omakase machine state — regenerated, not version-controlled.
omks.db
omks.db-wal
omks.db-shm
*.tmp
`;

const STARTER_AGENTS_MD = `# AGENTS.md

A briefing packet for the agents that work in this workspace. Keep it short and
current — agents read this before planning any change.

## Project

_What is this project? What does it do? Where does work happen?_

## Build & test

_How to build, run, and test. The exact commands an agent should run to verify._

## Conventions

_Code style, patterns to follow, things to avoid._

## Done means

_What "complete" looks like here: tests green, lint clean, etc._
`;

export interface EnsureWorkspaceOptions {
  name?: string;
  now?: number;
}

/**
 * Create the `.omks/` scaffold (dirs, .gitignore, starter AGENTS.md, manifest)
 * if absent, and return the manifest. Idempotent: safe to call on every open.
 */
export function ensureWorkspace(root: string, options: EnsureWorkspaceOptions = {}): WorkspaceManifest {
  const now = options.now ?? Date.now();
  for (const dir of [
    omksDir(root),
    specsDir(root),
    agentsDir(root),
    memoryDir(root),
    rulesDir(root),
    commandsDir(root),
    workflowsDir(root),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const gitignore = path.join(omksDir(root), '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, GITIGNORE, 'utf8');

  const agentsMd = path.join(memoryDir(root), 'AGENTS.md');
  if (!existsSync(agentsMd)) writeFileSync(agentsMd, STARTER_AGENTS_MD, 'utf8');

  let manifest = readWorkspace(root);
  if (!manifest) {
    manifest = {
      id: randomUUID(),
      name: options.name ?? path.basename(path.resolve(root)),
      createdAt: now,
      updatedAt: now,
      settings: {},
      projectRoots: [],
    };
    writeWorkspace(root, manifest);
  } else if (options.name && manifest.name !== options.name) {
    manifest = { ...manifest, name: options.name, updatedAt: now };
    writeWorkspace(root, manifest);
  }
  return manifest;
}

export interface OpenWorkspace {
  root: string;
  manifest: WorkspaceManifest;
  db: Db;
  runStore: SqliteRunStore;
  sessionStore: SqliteSessionStore;
  knowledgeStore: SqliteKnowledgeStore;
  close(): void;
}

export interface OpenWorkspaceOptions extends EnsureWorkspaceOptions {
  /** Attach read-only (a non-owner tailing a workspace another process owns). */
  readonly?: boolean;
}

/**
 * Open a workspace: ensure the scaffold, open `omks.db`, and construct the run,
 * session, and knowledge stores. The knowledge store renders git-friendly
 * markdown into `.omks/memory/`. Call `close()` to release the DB handle.
 */
export function openWorkspace(root: string, options: OpenWorkspaceOptions = {}): OpenWorkspace {
  const manifest = options.readonly ? readWorkspace(root) : ensureWorkspace(root, options);
  if (!manifest) throw new Error(`not an Omakase workspace: ${root}`);
  const db = openDatabase(dbPath(root), {
    migrations: WORKSPACE_MIGRATIONS,
    readonly: options.readonly,
  });
  return {
    root,
    manifest,
    db,
    runStore: new SqliteRunStore(db),
    sessionStore: new SqliteSessionStore(db),
    knowledgeStore: new SqliteKnowledgeStore(db, { renderDir: memoryDir(root) }),
    close: () => db.close(),
  };
}
