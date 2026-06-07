import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import {
  CodeGraph,
  ProjectWiki,
  renderWikiPagesMarkdown,
  type KnowledgeStore,
  type RunRecord,
  type RunStore,
  type WikiPage,
} from '@omakase/core';

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

async function acceptanceSummaries(store: RunStore): Promise<Array<{
  runId: string;
  title: string;
  progress: NonNullable<RunRecord['acceptance']>['progress'];
  criteria: NonNullable<RunRecord['acceptance']>['criteria'];
}>> {
  return (await records(store)).flatMap((record) =>
    record.acceptance
      ? [
          {
            runId: record.id,
            title: record.request.prompt,
            progress: record.acceptance.progress,
            criteria: record.acceptance.criteria,
          },
        ]
      : [],
  );
}

async function iterationSummaries(store: RunStore): Promise<Array<{
  runId: string;
  iteration: NonNullable<RunRecord['iterations']>[number];
}>> {
  const out: Array<{ runId: string; iteration: NonNullable<RunRecord['iterations']>[number] }> = [];
  for (const record of await records(store)) {
    for (const iteration of record.iterations ?? []) out.push({ runId: record.id, iteration });
  }
  return out.reverse();
}

async function agentSummaries(store: RunStore): Promise<Array<{
  runId: string;
  taskId: string | null;
  title: string;
  role: string;
  status: string;
  agentId: string | null;
  tokens: number;
  tools: number;
}>> {
  const out: Array<{
    runId: string;
    taskId: string | null;
    title: string;
    role: string;
    status: string;
    agentId: string | null;
    tokens: number;
    tools: number;
  }> = [];
  for (const record of await records(store)) {
    const stats = new Map<string, { agentId: string | null; tokens: number; tools: number }>();
    for (const event of record.events) {
      if (event.type !== 'agent-event') continue;
      const key = event.taskId ?? `support:${event.role}:${event.assignment.agentId}`;
      const prev = stats.get(key) ?? { agentId: event.assignment.agentId, tokens: 0, tools: 0 };
      if (event.event.type === 'usage') {
        prev.tokens += event.event.usage.totalTokens ?? (event.event.usage.inputTokens ?? 0) + (event.event.usage.outputTokens ?? 0);
      }
      if (event.event.type === 'tool_use') prev.tools += 1;
      prev.agentId = event.assignment.agentId;
      stats.set(key, prev);
    }
    for (const task of record.plan.tasks ?? []) {
      const stat = stats.get(task.id);
      out.push({
        runId: record.id,
        taskId: task.id,
        title: task.title,
        role: task.role,
        status: task.status,
        agentId: stat?.agentId ?? task.result?.agentId ?? null,
        tokens: stat?.tokens ?? 0,
        tools: stat?.tools ?? 0,
      });
    }
    for (const [key, stat] of stats) {
      if (!key.startsWith('support:')) continue;
      const [, role, agentId] = key.split(':');
      out.push({
        runId: record.id,
        taskId: null,
        title: role ?? 'support',
        role: role ?? 'support',
        status: 'support',
        agentId: agentId ?? stat.agentId,
        tokens: stat.tokens,
        tools: stat.tools,
      });
    }
  }
  return out.slice(0, 120);
}

