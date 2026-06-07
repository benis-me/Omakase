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
  for (const record of await records(store)) {
    if (record?.reports) out.push(...record.reports);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function records(store: RunStore): Promise<RunRecord[]> {
  const out: RunRecord[] = [];
  for (const id of await store.list()) {
    const record = await store.load(id);
    if (record) out.push(record);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function runSummaries(store: RunStore): Promise<Array<{
  id: string;
  title: string;
  status: RunRecord['status'];
  summary: string;
  updatedAt: number;
  taskTotal: number;
  taskDone: number;
  reports: number;
  knowledgeEvents: number;
}>> {
  return (await records(store)).map((record) => {
    const tasks = record.plan.tasks ?? [];
    return {
      id: record.id,
      title: record.request.prompt,
      status: record.status,
      summary: record.summary,
      updatedAt: record.updatedAt,
      taskTotal: tasks.length,
      taskDone: tasks.filter((task) => task.status === 'succeeded').length,
      reports: record.reports?.length ?? 0,
      knowledgeEvents: record.knowledgeEvents?.length ?? 0,
    };
  });
}

function eventActivityLabel(event: RunRecord['events'][number]): string {
  switch (event.type) {
    case 'report-created':
      return `report · ${event.report.title}`;
    case 'knowledge-event-created':
      return `wiki · ${event.event.title}`;
    case 'planned':
      return `plan · ${event.snapshot.tasks.length} tasks`;
    case 'task-finished':
      return `${event.role} · ${event.title}`;
    case 'agent-event':
      return `${event.role} · ${event.assignment.agentId} · ${event.event.type}`;
    case 'run-finished':
      return `run · ${event.status}`;
    default:
      return event.type;
  }
}

async function activity(store: RunStore): Promise<Array<{ runId: string; label: string; type: string }>> {
  const out: Array<{ runId: string; label: string; type: string }> = [];
  for (const record of await records(store)) {
    for (const event of record.events.slice(-40)) {
      if (event.type === 'heartbeat') continue;
      out.push({ runId: record.id, label: eventActivityLabel(event), type: event.type });
    }
  }
  return out.slice(-120).reverse();
}

async function wikiMarkdown(knowledgeStore: KnowledgeStore | undefined): Promise<string> {
  const wiki = await knowledgeStore?.loadWiki();
  return wiki ? `${ProjectWiki.fromJSON(wiki).toMarkdown()}\n` : '# Project Wiki\n';
}

async function renderHome(store: RunStore, knowledgeStore: KnowledgeStore | undefined): Promise<string> {
  const reportList = await reports(store);
  const runList = await runSummaries(store);
  const activityList = await activity(store);
  const wiki = await wikiMarkdown(knowledgeStore);
  const reportHtml =
    reportList.length === 0
      ? '<p class="empty">No reports yet.</p>'
      : reportList
          .map(
            (report) => `<article class="report">
  <header>
    <h3>${escapeHtml(report.title)}</h3>
    <span>${escapeHtml(report.kind)} · ${escapeHtml(report.runId)} · ${escapeHtml(report.authorAgentId ?? 'fallback')}</span>
  </header>
  <p>${escapeHtml(report.summary)}</p>
  <pre>${escapeHtml(report.markdown)}</pre>
</article>`,
          )
          .join('\n');
  const runsHtml =
    runList.length === 0
      ? '<p class="empty">No runs yet.</p>'
      : runList
          .map(
            (run) => `<article class="run-row">
  <div><strong>${escapeHtml(run.id)}</strong><p>${escapeHtml(run.title)}</p></div>
  <span class="status">${escapeHtml(run.status)}</span>
  <span>${run.taskDone}/${run.taskTotal}</span>
</article>`,
          )
          .join('\n');
  const activityHtml =
    activityList.length === 0
      ? '<p class="empty">No activity yet.</p>'
      : activityList
          .slice(0, 16)
          .map((item) => `<li><span>${escapeHtml(item.type)}</span>${escapeHtml(item.label)}<small>${escapeHtml(item.runId)}</small></li>`)
          .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Omakase Mission Control</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8f5;
      --ink: #141612;
      --muted: #66706a;
      --line: #dfe4d7;
      --panel: #ffffff;
      --panel-2: #f7faff;
      --accent: #2367ff;
      --green: #7fbf3f;
      --coral: #f26d5b;
      --shadow: 0 12px 32px rgba(20, 22, 18, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background:
      linear-gradient(90deg, rgba(35, 103, 255, .06) 1px, transparent 1px),
      linear-gradient(180deg, rgba(127, 191, 63, .08) 1px, transparent 1px),
      linear-gradient(135deg, #fbfcf6 0%, var(--bg) 52%, #eef4ff 100%); background-size: 36px 36px, 36px 36px, auto; color: var(--ink); }
    main { max-width: 1280px; margin: 0 auto; padding: 28px; display: grid; gap: 18px; }
    header.top { display: grid; grid-template-columns: 1.4fr auto; gap: 20px; align-items: end; padding: 22px 0 10px; border-left: 5px solid var(--accent); padding-left: 16px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 34px; line-height: 1; font-weight: 760; letter-spacing: 0; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 12px; }
    h3 { font-size: 15px; }
    .sub { max-width: 680px; margin-top: 10px; color: var(--muted); font-size: 14px; line-height: 1.55; }
    .meta { justify-self: end; color: var(--muted); font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 8px 12px; background: rgba(255,255,255,.82); }
    .grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(360px, .9fr); gap: 18px; align-items: start; }
    .stack { display: grid; gap: 18px; }
    section { background: rgba(255, 255, 255, .86); border: 1px solid rgba(110, 119, 106, .20); border-radius: 8px; padding: 18px; box-shadow: var(--shadow); backdrop-filter: blur(12px); }
    .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .metric { min-height: 92px; border-radius: 8px; padding: 14px; background: var(--panel); border: 1px solid var(--line); display: grid; align-content: space-between; border-top: 3px solid var(--accent); }
    .metric:nth-child(2) { border-top-color: var(--coral); }
    .metric:nth-child(3) { border-top-color: var(--green); }
    .metric:nth-child(4) { border-top-color: #111827; }
    .metric strong { font-size: 28px; line-height: 1; }
    .metric span { color: var(--muted); font-size: 12px; }
    .report, .run-row { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: var(--panel); display: grid; gap: 10px; }
    .report + .report, .run-row + .run-row { margin-top: 10px; }
    .report header, .run-row { display: grid; grid-template-columns: 1fr auto auto; align-items: baseline; gap: 12px; }
    .report span, .empty, .run-row p, .activity small { color: var(--muted); font-size: 12px; }
    .status { border-radius: 999px; padding: 4px 8px; background: #e9f6dc; color: #385f1b; font-size: 12px; }
    pre { margin: 0; overflow: auto; white-space: pre-wrap; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .wiki { max-height: 560px; border-radius: 8px; border: 1px solid var(--line); background: #fbfcff; padding: 14px; }
    .activity { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .activity li { display: grid; grid-template-columns: 120px 1fr auto; gap: 10px; align-items: baseline; border-bottom: 1px solid var(--line); padding: 8px 0; font-size: 13px; }
    .activity span { color: var(--accent); font-size: 12px; }
    @media (max-width: 860px) {
      main { padding: 18px; }
      header.top, .grid, .metrics { grid-template-columns: 1fr; }
      .meta { justify-self: start; }
      h1 { max-width: 16ch; font-size: 24px; line-height: 1.08; overflow-wrap: normal; }
      .sub { max-width: 32ch; }
      .report header, .run-row, .activity li { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header class="top">
      <div>
        <h1>Omakase Mission Control</h1>
        <p class="sub">Read-only live view for agent-authored reports, project wiki synthesis, and run activity.</p>
      </div>
      <p class="meta" id="last-updated">Read-only · live polling</p>
    </header>
    <section class="metrics">
      <div class="metric"><strong data-metric="runs">${runList.length}</strong><span>Runs</span></div>
      <div class="metric"><strong data-metric="reports">${reportList.length}</strong><span>Reports</span></div>
      <div class="metric"><strong data-metric="active">${runList.filter((run) => run.status === 'running' || run.status === 'waiting-for-user').length}</strong><span>Active</span></div>
      <div class="metric"><strong data-metric="wiki">${wiki.split('\n').filter((line) => line.startsWith('### ')).length}</strong><span>Wiki Entries</span></div>
    </section>
    <div class="grid">
      <div class="stack">
        <section>
          <h2>Reports</h2>
          <div data-region="reports">${reportHtml}</div>
        </section>
        <section>
          <h2>Runs</h2>
          <div data-region="runs">${runsHtml}</div>
        </section>
      </div>
      <div class="stack">
        <section>
          <h2>Activity</h2>
          <ul class="activity" data-region="activity">${activityHtml}</ul>
        </section>
        <section>
          <h2>Project Wiki</h2>
          <pre class="wiki" data-region="wiki">${escapeHtml(wiki)}</pre>
        </section>
      </div>
    </div>
  </main>
  <script>
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const reportHtml = (report) => '<article class="report"><header><h3>' + escapeHtml(report.title) + '</h3><span>' + escapeHtml(report.kind) + ' · ' + escapeHtml(report.runId) + ' · ' + escapeHtml(report.authorAgentId || 'fallback') + '</span></header><p>' + escapeHtml(report.summary) + '</p><pre>' + escapeHtml(report.markdown) + '</pre></article>';
    const runHtml = (run) => '<article class="run-row"><div><strong>' + escapeHtml(run.id) + '</strong><p>' + escapeHtml(run.title) + '</p></div><span class="status">' + escapeHtml(run.status) + '</span><span>' + run.taskDone + '/' + run.taskTotal + '</span></article>';
    const activityHtml = (item) => '<li><span>' + escapeHtml(item.type) + '</span>' + escapeHtml(item.label) + '<small>' + escapeHtml(item.runId) + '</small></li>';
    async function refreshDashboard() {
      const [reports, runs, wiki, activity] = await Promise.all([
        fetch("/api/reports").then((res) => res.json()),
        fetch("/api/runs").then((res) => res.json()),
        fetch("/api/wiki").then((res) => res.text()),
        fetch("/api/activity").then((res) => res.json()),
      ]);
      document.querySelector('[data-region="reports"]').innerHTML = reports.length ? reports.map(reportHtml).join('') : '<p class="empty">No reports yet.</p>';
      document.querySelector('[data-region="runs"]').innerHTML = runs.length ? runs.map(runHtml).join('') : '<p class="empty">No runs yet.</p>';
      document.querySelector('[data-region="wiki"]').textContent = wiki;
      document.querySelector('[data-region="activity"]').innerHTML = activity.length ? activity.slice(0, 16).map(activityHtml).join('') : '<p class="empty">No activity yet.</p>';
      document.querySelector('[data-metric="runs"]').textContent = runs.length;
      document.querySelector('[data-metric="reports"]').textContent = reports.length;
      document.querySelector('[data-metric="active"]').textContent = runs.filter((run) => run.status === 'running' || run.status === 'waiting-for-user').length;
      document.querySelector('[data-metric="wiki"]').textContent = wiki.split('\\n').filter((line) => line.startsWith('### ')).length;
      document.querySelector('#last-updated').textContent = 'Read-only · updated ' + new Date().toLocaleTimeString();
    }
    setInterval(refreshDashboard, 2000);
    void refreshDashboard();
  </script>
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
      if (url.pathname === '/api/runs') {
        sendJson(res, 200, await runSummaries(options.store));
        return;
      }
      if (url.pathname === '/api/activity') {
        sendJson(res, 200, await activity(options.store));
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
