/**
 * TUI launcher. Kept in its own module and imported dynamically by the CLI so
 * that headless commands (`agents`, `run`) never pull in Ink/React.
 */
import React from 'react';
import { render } from 'ink';
import type { AgentRuntime } from '@omakase/daemon';
import type { Orchestrator, WorkMode } from '@omakase/core';
import { App } from './App.js';

export interface LaunchTuiOptions {
  runtime: AgentRuntime;
  orchestrator: Orchestrator;
  task?: string;
  cwd?: string;
  mode: WorkMode;
}

export async function launchTui(options: LaunchTuiOptions): Promise<void> {
  const instance = render(React.createElement(App, options));
  await instance.waitUntilExit();
}

export { App } from './App.js';
export type { AppProps } from './App.js';
