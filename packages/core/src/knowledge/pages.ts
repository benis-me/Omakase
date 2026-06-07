import type { KnowledgeEvent } from './events.js';
import type { WikiEntry, WikiSnapshot } from './wiki.js';
import { CodeGraph, type CodeGraphSnapshot } from './codegraph.js';

export type WikiPageId = 'overview' | 'codegraph' | 'decisions' | 'risks' | 'verification';
export type WikiPageSourceKind = 'agent' | 'wiki' | 'codegraph';

export interface WikiPage {
  id: WikiPageId;
  title: string;
  body: string;
  sourceKind?: WikiPageSourceKind;
  sourceEventIds: string[];
  sourceRunIds: string[];
  authorAgentIds: string[];
  updatedAt: number;
}

interface WikiPageItem {
  title: string;
  body: string;
  updatedAt: number;
  event?: KnowledgeEvent;
  entry?: WikiEntry;
}

const PAGE_ORDER: Array<{ id: WikiPageId; title: string }> = [
  { id: 'overview', title: 'Project Overview' },
  { id: 'codegraph', title: 'Project Structure' },
  { id: 'decisions', title: 'Architecture Decisions' },
  { id: 'risks', title: 'Risks And Open Questions' },
  { id: 'verification', title: 'Verification Handles' },
];

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function pageForEvent(event: KnowledgeEvent): WikiPageId | null {
  if (!event.authorAgentId) return null;
  if (event.kind === 'synthesis' || event.kind === 'fact') return 'overview';
  if (event.kind === 'decision') return 'decisions';
  if (event.kind === 'risk') return 'risks';
  if (event.kind === 'progress') return 'verification';
  return null;
}

function pageForEntry(entry: WikiEntry): WikiPageId | null {
  if (!entry.tags.includes('knowledge') && !entry.source?.startsWith('knowledge:')) return null;
  if (entry.kind === 'fact') return 'overview';
  if (entry.kind === 'decision') return 'decisions';
  if (entry.kind === 'risk') return 'risks';
  if (entry.kind === 'note') return 'verification';
  return null;
}

