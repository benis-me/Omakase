import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceHost } from './workspace-host.js';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('WorkspaceHost', () => {
  let host: WorkspaceHost;

  beforeEach(() => {
    host = new WorkspaceHost(join(tmp('omk-host-'), 'registry.db'));
  });

  afterEach(() => {
    host.shutdown();
  });

  it('adds a folder as a workspace, scaffolds .omks, and activates it', () => {
    const project = tmp('omk-proj-');
    const active = host.add(project);
    expect(active.path).toBe(resolve(project));
    expect(existsSync(join(project, '.omks', 'workspace.json'))).toBe(true);
    expect(existsSync(join(project, '.omks', 'omks.db'))).toBe(true);
    expect(host.listWorkspaces().map((w) => w.path)).toContain(resolve(project));
    expect(host.getActiveDto()?.path).toBe(resolve(project));
  });

  it('creates a new named workspace folder under a parent', () => {
    const parent = tmp('omk-parent-');
    const active = host.create(parent, 'my-app');
    expect(active.manifest.name).toBe('my-app');
    expect(active.path).toBe(join(resolve(parent), 'my-app'));
    expect(existsSync(join(parent, 'my-app', '.omks', 'workspace.json'))).toBe(true);
  });

  it('switches the active workspace and keeps a stable id across reopen', () => {
    const a = tmp('omk-a-');
    const first = host.add(a);
    const b = tmp('omk-b-');
    host.add(b);
    expect(host.getActiveDto()?.path).toBe(resolve(b));
    // Reopening A returns the same manifest id (idempotent scaffold).
    expect(host.open(a).manifest.id).toBe(first.manifest.id);
  });

  it('persists app settings through the registry', () => {
    expect(host.getSettings().theme).toBe('system');
    expect(host.setSettings({ theme: 'dark', defaultAutonomy: 'high' }).theme).toBe('dark');
    expect(host.getSettings().defaultAutonomy).toBe('high');
  });

  it('records the last workspace and clears it on close', () => {
    const project = tmp('omk-last-');
    host.add(project);
    expect(host.getSettings().lastWorkspace).toBe(resolve(project));
    host.close();
    expect(host.getActiveDto()).toBeNull();
    expect(host.getSettings().lastWorkspace).toBeNull();
  });

  it('removes a workspace and deactivates it when active', () => {
    const project = tmp('omk-rm-');
    host.add(project);
    const list = host.remove(project);
    expect(list.find((w) => w.path === resolve(project))).toBeUndefined();
    expect(host.getActiveDto()).toBeNull();
  });

  it('reports no legacy directory for a fresh folder', async () => {
    const project = tmp('omk-nolegacy-');
    await expect(host.hasLegacy(project)).resolves.toBe(false);
  });
});
