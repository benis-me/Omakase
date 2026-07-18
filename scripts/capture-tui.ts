#!/usr/bin/env bun
// Render the real TUI against a real (scripted) run and print the frame, so a
// terminal UI can be looked at while it's being changed instead of guessed at.
//
//   bun run scripts/capture-tui.ts             # 100x30, browsing the stored run
//   bun run scripts/capture-tui.ts 120 40      # a specific size
//
// Keys are driven with OMKS_KEYS (comma-separated), e.g. OMKS_KEYS=down,pagedown.

import { createElement, act } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, Store } from '@omakase/core';
import { runGoal, type Harness, type HarnessRequest, type HarnessResult } from '@omakase/engine';
import type { ProviderInfo } from '@omakase/providers';
import { App } from '../packages/tui/src/app.tsx';

const width = Number(process.argv[2] ?? 100);
const height = Number(process.argv[3] ?? 30);
const keys = (process.env.OMKS_KEYS ?? 'down').split(',').map((k) => k.trim()).filter(Boolean);

const providers: ProviderInfo[] = [
  { id: 'claude', command: 'claude', label: 'Claude', available: true, version: '2.0', path: '/c', models: ['sonnet'] },
  { id: 'codex', command: 'codex', label: 'Codex', available: true, version: '0.5', path: '/x', models: [] },
];

const dir = mkdtempSync(join(tmpdir(), 'omks-tui-cap-'));
const ws = Workspace.init(dir);
const store = new Store(':memory:');

const ROLE_COST: Record<string, number> = { planner: 0.0091, reviewer: 0.0117 };
let n = 0;
const harness: Harness = {
  id: 'scripted',
  async runAgent(req: HarnessRequest): Promise<HarnessResult> {
    const nth = ++n;
    const file = req.title.includes('handler')
      ? 'src/routes/healthz.ts'
      : req.title.includes('test')
        ? 'tests/healthz.test.ts'
        : 'src/router.ts';
    if (req.role === 'worker') {
      for (const s of ['Reading src/app.ts', `Writing ${file}`, 'Running bun test']) {
        req.onActivity?.({ kind: 'tool', summary: s, at: 0 });
      }
    } else if (req.role === 'planner') {
      req.onActivity?.({ kind: 'reasoning', summary: 'Scanning the project layout', at: 0 });
    }
    const text =
      req.role === 'planner'
        ? 'Add the GET /healthz handler\nWrite an integration test\nWire it into the router'
        : req.role === 'reviewer'
          ? 'Handler is correct and the suite is green; a 404 case would be nice later but nothing blocking.'
          : `Added ${file}; bun test green (3 pass). The handler returns {ok, uptime} as JSON with a 200 and the suite covers the happy path.`;
    return {
      text,
      status: 'ok',
      sessionId: `s${nth}`,
      tokens: 1180 + nth * 137,
      costUsd: Number(((ROLE_COST[req.role] ?? 0.0243) + nth * 0.0016).toFixed(4)),
      activities: [],
      durationMs: 900,
      provider: req.provider,
    };
  },
  async listProviders() {
    return providers;
  },
};

await runGoal({
  goal: { text: 'Add a /healthz endpoint and a test', workflow: 'goal', cwd: dir, checks: [{ kind: 'command', run: 'true' }] },
  workspace: ws,
  store,
  harness,
});

// OMKS_DUMP_ROWS prints the rows the log *would* paint, to tell a layout bug
// apart from a painting one.
if (process.env.OMKS_DUMP_ROWS) {
  const { eventLines, layoutRows } = await import('../packages/tui/src/render.ts');
  const runs = store.listRuns({ limit: 1 });
  const rows = layoutRows(eventLines(store.getEvents(runs[0]!.id)), width - 26 - 9, false);
  rows.forEach((r, i) => console.log(String(i).padStart(3), JSON.stringify(r.text)));
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const setup = await testRender(
  createElement(App, { workspace: ws, store, providers, workflows: ['goal', 'auto', 'tdd'], onExit: () => {} }),
  // Kitty keycodes, so pageup/home/end arrive as those keys instead of being
  // typed out as their letters.
  { width, height, kittyKeyboard: true },
);
await setup.renderOnce();

for (const k of keys) {
  await act(async () => {
    if (k === 'down' || k === 'up' || k === 'left' || k === 'right') await setup.mockInput.pressArrow(k as 'down');
    else if (k.startsWith('ctrl+')) await setup.mockInput.pressKey(k.slice(5), { ctrl: true });
    else await setup.mockInput.pressKey(k);
  });
  await setup.renderOnce();
}

console.log(setup.captureCharFrame());
setup.renderer.destroy();
store.close();
rmSync(dir, { recursive: true, force: true });
