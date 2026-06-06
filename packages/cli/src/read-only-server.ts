import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { ProjectWiki, type KnowledgeStore, type RunRecord, type RunStore } from '@omakase/core';

export interface ReadOnlyServerOptions {
  store: RunStore;
  knowledgeStore?: KnowledgeStore;
  host?: string;
  port?: number;
}

export interface ReadOnlyServerHandle {
  url: string;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value, null, 2), 'application/json; charset=utf-8');
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function reports(store: RunStore): Promise<NonNullable<RunRecord['reports']>> {
  const out: NonNullable<RunRecord['reports']> = [];
  for (const id of await store.list()) {
    const record = await store.load(id);
    if (record?.reports) out.push(...record.reports);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function wikiMarkdown(knowledgeStore: KnowledgeStore | undefined): Promise<string> {
  const wiki = await knowledgeStore?.loadWiki();
  return wiki ? `${ProjectWiki.fromJSON(wiki).toMarkdown()}\n` : '# Project Wiki\n';
}

async function renderHome(store: RunStore, knowledgeStore: KnowledgeStore | undefined): Promise<string> {
  const reportList = await reports(store);
  const wiki = await wikiMarkdown(knowledgeStore);
  const reportHtml =
    reportList.length === 0
      ? '<p class="empty">No reports yet.</p>'
      : reportList
          .map(
            (report) => `<article class="report">
  <header>
    <h3>${escapeHtml(report.title)}</h3>
    <span>${escapeHtml(report.kind)} · ${escapeHtml(report.runId)}</span>
  </header>
  <p>${escapeHtml(report.summary)}</p>
  <pre>${escapeHtml(report.markdown)}</pre>
</article>`,
          )
          .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <title>Omakase Reports</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 1120px; margin: 0 auto; padding: 24px; display: grid; gap: 24px; }
    header.top { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; border-bottom: 1px solid color-mix(in srgb, CanvasText 16%, transparent); padding-bottom: 14px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 22px; font-weight: 650; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 14px; }
    section { display: grid; gap: 10px; }
    .report { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 8px; padding: 14px; display: grid; gap: 10px; }
    .report header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .report span, .empty, .meta { color: color-mix(in srgb, CanvasText 58%, transparent); font-size: 12px; }
    pre { margin: 0; overflow: auto; white-space: pre-wrap; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .wiki { border-left: 3px solid color-mix(in srgb, CanvasText 18%, transparent); padding-left: 12px; }
  </style>
</head>
<body>
  <main>
    <header class="top">
      <h1>Omakase Reports</h1>
      <p class="meta">Read-only · refreshes every 5s</p>
    </header>
    <section>
      <h2>Reports</h2>
      ${reportHtml}
    </section>
    <section>
      <h2>Project Wiki</h2>
      <pre class="wiki">${escapeHtml(wiki)}</pre>
    </section>
  </main>
</body>
</html>`;
}

export async function startReadOnlyServer(options: ReadOnlyServerOptions): Promise<ReadOnlyServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, 'method not allowed', 'text/plain; charset=utf-8');
        return;
      }
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname === '/') {
        send(res, 200, await renderHome(options.store, options.knowledgeStore), 'text/html; charset=utf-8');
        return;
      }
      if (url.pathname.startsWith('/api/run/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/run/'.length));
        const record = await options.store.load(id);
        if (!record) sendJson(res, 404, { error: 'run not found' });
        else sendJson(res, 200, record);
        return;
      }
      if (url.pathname === '/api/reports') {
        sendJson(res, 200, await reports(options.store));
        return;
      }
      if (url.pathname === '/api/wiki') {
        send(res, 200, await wikiMarkdown(options.knowledgeStore), 'text/markdown; charset=utf-8');
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    })().catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('read-only server did not bind to a TCP port');
  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
