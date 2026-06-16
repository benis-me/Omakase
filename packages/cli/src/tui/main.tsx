/**
 * Bun entry for the TUI. `omakase tui` (Node) ensures the daemon and submits any
 * initial task, then spawns this under Bun (OpenTUI needs FFI). We rebuild the
 * pure client/session layer from the passed dirs and render the app live.
 *   bun --conditions=development run src/tui/main.tsx --cwd … --runs-dir … …
 */
import React from 'react';
import path from 'node:path';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { FileRunStore, FileSessionStore, type WorkMode } from '@omakase/core';
import { createAgentRuntime, type DetectedAgent } from '@omakase/daemon';
import { RunControllerClient } from '../run-client.js';
import { daemonStatus } from '../daemon-control.js';
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
createRoot(renderer).render(
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
  />,
);
