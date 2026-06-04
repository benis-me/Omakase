/**
 * TUI launcher. Kept in its own module and imported dynamically by the CLI so
 * that headless commands (`agents`, `run`) never pull in Ink/React.
 */
import React from 'react';
import { render } from 'ink';
import { App, type AppProps } from './App.js';

/** Options for launching the TUI — it is a pure client over a detached daemon. */
export type LaunchTuiOptions = AppProps;

export async function launchTui(options: LaunchTuiOptions): Promise<void> {
  const instance = render(React.createElement(App, options));
  await instance.waitUntilExit();
}

export { App } from './App.js';
export type { AppProps } from './App.js';
