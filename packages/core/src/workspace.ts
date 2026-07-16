// The .omks workspace: Omakase's per-project home, analogous to .git.
//
// Layout:
//   .omks/
//     workspace.json     workspace identity + settings
//     omks.db            SQLite state (runs, events, sessions, tasks, ...)
//     workflows/         Dynamic Workflow *.ts files (versioned, reusable)
//     agents/            custom agent/role definitions
//     commands/          user-defined omks commands
//     specs/             specifications the workflows consume
//     memory/            AGENTS.md briefing + rules/
//     runs/              per-run JSONL journals (mirrors the event log)

import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { uuid } from './ids.ts';
import type { WorkspaceConfig } from './types.ts';

export const OMKS_DIR = '.omks';

export interface WorkspacePaths {
  root: string; // project root containing .omks
  dir: string; // the .omks directory
  configFile: string;
  db: string;
  workflows: string;
  agents: string;
  commands: string;
  specs: string;
  memory: string;
  memoryRules: string;
  runs: string;
  agentsCache: string;
}

function pathsFor(root: string): WorkspacePaths {
  const dir = join(root, OMKS_DIR);
  return {
    root,
    dir,
    configFile: join(dir, 'workspace.json'),
    db: join(dir, 'omks.db'),
    workflows: join(dir, 'workflows'),
    agents: join(dir, 'agents'),
    commands: join(dir, 'commands'),
    specs: join(dir, 'specs'),
    memory: join(dir, 'memory'),
    memoryRules: join(dir, 'memory', 'rules'),
    runs: join(dir, 'runs'),
    agentsCache: join(dir, 'agents.json'),
  };
}

const AGENTS_MD_TEMPLATE = `# AGENTS.md

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

/**
 * A resolved Omakase workspace. Owns the .omks directory and its config, but
 * not the database connection (that's @omakase/core Store, opened from paths.db).
 */
export class Workspace {
  readonly paths: WorkspacePaths;
  private config: WorkspaceConfig;

  private constructor(paths: WorkspacePaths, config: WorkspaceConfig) {
    this.paths = paths;
    this.config = config;
  }

  get root(): string {
    return this.paths.root;
  }

  get id(): string {
    return this.config.id;
  }

  get settings() {
    return this.config.settings;
  }

  getConfig(): WorkspaceConfig {
    return this.config;
  }

  /** Walk up from `cwd` to find an existing .omks workspace. */
  static find(cwd: string = process.cwd()): Workspace | null {
    let dir = resolve(cwd);
    // Stop at filesystem root.
    for (;;) {
      const candidate = join(dir, OMKS_DIR, 'workspace.json');
      if (existsSync(candidate)) return Workspace.openAt(dir);
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  /** Open the workspace whose .omks lives directly under `root`. */
  static openAt(root: string): Workspace {
    const paths = pathsFor(resolve(root));
    if (!existsSync(paths.configFile)) {
      throw new Error(`No Omakase workspace at ${paths.dir} (run \`omks init\`)`);
    }
    const config = JSON.parse(readFileSync(paths.configFile, 'utf8')) as WorkspaceConfig;
    return new Workspace(paths, config);
  }

  /** Find an existing workspace or throw a friendly error. */
  static require(cwd: string = process.cwd()): Workspace {
    const ws = Workspace.find(cwd);
    if (!ws) {
      throw new Error(
        'Not inside an Omakase workspace. Run `omks init` here to create one.',
      );
    }
    return ws;
  }

  /** Create a new .omks workspace at `root` (idempotent). */
  static init(root: string = process.cwd(), name?: string): Workspace {
    const abs = resolve(root);
    const paths = pathsFor(abs);
    for (const d of [
      paths.dir,
      paths.workflows,
      paths.agents,
      paths.commands,
      paths.specs,
      paths.memory,
      paths.memoryRules,
      paths.runs,
    ]) {
      mkdirSync(d, { recursive: true });
    }

    let config: WorkspaceConfig;
    if (existsSync(paths.configFile)) {
      config = JSON.parse(readFileSync(paths.configFile, 'utf8')) as WorkspaceConfig;
    } else {
      const now = Date.now();
      config = {
        id: uuid(),
        name: name ?? baseName(abs),
        createdAt: now,
        updatedAt: now,
        projectRoots: [],
        settings: { autoApprove: true, maxAgentsPerRun: 64 },
      };
      writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + '\n');
    }

    // Seed the agent briefing if absent.
    const agentsMd = join(paths.memory, 'AGENTS.md');
    if (!existsSync(agentsMd)) writeFileSync(agentsMd, AGENTS_MD_TEMPLATE);

    // Local gitignore for machine state.
    const gi = join(paths.dir, '.gitignore');
    if (!existsSync(gi)) {
      writeFileSync(
        gi,
        [
          '# Omakase machine state — regenerated, not version-controlled.',
          'omks.db',
          'omks.db-wal',
          'omks.db-shm',
          'agents.json',
          'runs/',
          '*.tmp',
          '',
        ].join('\n'),
      );
    }

    return new Workspace(paths, config);
  }

  /** Persist mutated settings/config back to workspace.json. */
  save(): void {
    this.config.updatedAt = Date.now();
    writeFileSync(this.paths.configFile, JSON.stringify(this.config, null, 2) + '\n');
  }

  updateSettings(patch: Partial<WorkspaceConfig['settings']>): void {
    this.config.settings = { ...this.config.settings, ...patch };
    this.save();
  }

  /** The AGENTS.md briefing text, or '' if none. */
  readMemory(): string {
    const p = join(this.paths.memory, 'AGENTS.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
}

function baseName(p: string): string {
  const parts = resolve(p).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'workspace';
}

/** Common extra bin dirs so we find CLIs launched from a minimal env. */
export function commonBinDirs(): string[] {
  const home = homedir();
  return [
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.deno', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ].filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}
