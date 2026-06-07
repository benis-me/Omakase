import type { KnowledgeEvent } from './events.js';
import type { WikiEntry, WikiSnapshot } from './wiki.js';

export type WikiPageId = 'overview' | 'decisions' | 'risks' | 'verification';

export interface WikiPage {
  id: WikiPageId;
  title: string;
  body: string;
  sourceEventIds: string[];
  sourceRunIds: string[];
  authorAgentIds: string[];
  updatedAt: number;
}

const PAGE_ORDER: Array<{ id: WikiPageId; title: string }> = [
  { id: 'overview', title: 'Project Overview' },
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
  if (event.kind === 'progress' || event.kind === 'report') return 'verification';
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

function renderEventItem(event: KnowledgeEvent): string {
  return [`## ${event.title}`, event.body.trim()].filter(Boolean).join('\n\n');
}

function renderEntryItem(entry: WikiEntry): string {
  return [`## ${entry.title}`, entry.body.trim()].filter(Boolean).join('\n\n');
}

export function buildWikiPages(events: readonly KnowledgeEvent[], fallbackWiki?: WikiSnapshot | null): WikiPage[] {
  const buckets = new Map<WikiPageId, Array<{ body: string; event?: KnowledgeEvent; entry?: WikiEntry }>>();
  for (const page of PAGE_ORDER) buckets.set(page.id, []);

  for (const event of events) {
    const page = pageForEvent(event);
    if (!page) continue;
    buckets.get(page)!.push({ body: renderEventItem(event), event });
  }

  if (events.length === 0 && fallbackWiki) {
    for (const entry of fallbackWiki.entries) {
      const page = pageForEntry(entry);
      if (!page) continue;
      buckets.get(page)!.push({ body: renderEntryItem(entry), entry });
    }
  }

  const pages: WikiPage[] = [];
  for (const page of PAGE_ORDER) {
    const items = buckets.get(page.id) ?? [];
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
