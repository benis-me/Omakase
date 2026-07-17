// `omks web` — a local API server + Vite-built dashboard (React 19 + Vite 8).
//
// Serves JSON at /api/* and the built SPA from packages/web/dist. Runs started
// from the dashboard execute in this process and stream into the same store.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runGoal, discoverWorkflows, RunBus, subscribeRun, type Harness, type RunOutcome } from '@omakase/engine';
import { detectCached } from '@omakase/providers';
import type { Goal, RunRecord, Store, Workspace } from '@omakase/core';
import { parseArgs, flagNum, flagBool, flagStr } from '../args.ts';
import { openOrInit } from './shared.ts';
import { print, printErr, c, banner } from '../ui.ts';

const WEB_DIST = join(import.meta.dir, '..', '..', '..', 'web', 'dist');
const DEFAULT_PORT = 4517;

export interface WebContext {
  workspace: Workspace;
  store: Store;
  port?: number;
  bus?: RunBus;
  harness?: Harness;
}

/** The dashboard's launch payload — mirrors the flags `omks run` accepts. */
interface RunRequest {
  text?: string;
  workflow?: string;
  provider?: string;
  model?: string;
  checks?: string[];
  criteria?: string[];
  maxAgents?: number;
  maxUsd?: number;
  params?: Record<string, unknown>;
}

const posInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
const posNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

function hasDist(): boolean {
  return existsSync(join(WEB_DIST, 'index.html'));
}

export function startWebServer(ctx: WebContext) {
  const { workspace, store } = ctx;
  const active = new Map<string, AbortController>();
  const bus = ctx.bus ?? new RunBus();

  return Bun.serve({
    port: ctx.port ?? DEFAULT_PORT,
    idleTimeout: 120,
    async fetch(req, server) {
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
        const sessions = store.listSessions(30).map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }));
        return json({
          providers: providers.map((p) => ({ id: p.id, label: p.label, available: p.available, version: p.version, models: p.models })),
          workflows,
          runs,
          sessions,
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
        let ended = false;
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
                ended = true;
                unsub();
                try {
                  controller.close();
                } catch {
                  /* already closed */
                }
              }
            });
            // subscribeRun replays history synchronously, so an already-finished
            // run delivers `run:ended` before the real unsubscriber exists — and
            // closing the stream here means cancel() never fires either. Release
            // the listener now that it can actually be reached.
            if (ended) unsub();
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
        const body = (await req.json().catch(() => ({}))) as RunRequest;
        if (!body.text?.trim()) return json({ error: 'text required' }, 400);
        const checks = (body.checks ?? []).filter((s) => s.trim()).map((run) => ({ kind: 'command' as const, run }));
        const criteria = (body.criteria ?? []).filter((s) => s.trim());
        const goal: Goal = {
          text: body.text.trim(),
          cwd: workspace.root,
          ...(body.workflow ? { workflow: body.workflow } : {}),
          ...(body.provider ? { provider: body.provider } : {}),
          ...(body.model ? { model: body.model } : {}),
          ...(checks.length ? { checks } : {}),
          ...(criteria.length ? { successCriteria: criteria } : {}),
          ...(body.params && Object.keys(body.params).length ? { params: body.params } : {}),
        };
        // The dashboard is a trusted local surface, but a caller can still fat-finger
        // a cap — a non-positive budget has no coherent meaning, so reject it.
        const maxAgents = posInt(body.maxAgents);
        const maxUsd = posNum(body.maxUsd);
        if (body.maxAgents !== undefined && maxAgents === null) return json({ error: 'maxAgents must be a positive number' }, 400);
        if (body.maxUsd !== undefined && maxUsd === null) return json({ error: 'maxUsd must be a positive number' }, 400);
        const controller = new AbortController();
        let resolveId!: (id: string) => void;
        let rejectId!: (err: unknown) => void;
        const idP = new Promise<string>((res, rej) => {
          resolveId = res;
          rejectId = rej;
        });
        // The run id only exists once the first event is emitted, but runGoal can
        // reject before that — an unknown workflow, a workflow file that fails to
        // load, a store that won't open. Without the reject arm this endpoint
        // would await an id that never arrives. Once resolved, rejectId is a no-op.
        void runGoal({
          goal,
          workspace,
          store,
          bus,
          signal: controller.signal,
          ...(maxAgents !== null ? { maxAgents } : {}),
          ...(maxUsd !== null ? { maxUsd } : {}),
          ...(ctx.harness ? { harness: ctx.harness } : {}),
          onEvent: (e) => resolveId(e.runId),
        })
          .then((o: RunOutcome) => active.delete(o.runId))
          .catch((err: unknown) => rejectId(err));
        let runId: string;
        try {
          runId = await idP;
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
        active.set(runId, controller);
        return json({ runId });
      }

      if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);

      // --- static SPA ---
      if (!hasDist()) {
        return new Response(devNotice(server.port ?? DEFAULT_PORT), { headers: { 'content-type': 'text/html' } });
      }
      const filePath = path === '/' ? '/index.html' : path;
      const file = Bun.file(join(WEB_DIST, filePath));
      if (await file.exists()) return new Response(file);
      return new Response(Bun.file(join(WEB_DIST, 'index.html'))); // SPA fallback
    },
  });
}

export async function cmdWeb(rawArgs: string[]): Promise<number> {
  const args = parseArgs(rawArgs, { value: ['port', 'cwd'] });
  const cwd = flagStr(args, 'cwd') ?? process.cwd();
  const { workspace, store } = openOrInit(cwd);
  const server = startWebServer({ workspace, store, port: flagNum(args, 'port') ?? DEFAULT_PORT });

  const openUrl = `http://localhost:${server.port}`;
  print(banner() + '\n');
  print(`${c.green('▸')} Dashboard API on ${c.cyan(openUrl)}`);
  if (hasDist()) print(`  ${c.dim('open')} ${c.cyan(openUrl)}`);
  else {
    print(c.yellow('  SPA not built yet.') + c.dim(' Dev: ') + c.cyan('bun --filter @omakase/web dev') + c.dim(` (proxies /api → :${server.port})`));
    print(c.dim('  Prod: ') + c.cyan('bun --filter @omakase/web build') + c.dim(' then reopen this URL.'));
  }
  print(c.dim('\nPress Ctrl-C to stop.'));

  if (hasDist() && flagBool(args, 'open')) openBrowser(openUrl);

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
    sessionId: r.sessionId,
    status: r.status,
    workflow: r.workflow,
    title: r.title,
    summary: r.summary,
    spentAgents: r.spentAgents,
    spentTokens: r.spentTokens,
    spentCostUsd: r.spentCostUsd,
    createdAt: r.createdAt,
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
