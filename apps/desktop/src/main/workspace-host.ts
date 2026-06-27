/**
 * The main-process owner of workspaces and app settings — the equivalent of
 * DevDock's AppController for Phase 2. Holds the global {@link Registry} and at
 * most one open workspace at a time (its SQLite handle + stores), switching by
 * closing the previous. Later phases reach into `activeWorkspace` for the run,
 * spec, agent, and knowledge stores.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  hasLegacyOmakase,
  importLegacyOmakase,
  openWorkspace,
  Registry,
  type OpenWorkspace,
} from '@omakase/storage';
import {
  DEFAULT_SETTINGS,
  type ActiveWorkspace,
  type AppSettings,
  type LegacyImportSummary,
  type WorkspaceInfo,
} from '@shared/types';

export class WorkspaceHost {
  private readonly registry: Registry;
  private active: OpenWorkspace | null = null;
  private activeListener?: (ws: OpenWorkspace | null) => void;

  constructor(registryFile: string) {
    mkdirSync(path.dirname(registryFile), { recursive: true });
    this.registry = Registry.open(registryFile);
  }

  /** Notified whenever the active workspace changes (e.g. so Dev re-scans). */
  setActiveListener(cb: (ws: OpenWorkspace | null) => void): void {
    this.activeListener = cb;
  }

  listWorkspaces(): WorkspaceInfo[] {
    return this.registry.listWorkspaces().map((w) => ({
      path: w.path,
      id: w.id,
      name: w.name,
      pinned: w.pinned,
      sortOrder: w.sortOrder,
      lastOpened: w.lastOpened,
      missing: w.missing || !existsSync(w.path),
    }));
  }

  getActiveDto(): ActiveWorkspace | null {
    return this.active ? toActiveDto(this.active) : null;
  }

  /** Live stores for the active workspace; used by later phases (runs/specs/…). */
  get activeWorkspace(): OpenWorkspace | null {
    return this.active;
  }

  /** Register a folder as a workspace (scaffolding `.omks` if absent) and activate it. */
  add(targetPath: string, name?: string): ActiveWorkspace {
    const resolved = path.resolve(targetPath);
    // Re-opening the already-active workspace must NOT reopen it: that would
    // close the SQLite handle any live runs are still using. Just re-register.
    if (this.active && this.active.root === resolved && !name) {
      this.registry.addWorkspace({ path: resolved, id: this.active.manifest.id, name: this.active.manifest.name });
      this.registry.touch(resolved);
      return toActiveDto(this.active);
    }
    const ws = openWorkspace(resolved, name ? { name } : {});
    this.registry.addWorkspace({ path: resolved, id: ws.manifest.id, name: ws.manifest.name });
    return this.activate(ws);
  }

  /** Create a fresh `<parentDir>/<name>` folder and make it a workspace. */
  create(parentDir: string, name: string): ActiveWorkspace {
    const target = path.join(path.resolve(parentDir), name);
    mkdirSync(target, { recursive: true });
    return this.add(target, name);
  }

  open(targetPath: string): ActiveWorkspace {
    return this.add(targetPath);
  }

  close(): void {
    this.active?.close();
    this.active = null;
    this.registry.setSetting('lastWorkspace', null);
    this.activeListener?.(null);
  }

  remove(targetPath: string): WorkspaceInfo[] {
    const resolved = path.resolve(targetPath);
    if (this.active?.root === resolved) this.close();
    this.registry.removeWorkspace(resolved);
    return this.listWorkspaces();
  }

  reorder(paths: string[]): WorkspaceInfo[] {
    this.registry.reorder(paths.map((p) => path.resolve(p)));
    return this.listWorkspaces();
  }

  setPinned(targetPath: string, pinned: boolean): WorkspaceInfo[] {
    this.registry.setPinned(path.resolve(targetPath), pinned);
    return this.listWorkspaces();
  }

  hasLegacy(targetPath: string): Promise<boolean> {
    return hasLegacyOmakase(path.resolve(targetPath));
  }

  async importLegacy(targetPath: string): Promise<LegacyImportSummary> {
    const resolved = path.resolve(targetPath);
    const owned = this.active?.root === resolved;
    const ws = owned ? this.active! : openWorkspace(resolved);
    try {
      return await importLegacyOmakase(resolved, {
        runStore: ws.runStore,
        sessionStore: ws.sessionStore,
        knowledgeStore: ws.knowledgeStore,
      });
    } finally {
      if (!owned) ws.close();
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  getSettings(): AppSettings {
    return {
      theme: this.registry.getSetting('theme', DEFAULT_SETTINGS.theme),
      language: this.registry.getSetting('language', DEFAULT_SETTINGS.language),
      defaultAutonomy: this.registry.getSetting('defaultAutonomy', DEFAULT_SETTINGS.defaultAutonomy),
      defaultMode: this.registry.getSetting('defaultMode', DEFAULT_SETTINGS.defaultMode),
      lastWorkspace: this.registry.getSetting('lastWorkspace', DEFAULT_SETTINGS.lastWorkspace),
    };
  }

  setSettings(partial: Partial<AppSettings>): AppSettings {
    for (const [key, value] of Object.entries(partial)) this.registry.setSetting(key, value);
    return this.getSettings();
  }

  shutdown(): void {
    this.active?.close();
    this.active = null;
    this.registry.close();
  }

  private activate(ws: OpenWorkspace): ActiveWorkspace {
    if (this.active && this.active !== ws) this.active.close();
    this.active = ws;
    this.registry.touch(ws.root);
    this.registry.setSetting('lastWorkspace', ws.root);
    this.activeListener?.(ws);
    return toActiveDto(ws);
  }
}

function toActiveDto(ws: OpenWorkspace): ActiveWorkspace {
  return {
    path: ws.root,
    manifest: {
      id: ws.manifest.id,
      name: ws.manifest.name,
      createdAt: ws.manifest.createdAt,
      updatedAt: ws.manifest.updatedAt,
      projectRoots: ws.manifest.projectRoots,
    },
  };
}