async function codegraphSummary(knowledgeStore: KnowledgeStore | undefined): Promise<(ReturnType<CodeGraph['stats']> & { root: string }) | null> {
  const snapshot = await knowledgeStore?.loadCodegraph();
  if (!snapshot) return null;
  return { root: snapshot.root, ...CodeGraph.fromJSON(snapshot).stats() };
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
    case 'agent-assigned':
      return `assigned · ${event.role}/${event.assignment.agentId}`;
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

async function rawEvents(store: RunStore): Promise<Array<{ runId: string; label: string; type: string }>> {
  const out: Array<{ runId: string; label: string; type: string }> = [];
  for (const record of await records(store)) {
    for (const event of record.events.slice(-80)) {
      out.push({ runId: record.id, label: eventActivityLabel(event), type: event.type });
    }
  }
  return out.slice(-160).reverse();
}

async function wikiPages(knowledgeStore: KnowledgeStore | undefined): Promise<WikiPage[]> {
  if (!knowledgeStore) return [];
  const pages = await knowledgeStore.loadWikiPages();
  if (pages.length > 0) return pages;
  const wiki = await knowledgeStore?.loadWiki();
  if (!wiki) return [];
  const body = ProjectWiki.fromJSON(wiki).toMarkdown();
  if (!body.trim()) return [];
  const updatedAt = Math.max(0, ...wiki.entries.map((entry) => entry.updatedAt));
  return [
    {
      id: 'overview',
      title: 'Project Wiki',
      body,
      sourceEventIds: [],
      sourceRunIds: [],
      authorAgentIds: [],
      updatedAt,
    },
  ];
}

async function wikiMarkdown(knowledgeStore: KnowledgeStore | undefined): Promise<string> {
  const pages = await wikiPages(knowledgeStore);
  return pages.length > 0 ? `${renderWikiPagesMarkdown(pages)}\n` : '# Project Knowledge Base\n';
}

async function renderHome(store: RunStore, knowledgeStore: KnowledgeStore | undefined): Promise<string> {
  const reportList = await reports(store);
  const runList = await runSummaries(store);
  const activityList = await activity(store);
  const acceptanceList = await acceptanceSummaries(store);
  const iterationList = await iterationSummaries(store);
  const agentList = await agentSummaries(store);
  const codegraph = await codegraphSummary(knowledgeStore);
  const eventList = await rawEvents(store);
  const wiki = await wikiMarkdown(knowledgeStore);
  const pageList = await wikiPages(knowledgeStore);
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
  const acceptanceHtml =
    acceptanceList.length === 0
      ? '<p class="empty">No acceptance criteria yet.</p>'
      : acceptanceList
          .map(
            (item) => `<article class="compact-row">
  <strong>${escapeHtml(item.runId)}</strong>
  <span>${item.progress.passed}/${item.progress.total}</span>
  <p>${escapeHtml(item.criteria.map((criterion) => `${criterion.status}: ${criterion.title}`).join(' · '))}</p>
</article>`,
          )
          .join('\n');
  const iterationsHtml =
    iterationList.length === 0
      ? '<p class="empty">No iterations yet.</p>'
      : iterationList
          .slice(0, 12)
          .map(
            (item) => `<article class="compact-row">
  <strong>${escapeHtml(item.runId)}</strong>
  <span>#${item.iteration.index} · ${escapeHtml(item.iteration.status)}</span>
  <p>${escapeHtml(item.iteration.reason)}${item.iteration.nextStrategy ? ` → ${escapeHtml(item.iteration.nextStrategy)}` : ''}</p>
</article>`,
          )
          .join('\n');
  const agentsHtml =
    agentList.length === 0
      ? '<p class="empty">No agents yet.</p>'
      : agentList
          .slice(0, 16)
          .map(
            (agent) => `<article class="compact-row">
  <strong>${escapeHtml(agent.agentId ?? 'unassigned')}</strong>
  <span>${escapeHtml(agent.role)} · ${escapeHtml(agent.status)}</span>
  <p>${escapeHtml(agent.title)} · ${agent.tokens} tok · ${agent.tools} tools</p>
</article>`,
          )
          .join('\n');
  const codegraphHtml = codegraph
    ? `<article class="compact-row">
  <strong>${codegraph.files} files</strong>
  <span>${codegraph.internalEdges}/${codegraph.externalEdges} edges</span>
  <p>${codegraph.symbols} symbols · ${codegraph.cycles} cycles · ${escapeHtml(codegraph.root)}</p>
</article>`
    : '<p class="empty">No codegraph yet.</p>';
  const eventsHtml =
    eventList.length === 0
      ? '<p class="empty">No raw events yet.</p>'
      : eventList
          .slice(0, 20)
          .map((item) => `<li><span>${escapeHtml(item.type)}</span>${escapeHtml(item.label)}<small>${escapeHtml(item.runId)}</small></li>`)
          .join('\n');
  const wikiPagesHtml =
    pageList.length === 0
      ? '<p class="empty">No wiki pages yet.</p>'
      : pageList
          .map(
            (page) => `<article class="wiki-page">
  <header>
    <h3>${escapeHtml(page.title)}</h3>
    <span>${escapeHtml(page.authorAgentIds.length > 0 ? page.authorAgentIds.join(', ') : 'derived')}</span>
  </header>
  <pre>${escapeHtml(page.body)}</pre>
  <p>${escapeHtml(page.sourceEventIds.length > 0 ? `source events: ${page.sourceEventIds.join(', ')}` : 'source: wiki entries')}</p>
</article>`,
          )
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
    .report, .run-row, .compact-row, .wiki-page { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: var(--panel); display: grid; gap: 10px; }
    .report + .report, .run-row + .run-row, .compact-row + .compact-row, .wiki-page + .wiki-page { margin-top: 10px; }
    .report header, .wiki-page header, .run-row { display: grid; grid-template-columns: 1fr auto auto; align-items: baseline; gap: 12px; }
    .compact-row { grid-template-columns: minmax(110px, .7fr) minmax(88px, auto) minmax(0, 1.7fr); align-items: baseline; }
    .compact-row p { color: var(--muted); font-size: 12px; }
    .compact-row span { color: var(--accent); font-size: 12px; }
    .report span, .wiki-page span, .wiki-page p, .empty, .run-row p, .activity small { color: var(--muted); font-size: 12px; }
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
      .report header, .run-row, .compact-row, .activity li { grid-template-columns: 1fr; }
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
      <div class="metric"><strong data-metric="wiki">${pageList.length}</strong><span>Wiki Pages</span></div>
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
        <section>
          <h2>Acceptance</h2>
          <div data-region="acceptance">${acceptanceHtml}</div>
        </section>
        <section>
          <h2>Agents</h2>
          <div data-region="agents">${agentsHtml}</div>
        </section>
      </div>
      <div class="stack">
        <section>
          <h2>Activity</h2>
          <ul class="activity" data-region="activity">${activityHtml}</ul>
        </section>
        <section>
          <h2>Iterations</h2>
          <div data-region="iterations">${iterationsHtml}</div>
        </section>
        <section>
          <h2>Codegraph</h2>
          <div data-region="codegraph">${codegraphHtml}</div>
        </section>
        <section>
          <h2>Project Knowledge</h2>
          <div data-region="wiki-pages">${wikiPagesHtml}</div>
        </section>
        <section>
          <h2>Wiki Markdown</h2>
          <pre class="wiki" data-region="wiki">${escapeHtml(wiki)}</pre>
        </section>
        <section>
          <h2>Raw Events</h2>
          <ul class="activity" data-region="events">${eventsHtml}</ul>
        </section>
      </div>
    </div>
  </main>
  <script>
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const reportHtml = (report) => '<article class="report"><header><h3>' + escapeHtml(report.title) + '</h3><span>' + escapeHtml(report.kind) + ' · ' + escapeHtml(report.runId) + ' · ' + escapeHtml(report.authorAgentId || 'fallback') + '</span></header><p>' + escapeHtml(report.summary) + '</p><pre>' + escapeHtml(report.markdown) + '</pre></article>';
    const runHtml = (run) => '<article class="run-row"><div><strong>' + escapeHtml(run.id) + '</strong><p>' + escapeHtml(run.title) + '</p></div><span class="status">' + escapeHtml(run.status) + '</span><span>' + run.taskDone + '/' + run.taskTotal + '</span></article>';
    const activityHtml = (item) => '<li><span>' + escapeHtml(item.type) + '</span>' + escapeHtml(item.label) + '<small>' + escapeHtml(item.runId) + '</small></li>';
    const acceptanceHtml = (item) => '<article class="compact-row"><strong>' + escapeHtml(item.runId) + '</strong><span>' + item.progress.passed + '/' + item.progress.total + '</span><p>' + escapeHtml(item.criteria.map((criterion) => criterion.status + ': ' + criterion.title).join(' · ')) + '</p></article>';
    const iterationHtml = (item) => '<article class="compact-row"><strong>' + escapeHtml(item.runId) + '</strong><span>#' + item.iteration.index + ' · ' + escapeHtml(item.iteration.status) + '</span><p>' + escapeHtml(item.iteration.reason + (item.iteration.nextStrategy ? ' → ' + item.iteration.nextStrategy : '')) + '</p></article>';
    const agentHtml = (agent) => '<article class="compact-row"><strong>' + escapeHtml(agent.agentId || 'unassigned') + '</strong><span>' + escapeHtml(agent.role) + ' · ' + escapeHtml(agent.status) + '</span><p>' + escapeHtml(agent.title) + ' · ' + agent.tokens + ' tok · ' + agent.tools + ' tools</p></article>';
    const codegraphHtml = (codegraph) => codegraph ? '<article class="compact-row"><strong>' + codegraph.files + ' files</strong><span>' + codegraph.internalEdges + '/' + codegraph.externalEdges + ' edges</span><p>' + codegraph.symbols + ' symbols · ' + codegraph.cycles + ' cycles · ' + escapeHtml(codegraph.root) + '</p></article>' : '<p class="empty">No codegraph yet.</p>';
    const wikiPageHtml = (page) => '<article class="wiki-page"><header><h3>' + escapeHtml(page.title) + '</h3><span>' + escapeHtml(page.authorAgentIds && page.authorAgentIds.length ? page.authorAgentIds.join(', ') : 'derived') + '</span></header><pre>' + escapeHtml(page.body) + '</pre><p>' + escapeHtml(page.sourceEventIds && page.sourceEventIds.length ? 'source events: ' + page.sourceEventIds.join(', ') : 'source: wiki entries') + '</p></article>';
    async function refreshDashboard() {
      const [reports, runs, wiki, wikiPages, activity, acceptance, iterations, agents, codegraph, events] = await Promise.all([
        fetch("/api/reports").then((res) => res.json()),
        fetch("/api/runs").then((res) => res.json()),
        fetch("/api/wiki").then((res) => res.text()),
        fetch("/api/wiki/pages").then((res) => res.json()),
        fetch("/api/activity").then((res) => res.json()),
        fetch("/api/acceptance").then((res) => res.json()),
        fetch("/api/iterations").then((res) => res.json()),
        fetch("/api/agents").then((res) => res.json()),
        fetch("/api/codegraph").then((res) => res.json()),
        fetch("/api/events").then((res) => res.json()),
      ]);
      document.querySelector('[data-region="reports"]').innerHTML = reports.length ? reports.map(reportHtml).join('') : '<p class="empty">No reports yet.</p>';
      document.querySelector('[data-region="runs"]').innerHTML = runs.length ? runs.map(runHtml).join('') : '<p class="empty">No runs yet.</p>';
      document.querySelector('[data-region="wiki"]').textContent = wiki;
      document.querySelector('[data-region="wiki-pages"]').innerHTML = wikiPages.length ? wikiPages.map(wikiPageHtml).join('') : '<p class="empty">No wiki pages yet.</p>';
      document.querySelector('[data-region="activity"]').innerHTML = activity.length ? activity.slice(0, 16).map(activityHtml).join('') : '<p class="empty">No activity yet.</p>';
      document.querySelector('[data-region="acceptance"]').innerHTML = acceptance.length ? acceptance.map(acceptanceHtml).join('') : '<p class="empty">No acceptance criteria yet.</p>';
      document.querySelector('[data-region="iterations"]').innerHTML = iterations.length ? iterations.slice(0, 12).map(iterationHtml).join('') : '<p class="empty">No iterations yet.</p>';
      document.querySelector('[data-region="agents"]').innerHTML = agents.length ? agents.slice(0, 16).map(agentHtml).join('') : '<p class="empty">No agents yet.</p>';
      document.querySelector('[data-region="codegraph"]').innerHTML = codegraphHtml(codegraph);
      document.querySelector('[data-region="events"]').innerHTML = events.length ? events.slice(0, 20).map(activityHtml).join('') : '<p class="empty">No raw events yet.</p>';
      document.querySelector('[data-metric="runs"]').textContent = runs.length;
      document.querySelector('[data-metric="reports"]').textContent = reports.length;
      document.querySelector('[data-metric="active"]').textContent = runs.filter((run) => run.status === 'running' || run.status === 'waiting-for-user').length;
      document.querySelector('[data-metric="wiki"]').textContent = wikiPages.length;
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
      if (url.pathname === '/api/acceptance') {
        sendJson(res, 200, await acceptanceSummaries(options.store));
        return;
      }
      if (url.pathname === '/api/iterations') {
        sendJson(res, 200, await iterationSummaries(options.store));
        return;
      }
      if (url.pathname === '/api/agents') {
        sendJson(res, 200, await agentSummaries(options.store));
        return;
      }
      if (url.pathname === '/api/codegraph') {
        sendJson(res, 200, await codegraphSummary(options.knowledgeStore));
        return;
      }
      if (url.pathname === '/api/events') {
        sendJson(res, 200, await rawEvents(options.store));
        return;
      }
      if (url.pathname === '/api/wiki/pages') {
        sendJson(res, 200, await wikiPages(options.knowledgeStore));
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