function normalizeKnowledgeTitle(title: string): string {
  return title
    .replace(/^wiki\s+synthesis\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Project knowledge';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sameTitle(a: string, b: string): boolean {
  return normalizeKnowledgeTitle(a).toLowerCase() === normalizeKnowledgeTitle(b).toLowerCase();
}

function firstSectionMarker(value: string): { index: number; bodyStart: number; title: string } | null {
  const atx = /(?:^|\n)#{1,3}\s+([^\n]+)/.exec(value);
  const bold = /\*\*([^*\n]{1,100})\*\*/.exec(value);
  const candidates: Array<{ index: number; bodyStart: number; title: string }> = [];
  if (atx) {
    const index = atx.index + (value[atx.index] === '\n' ? 1 : 0);
    candidates.push({ index, bodyStart: index, title: atx[1]!.trim() });
  }
  if (bold) {
    candidates.push({ index: bold.index, bodyStart: bold.index, title: bold[1]!.trim() });
  }
  return candidates.sort((a, b) => a.index - b.index)[0] ?? null;
}

function stripProcessPreamble(body: string): string {
  const trimmed = body.trim();
  const marker = firstSectionMarker(trimmed);
  if (!marker || marker.index === 0) return trimmed;
  const prefix = trimmed.slice(0, marker.index).toLowerCase();
  if (/\bi['’]?ll\b|\bi will\b|\bi['’]?m\b|\bi am\b|using the|the relevant|i have enough context/.test(prefix)) {
    return trimmed.slice(marker.bodyStart).trim();
  }
  return trimmed;
}

function renderKnowledgeItem(title: string, body: string): string {
  const cleanBody = stripProcessPreamble(body);
  if (!cleanBody) return `## ${title}`;
  const hasMatchingHeading = new RegExp(`^#{1,3}\\s+${escapeRegExp(title)}(?:\\s|$)`, 'i').test(cleanBody);
  if (hasMatchingHeading) return cleanBody;
  const leadingBold = /^\*\*([^*\n]{1,100})\*\*\s*/.exec(cleanBody);
  if (leadingBold && sameTitle(leadingBold[1]!, title)) {
    const rest = cleanBody.slice(leadingBold[0].length).trim();
    return [`## ${title}`, rest].filter(Boolean).join('\n\n');
  }
  return [`## ${title}`, cleanBody].join('\n\n');
}

function eventItem(event: KnowledgeEvent): WikiPageItem {
  const cleanBody = stripProcessPreamble(event.body);
  const bodyTitle = firstSectionMarker(cleanBody)?.title;
  const title = /^wiki\s+synthesis\b/i.test(event.title) && bodyTitle ? normalizeKnowledgeTitle(bodyTitle) : normalizeKnowledgeTitle(event.title);
  return {
    title,
    body: renderKnowledgeItem(title, cleanBody),
    updatedAt: event.createdAt,
    event,
  };
}

function entryItem(entry: WikiEntry): WikiPageItem {
  const title = normalizeKnowledgeTitle(entry.title);
  return {
    title,
    body: renderKnowledgeItem(title, entry.body),
    updatedAt: entry.updatedAt,
    entry,
  };
}

function latestByTitle(items: readonly WikiPageItem[]): WikiPageItem[] {
  const byTitle = new Map<string, WikiPageItem>();
  for (const item of items) {
    const key = item.title.toLowerCase();
    const current = byTitle.get(key);
    if (!current || item.updatedAt > current.updatedAt || (item.updatedAt === current.updatedAt && item.body > current.body)) {
      byTitle.set(key, item);
    }
  }
  return [...byTitle.values()].sort((a, b) => a.updatedAt - b.updatedAt || a.title.localeCompare(b.title));
}

function renderCodegraphPage(snapshot: CodeGraphSnapshot): string {
  const summary = CodeGraph.fromJSON(snapshot).summary();
  const lines = [
    '## Snapshot',
    `Files: ${summary.stats.files}`,
    `Internal edges: ${summary.stats.internalEdges}`,
    `External edges: ${summary.stats.externalEdges}`,
    `Symbols: ${summary.stats.symbols}`,
    `Cycles: ${summary.stats.cycles}`,
    '',
    '## Dependency hubs',
  ];
  if (summary.dependencyHubs.length === 0) lines.push('- None detected');
  else {
    for (const hub of summary.dependencyHubs) {
      lines.push(`- ${hub.path}: ${hub.dependents} dependents, ${hub.dependencies} dependencies, ${hub.symbols} symbols, ${hub.loc} loc`);
    }
  }
  lines.push('', '## Entrypoints');
  if (summary.entrypoints.length === 0) lines.push('- None detected');
  else {
    for (const entrypoint of summary.entrypoints) {
      lines.push(`- ${entrypoint.path}: ${entrypoint.dependencies} dependencies, ${entrypoint.symbols} symbols, ${entrypoint.loc} loc`);
    }
  }
  lines.push('', '## Public APIs');
  if (summary.publicApis.length === 0) lines.push('- None detected');
  else {
    for (const api of summary.publicApis) {
      lines.push(`- ${api.path}: ${api.exports.join(', ')}`);
    }
  }
  lines.push('', '## External dependencies');
  if (summary.externalDependencies.length === 0) lines.push('- None detected');
  else {
    for (const dependency of summary.externalDependencies) lines.push(`- ${dependency.specifier} (${dependency.count})`);
  }
  lines.push('', '## Cycles');
  if (summary.cycles.length === 0) lines.push('- None detected');
  else {
    for (const cycle of summary.cycles) lines.push(`- ${cycle.join(' -> ')}`);
  }
  return lines.join('\n');
}

export function buildWikiPages(
  events: readonly KnowledgeEvent[],
  fallbackWiki?: WikiSnapshot | null,
  codegraph?: CodeGraphSnapshot | null,
): WikiPage[] {
  const buckets = new Map<WikiPageId, WikiPageItem[]>();
  for (const page of PAGE_ORDER) buckets.set(page.id, []);

  for (const event of events) {
    const page = pageForEvent(event);
    if (!page) continue;
    buckets.get(page)!.push(eventItem(event));
  }

  if (events.length === 0 && fallbackWiki) {
    for (const entry of fallbackWiki.entries) {
      const page = pageForEntry(entry);
      if (!page) continue;
      buckets.get(page)!.push(entryItem(entry));
    }
  }

  const pages: WikiPage[] = [];
  for (const page of PAGE_ORDER) {
    if (page.id === 'codegraph' && codegraph) {
      pages.push({
        id: 'codegraph',
        title: page.title,
        body: renderCodegraphPage(codegraph),
        sourceKind: 'codegraph',
        sourceEventIds: [],
        sourceRunIds: [],
        authorAgentIds: [],
        updatedAt: 0,
      });
      continue;
    }
    const items = latestByTitle(buckets.get(page.id) ?? []);
    if (items.length === 0) continue;
    const sourceEventIds = unique(
      items.flatMap((item) => (item.event ? [item.event.id] : item.entry?.source?.startsWith('knowledge:') ? [item.entry.id] : [])),
    );
    const sourceRunIds = unique(items.flatMap((item) => (item.event ? [item.event.runId] : item.entry?.tags.filter((tag) => tag.startsWith('run:')).map((tag) => tag.slice(4)) ?? [])));
    const authorAgentIds = unique(
      items.flatMap((item) =>
        item.event?.authorAgentId
          ? [item.event.authorAgentId]
          : item.entry?.tags.filter((tag) => tag.startsWith('agent:')).map((tag) => tag.slice(6)) ?? [],
      ),
    );
    const updatedAt = Math.max(...items.map((item) => item.event?.createdAt ?? item.entry?.updatedAt ?? 0));
    pages.push({
      id: page.id,
      title: page.title,
      body: items.map((item) => item.body).join('\n\n'),
      sourceKind: items.some((item) => item.event) ? 'agent' : 'wiki',
      sourceEventIds,
      sourceRunIds,
      authorAgentIds,
      updatedAt,
    });
  }
  return pages;
}

function sanitizeHeading(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function renderWikiPagesMarkdown(pages: readonly WikiPage[]): string {
  if (pages.length === 0) return '# Project Knowledge Base\n';
  const out = ['# Project Knowledge Base', ''];
  for (const page of pages) {
    out.push(`## ${sanitizeHeading(page.title)}`, '', page.body.trim());
    const meta = [
      page.sourceEventIds.length > 0 ? `source events: ${page.sourceEventIds.join(', ')}` : '',
      page.sourceRunIds.length > 0 ? `runs: ${page.sourceRunIds.join(', ')}` : '',
      page.authorAgentIds.length > 0 ? `agents: ${page.authorAgentIds.join(', ')}` : '',
    ].filter(Boolean);
    if (meta.length > 0) out.push('', `_${meta.join('; ')}_`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}
