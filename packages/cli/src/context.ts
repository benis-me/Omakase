// Resolve the active workspace + store for a command.

import { Workspace, Store } from '@omakase/core';

export interface CliContext {
  workspace: Workspace;
  store: Store;
}

export function openContext(cwd: string = process.cwd()): CliContext {
  const workspace = Workspace.require(cwd);
  const store = new Store(workspace.paths.db);
  return { workspace, store };
}

export function tryOpenContext(cwd: string = process.cwd()): CliContext | null {
  const workspace = Workspace.find(cwd);
  if (!workspace) return null;
  return { workspace, store: new Store(workspace.paths.db) };
}
