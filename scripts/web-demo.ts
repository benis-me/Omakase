#!/usr/bin/env bun
// A dashboard demo backed by a scripted (deterministic, slow) harness, so the
// live-streaming UI can be exercised without a real provider or real spend.
//   bun run scripts/web-demo.ts [port]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Workspace, Store, sleep } from '@omakase/core';
import { startWebServer } from '@omakase/cli';
import type { Harness, HarnessRequest, HarnessResult } from '@omakase/engine';

const dir = '/tmp/omks-web-demo';
const port = Number(process.argv[2] ?? 4760);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const ws = Workspace.init(dir);
const store = new Store(ws.paths.db);

const ROLE_COST: Record<string, number> = { planner: 0.0091, reviewer: 0.0117, validator: 0.0068 };
let n = 0;
const harness: Harness = {
  id: 'scripted',
  async runAgent(req: HarnessRequest): Promise<HarnessResult> {
    const nth = ++n;
    const acts =
      req.role === 'worker'
        ? ['Reading src/app.ts', `Writing ${req.title.includes('test') ? 'tests/x.test.ts' : 'src/x.ts'}`, 'Running bun test']
        : req.role === 'planner'
          ? ['Scanning the project layout']
          : [];
    for (const s of acts) {
      req.onActivity?.({ kind: 'tool', summary: s, at: 0 });
      await sleep(2600);
    }
    await sleep(900);
    const text =
      req.role === 'planner'
        ? 'Add the GET /healthz handler\nWrite an integration test for it\nWire the route into the router'
        : req.role === 'reviewer'
          ? 'Looks correct and the suite is green; would add a **404 case** later but nothing blocking.'
          : `Added \`${req.title.includes('test') ? 'tests/healthz.test.ts' : 'src/routes/healthz.ts'}\`; bun test green (3 pass).`;
    if (req.role === 'worker') {
      const f = join(dir, req.title.includes('test') ? 'tests/healthz.test.ts' : 'src/routes/healthz.ts');
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, '// seeded\nexport {};\n');
    }
    return {
      text, status: 'ok', sessionId: `s${nth}`, tokens: 1180 + nth * 137,
      costUsd: Number(((ROLE_COST[req.role] ?? 0.0234) + nth * 0.0016).toFixed(4)),
      activities: [], durationMs: 900, provider: req.provider,
    };
  },
  async listProviders() {
    return [
      { id: 'claude', command: 'claude', label: 'Claude Code', available: true, version: '2.0', path: '/c', models: ['sonnet'] },
      { id: 'codex', command: 'codex', label: 'Codex', available: true, version: '0.5', path: '/x', models: ['gpt-5'] },
    ];
  },
};

startWebServer({ workspace: ws, store, port, harness });
console.log(`web demo (scripted harness) on http://localhost:${port} — cwd ${dir}`);
