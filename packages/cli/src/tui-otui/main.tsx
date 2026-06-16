/**
 * Bun entry for the OpenTUI TUI. The Node-side `omakase tui` command ensures the
 * daemon, submits any initial task, then spawns this under Bun (OpenTUI needs
 * Bun's FFI). We reconstruct the pure client/session layer from the passed dirs
 * and render the app. Run via:
 *   bun --conditions=development run src/tui-otui/main.tsx --cwd … --runs-dir … …
 */
import React from 'react';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import path from 'node:path';
import { FileRunStore, FileSessionStore, type WorkMode } from '@omakase/core';
import { createAgentRuntime, type DetectedAgent } from '@omakase/daemon';
import { RunControllerClient } from '../run-client.js';
import { daemonStatus, stopDaemon } from '../daemon-control.js';
import { App } from './App.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cwd = flag('cwd') ?? process.cwd();
const runsDir = flag('runs-dir') ?? path.join(cwd, '.omakase', 'runs');
const queueDir = flag('queue-dir') ?? path.join(cwd, '.omakase', 'queue');
const mode = (flag('mode') as WorkMode) ?? 'normal';
const token = flag('token');
const readOnlyUrl = flag('read-only-url');

const client = new RunControllerClient({ store: new FileRunStore(runsDir), controlDir: runsDir, queueDir });
const sessions = new FileSessionStore(path.join(cwd, '.omakase', 'sessions'));
const runtime = createAgentRuntime({ fallbackToBuiltin: true, detectionCacheTtlMs: 10_000 });

const renderer = await createCliRenderer({ exitOnCtrlC: true });
const root = createRoot(renderer);
root.render(
  <App
    client={client}
    sessions={sessions}
    cwd={cwd}
    mode={mode}
    {...(token ? { token } : {})}
    {...(readOnlyUrl ? { readOnlyUrl } : {})}
    detect={(): Promise<DetectedAgent[]> => runtime.detect()}
    daemonStatus={async () => {
      const s = await daemonStatus(cwd);
      return { running: s.running, pid: s.pid };
    }}
    stopDaemon={() => stopDaemon(cwd)}
  />,
);
