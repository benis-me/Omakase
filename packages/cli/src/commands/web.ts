// `omks web` — a local API server + Vite-built dashboard (React 19 + Vite 8).
//
// Serves JSON at /api/* and the built SPA from packages/web/dist. Runs started
// from the dashboard execute in this process and stream into the same store.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runGoal, discoverWorkflows, RunBus, subscribeRun, type RunOutcome } from '@omakase/engine';
import { detectCached } from '@omakase/providers';
import type { Goal, RunRecord } from '@omakase/core';
import { parseArgs, flagNum, flagBool } from '../args.ts';
import { openOrInit } from './shared.ts';
import { print, printErr, c, banner } from '../ui.ts';

const WEB_DIST = join(import.meta.dir, '..', '..', '..', 'web', 'dist');

export async function cmdWeb(rawArgs: string[]): Promise<number> {
  const args = parseArgs(rawArgs, { value: ['port', 'cwd'] });
  const port = flagNum(args, 'port') ?? 4517;
  const cwd = (args.flags['cwd'] as string) || process.cwd();
  const { workspace, store } = openOrInit(cwd);
  const hasDist = existsSync(join(WEB_DIST, 'index.html'));

  const active = new Map<string, AbortController>();
  const bus = new RunBus();

  const server = Bun.serve({
    port,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // --- API ---
      if (path === '/api/state') {
        const providers = await detectCached(workspace.paths.agentsCache, { discoverModels: false });
        const workflows = discoverWorkflows({ workspace: workspace.paths.workflows }).map((m) => ({
          name: m.name,
          version: m.version,
          scope: m.scope,
          description: m.description,
        }));
        const runs = store.listRuns({ limit: 50 }).map(summarize);
        return json({
          providers: providers.map((p) => ({ id: p.id, label: p.label, available: p.available, version: p.version, models: p.models })),
          workflows,
          runs,
          workspace: { name: workspace.getConfig().name, root: workspace.root },
        });
      }

      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
      if (runMatch && req.method === 'GET') {
        const run = store.getRun(runMatch[1]!);
        if (!run) return json({ error: 'not found' }, 404);
        const after = Number(url.searchParams.get('after') ?? '0') || 0;
        return json({
          run: { ...summarize(run), goal: run.goal },
          events: store.getEvents(run.id, after),
          reports: store.listReports(run.id).map((r) => ({ kind: r.kind, title: r.title, summary: r.summary })),
        });
      }

      const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(path);
      if (cancelMatch && req.method === 'POST') {
        active.get(cancelMatch[1]!)?.abort();
        return json({ ok: true });
      }

      const streamMatch = /^\/api\/runs\/([^/]+)\/stream$/.exec(path);
      if (streamMatch && req.method === 'GET') {
        const id = streamMatch[1]!;
        const after = Number(url.searchParams.get('after') ?? '0') || 0;
        const enc = new TextEncoder();
        let unsub = () => {};
        const stream = new ReadableStream({
          start(controller) {
            const send = (e: unknown) => {
              try {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
              } catch {
                /* closed */
              }
            };
            unsub = subscribeRun(store, bus, id, after, (e) => {
              send(e);
              if (e.type === 'run:ended') {
                unsub();
                try {
                  controller.close();
                } catch {
                  /* already closed */
                }
              }
            });
          },
          cancel() {
            unsub();
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
        });
      }

      if (path === '/api/run' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as { text?: string; workflow?: string };
        if (!body.text?.trim()) return json({ error: 'text required' }, 400);
        const goal: Goal = { text: body.text.trim(), cwd: workspace.root, ...(body.workflow ? { workflow: body.workflow } : {}) };
        const controller = new AbortController();
        let resolveId!: (id: string) => void;
        const idP = new Promise<string>((r) => (resolveId = r));
        void runGoal({
          goal,
          workspace,
          store,
          bus,
          signal: controller.signal,
          onEvent: (e) => resolveId(e.runId),
        })
          .then((o: RunOutcome) => active.delete(o.runId))
          .catch(() => {});
        const runId = await idP;
        active.set(runId, controller);
        return json({ runId });
      }

      if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);

      // --- static SPA ---
      if (!hasDist) {
        return new Response(devNotice(port), { headers: { 'content-type': 'text/html' } });
      }
      const filePath = path === '/' ? '/index.html' : path;
      const file = Bun.file(join(WEB_DIST, filePath));
      if (await file.exists()) return new Response(file);
      return new Response(Bun.file(join(WEB_DIST, 'index.html'))); // SPA fallback
    },
  });

  const openUrl = `http://localhost:${server.port}`;
  print(banner() + '\n');
  print(`${c.green('▸')} Dashboard API on ${c.cyan(openUrl)}`);
  if (hasDist) print(`  ${c.dim('open')} ${c.cyan(openUrl)}`);
  else {
    print(c.yellow('  SPA not built yet.') + c.dim(' Dev: ') + c.cyan('bun --filter @omakase/web dev') + c.dim(` (proxies /api → :${server.port})`));
    print(c.dim('  Prod: ') + c.cyan('bun --filter @omakase/web build') + c.dim(' then reopen this URL.'));
  }
  print(c.dim('\nPress Ctrl-C to stop.'));

  if (hasDist && flagBool(args, 'open')) openBrowser(openUrl);

  return await new Promise<number>((resolve) => {
    process.on('SIGINT', () => {
      server.stop();
      store.close();
      resolve(0);
    });
  });
}

function summarize(r: RunRecord) {
  return {
    id: r.id,
    status: r.status,
    workflow: r.workflow,
    title: r.title,
    summary: r.summary,
    spentAgents: r.spentAgents,
    spentCostUsd: r.spentCostUsd,
    updatedAt: r.updatedAt,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    Bun.spawn([cmd, url], { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    /* best effort */
  }
}

function devNotice(port: number): string {
  return `<!doctype html><meta charset="utf8"><body style="font:14px system-ui;background:#0d0e12;color:#e6e6ea;padding:40px">
  <h2 style="color:#c792ea">omakase web</h2>
  <p>The dashboard SPA isn't built yet. Two options:</p>
  <pre style="background:#16171d;padding:12px;border-radius:8px">bun --filter @omakase/web dev   # dev server on :5178, proxies /api → :${port}
# or
bun --filter @omakase/web build # then reload this page</pre>
  <p>API is live at <code>/api/state</code>.</p></body>`;
}
