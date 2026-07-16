// launchTUI — boot the OpenTUI renderer and mount the React app.

import { createElement } from 'react';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { Workspace, Store } from '@omakase/core';
import { detectCached } from '@omakase/providers';
import { discoverWorkflows } from '@omakase/engine';
import { App } from './app.tsx';

export interface LaunchOptions {
  initialGoal?: string;
  cwd?: string;
}

export async function launchTUI(opts: LaunchOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const workspace = Workspace.find(cwd) ?? Workspace.init(cwd);
  const store = new Store(workspace.paths.db);
  const providers = await detectCached(workspace.paths.agentsCache, { discoverModels: false });
  const workflows = discoverWorkflows({ workspace: workspace.paths.workflows }).map((m) => m.name);

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  return await new Promise<number>((resolve) => {
    const onExit = (code: number) => {
      try {
        renderer.destroy();
      } catch {
        /* ignore */
      }
      try {
        store.close();
      } catch {
        /* ignore */
      }
      resolve(code);
    };
    root.render(
      createElement(App, {
        workspace,
        store,
        providers,
        workflows,
        onExit,
        ...(opts.initialGoal ? { initialGoal: opts.initialGoal } : {}),
      }),
    );
  });
}
