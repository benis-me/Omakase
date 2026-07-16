import { Workspace, Store } from '@omakase/core';

export interface OpenResult {
  workspace: Workspace;
  store: Store;
  created: boolean;
}

/** Find the workspace, or initialize one at `cwd` if none exists. */
export function openOrInit(cwd: string = process.cwd()): OpenResult {
  const existing = Workspace.find(cwd);
  if (existing) return { workspace: existing, store: new Store(existing.paths.db), created: false };
  const ws = Workspace.init(cwd);
  return { workspace: ws, store: new Store(ws.paths.db), created: true };
}
