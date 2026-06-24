import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';

describe('Registry', () => {
  let registry: Registry;

  beforeEach(() => {
    const file = join(mkdtempSync(join(tmpdir(), 'omks-registry-')), 'registry.db');
    registry = Registry.open(file);
  });

  afterEach(() => {
    registry.close();
  });

  it('adds, lists, pins, reorders, and removes workspaces', () => {
    registry.addWorkspace({ path: '/a', id: 'ida', name: 'Alpha', now: 1 });
    registry.addWorkspace({ path: '/b', id: 'idb', name: 'Bravo', now: 2 });
    registry.addWorkspace({ path: '/c', id: 'idc', name: 'Charlie', now: 3 });
    expect(registry.listWorkspaces().map((w) => w.path)).toEqual(['/a', '/b', '/c']);

    // Pinned workspaces sort first.
    registry.setPinned('/c', true);
    expect(registry.listWorkspaces()[0].path).toBe('/c');

    // Reorder the unpinned ones.
    registry.setPinned('/c', false);
    registry.reorder(['/b', '/a', '/c']);
    expect(registry.listWorkspaces().map((w) => w.path)).toEqual(['/b', '/a', '/c']);

    registry.removeWorkspace('/a');
    expect(registry.listWorkspaces().map((w) => w.path)).toEqual(['/b', '/c']);
  });

  it('upserts an existing workspace without losing pin/order', () => {
    registry.addWorkspace({ path: '/a', id: 'ida', name: 'Alpha', now: 1 });
    registry.setPinned('/a', true);
    registry.addWorkspace({ path: '/a', id: 'ida', name: 'Alpha Renamed', now: 5 });
    const entry = registry.getWorkspace('/a');
    expect(entry?.name).toBe('Alpha Renamed');
    expect(entry?.pinned).toBe(true);
  });

  it('stores and reads JSON settings', () => {
    expect(registry.getSetting('theme', 'system')).toBe('system');
    registry.setSetting('theme', 'dark');
    registry.setSetting('defaultAutonomy', 'low');
    expect(registry.getSetting('theme', 'system')).toBe('dark');
    expect(registry.allSettings()).toEqual({ theme: 'dark', defaultAutonomy: 'low' });
  });

  it('replaces the apps cache atomically', () => {
    registry.setAppsCache([
      { id: 'vscode', name: 'VS Code', path: '/Applications/VS Code.app', kind: 'editor', icon: null },
    ]);
    expect(registry.getAppsCache()).toHaveLength(1);
    registry.setAppsCache([]);
    expect(registry.getAppsCache()).toHaveLength(0);
  });
});
