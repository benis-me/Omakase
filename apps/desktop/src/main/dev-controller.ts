/**
 * The Dev workbench controller (DevDock-parity), keyed to the active workspace.
 * Scans the workspace into projects/scripts and runs long-running scripts via
 * node-pty, surfacing terminal output, status, URLs, and port conflicts to the
 * renderer through the injected {@link DevEvents}.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { OpenWorkspace } from '@omakase/storage';
import type { AppInfo, GitInfo, PortInfo, ProjectInfo, ScriptInfo, ScriptSession } from '@shared/types';
import { scanWorkspace } from './services/scanner.js';
import { ProcessManager } from './services/process-manager.js';
import { PortService } from './services/port-service.js';
import { GitService } from './services/git-service.js';
import { AppLauncher } from './services/app-launcher.js';

export interface DevEvents {
  scriptData(id: string, chunk: string): void;
  scriptStatus(session: ScriptSession): void;
  scriptUrl(id: string, url: string): void;
  projectsUpdated(projects: ProjectInfo[]): void;
  portConflict(id: string, port: number): void;
}

export class DevController {
  private readonly processes: ProcessManager;
  private readonly ports = new PortService();
  private readonly git = new GitService();
  private readonly apps = new AppLauncher();
  private workspace: OpenWorkspace | null = null;
  private projects: ProjectInfo[] = [];
  private readonly scriptIndex = new Map<string, ScriptInfo>();

  constructor(private readonly events: DevEvents) {
    this.processes = new ProcessManager();
    this.processes.on('data', (id: string, chunk: string) => this.events.scriptData(id, chunk));
    this.processes.on('status', (s: ScriptSession) => this.events.scriptStatus(s));
    this.processes.on('url', (id: string, url: string) => this.events.scriptUrl(id, url));
    this.processes.on('port-conflict', (id: string, port: number) => this.events.portConflict(id, port));
  }

  /** Re-point at a new active workspace: stop old processes, re-scan. */
  async setWorkspace(ws: OpenWorkspace | null): Promise<void> {
    if (this.workspace?.root === ws?.root) return;
    this.processes.killAll();
    this.workspace = ws;
    this.projects = [];
    this.scriptIndex.clear();
    if (ws) await this.scan();
    else this.events.projectsUpdated([]);
  }

  async scan(): Promise<ProjectInfo[]> {
    if (!this.workspace) return [];
    this.projects = await scanWorkspace(this.workspace.root, this.workspace.manifest.projectRoots);
    this.scriptIndex.clear();
    for (const p of this.projects) for (const s of p.scripts) this.scriptIndex.set(s.id, s);
    this.events.projectsUpdated(this.projects);
    return this.projects;
  }

  start(id: string): void {
    const script = this.scriptIndex.get(id);
    if (script) this.processes.start({ id: script.id, command: script.command, cwd: script.cwd });
  }

  stop(id: string): void {
    this.processes.stop(id);
  }

  restart(id: string): void {
    this.start(id); // start() stops first
  }

  sessions(): ScriptSession[] {
    return this.processes.list();
  }

  write(id: string, data: string): void {
    this.processes.write(id, data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.processes.resize(id, cols, rows);
  }

  getBuffer(id: string): string {
    return this.processes.getBuffer(id);
  }

  clear(id: string): void {
    this.processes.clearBuffer(id);
  }

  // ── Ports ─────────────────────────────────────────────────────────────────

  portsWho(port: number): Promise<PortInfo[]> {
    return this.ports.whoListens(port);
  }
  portsKill(port: number): Promise<number[]> {
    return this.ports.killPort(port);
  }
  portsKillPid(pid: number): Promise<void> {
    return this.ports.killPid(pid);
  }

  // ── Git ─────────────────────────────────────────────────────────────────

  gitStatus(): Promise<GitInfo | null> {
    return this.workspace ? this.git.info(this.workspace.root) : Promise.resolve(null);
  }
  gitDiff(): Promise<string> {
    return this.workspace ? this.git.diff(this.workspace.root) : Promise.resolve('');
  }

  // ── Open with / terminal ──────────────────────────────────────────────────

  listApps(): AppInfo[] {
    return this.apps.list();
  }
  openWith(appId: string, target?: string): void {
    this.apps.openWith(appId, this.resolveInWorkspace(target) ?? this.workspace?.root ?? '');
  }
  openTerminal(appId: string): void {
    if (this.workspace) this.apps.runInTerminal(appId, this.workspace.root, '');
  }

  // ── Env files ─────────────────────────────────────────────────────────────

  readEnv(absPath: string): string {
    const resolved = this.resolveInWorkspace(absPath);
    if (!resolved) return '';
    try {
      return readFileSync(resolved, 'utf8');
    } catch {
      return '';
    }
  }
  writeEnv(absPath: string, content: string): void {
    const resolved = this.resolveInWorkspace(absPath);
    if (resolved) writeFileSync(resolved, content, 'utf8');
  }

  /** Resolve a path and confirm it stays within the workspace root (no escapes). */
  private resolveInWorkspace(target?: string): string | null {
    if (!this.workspace || !target) return null;
    const root = path.resolve(this.workspace.root);
    const resolved = path.resolve(root, target);
    return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
  }

  shutdown(): void {
    this.processes.killAll();
  }
}
