/**
 * The project wiki: a living store of facts, decisions, risks, task statuses,
 * and notes. The orchestrator feeds it task results and agent summaries; it
 * serializes to JSON for persistence and renders to Markdown for prompt
 * injection or human reading. Updates are incremental (task entries are
 * upserted by run-scoped task id).
 */
import { createIdGenerator, type IdGenerator } from '../ids.js';

export type WikiEntryKind = 'fact' | 'decision' | 'risk' | 'task' | 'note';

export interface WikiEntry {
  id: string;
  kind: WikiEntryKind;
  title: string;
  body: string;
  tags: string[];
  source?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WikiSnapshot {
  entries: WikiEntry[];
}

export interface WikiInput {
  title: string;
  body?: string;
  tags?: string[];
  source?: string;
}

export interface TaskWikiMetadata {
  runId?: string;
  role?: string;
  agentId?: string | null;
  tokens?: number;
  toolCount?: number;
}

export interface ProjectWikiOptions {
  idGenerator?: IdGenerator;
  clock?: () => number;
}

/** A heading title must be one line — collapse any newlines. */
function sanitizeTitle(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

/** Clip an entry body to a budget on a word boundary, so one verbose entry (e.g. a
 *  curator that narrates its process) can't dominate an injected prompt. */
function clipBody(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max).replace(/\s+\S*$/, '')} …`;
}

/**
 * Neutralize body lines that would otherwise spoof a markdown heading (or our
 * own `## Section` / `### title` structure) when the wiki — which can hold
 * untrusted agent output — is rendered into a prompt. Escaping the leading
 * marker keeps the text readable while preventing section injection.
 */
function sanitizeBody(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/^(\s*)(#{1,6})(\s)/, '$1\\$2$3'))
    .join('\n');
}

export class ProjectWiki {
  private readonly entries = new Map<string, WikiEntry>();
  private readonly order: string[] = [];
  private readonly taskIndex = new Map<string, string>();
  private readonly ids: IdGenerator;
  private readonly clock: () => number;

  constructor(options: ProjectWikiOptions = {}) {
    this.ids = options.idGenerator ?? createIdGenerator();
    this.clock = options.clock ?? (() => Date.now());
  }

  add(kind: WikiEntryKind, input: WikiInput): WikiEntry {
    const now = this.clock();
    const entry: WikiEntry = {
      id: this.ids.next('wiki'),
      kind,
      title: input.title,
      body: input.body ?? '',
      tags: [...(input.tags ?? [])],
      ...(input.source ? { source: input.source } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(entry.id, entry);
    this.order.push(entry.id);
    return entry;
  }

  addFact(input: WikiInput): WikiEntry {
    return this.add('fact', input);
  }
  addDecision(input: WikiInput): WikiEntry {
    return this.add('decision', input);
  }
  addRisk(input: WikiInput): WikiEntry {
    return this.add('risk', input);
  }
  addNote(input: WikiInput): WikiEntry {
    return this.add('note', input);
  }

  update(id: string, patch: Partial<Omit<WikiEntry, 'id' | 'createdAt'>>): WikiEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown wiki entry: ${id}`);
    Object.assign(entry, patch, { updatedAt: this.clock() });
    return entry;
  }

  remove(id: string): boolean {
    const idx = this.order.indexOf(id);
    if (idx !== -1) this.order.splice(idx, 1);
    for (const [taskId, entryId] of this.taskIndex) {
      if (entryId === id) this.taskIndex.delete(taskId);
    }
    return this.entries.delete(id);
  }

  get(id: string): WikiEntry | undefined {
    return this.entries.get(id);
  }

  list(kind?: WikiEntryKind): WikiEntry[] {
    const all = this.order.map((id) => this.entries.get(id)!).filter(Boolean);
    return kind ? all.filter((e) => e.kind === kind) : all;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Upsert a task-status entry keyed by run id + task id, falling back to task id for legacy callers. */
  recordTask(
    taskId: string,
    title: string,
    status: string,
    summary = '',
    metadata: TaskWikiMetadata = {},
  ): WikiEntry {
    const taskKey = metadata.runId ? `${metadata.runId}:${taskId}` : taskId;
    const source = metadata.runId ? `task:${metadata.runId}:${taskId}` : `task:${taskId}`;
    const tags = ['task', status, ...(metadata.runId ? [`run:${metadata.runId}`] : [])];
    const existingId = this.taskIndex.get(taskKey);
    const lines = [`Status: ${status}`];
    if (metadata.runId) lines.push(`Run: ${metadata.runId}`);
    if (metadata.role) lines.push(`Role: ${metadata.role}`);
    if (metadata.agentId) lines.push(`Agent: ${metadata.agentId}`);
    if (metadata.tokens != null) lines.push(`Tokens: ${metadata.tokens}`);
    if (metadata.toolCount != null) lines.push(`Tools: ${metadata.toolCount}`);
    if (summary) lines.push('', summary);
    const body = lines.join('\n');
    if (existingId && this.entries.has(existingId)) {
      return this.update(existingId, { title, body, tags, source });
    }
    const entry = this.add('task', {
      title,
      body,
      tags,
      source,
    });
    this.taskIndex.set(taskKey, entry.id);
    return entry;
  }

  /** Record an agent summary as a note. */
  ingestSummary(text: string, source?: string): WikiEntry {
    const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? 'Summary';
    return this.add('note', {
      title: firstLine.slice(0, 80),
      body: text.trim(),
      tags: ['summary'],
      ...(source ? { source } : {}),
    });
  }

  toMarkdown(): string {
    const sections: Array<{ kind: WikiEntryKind; heading: string }> = [
      { kind: 'fact', heading: 'Facts' },
      { kind: 'decision', heading: 'Decisions' },
      { kind: 'task', heading: 'Tasks' },
      { kind: 'risk', heading: 'Risks' },
      { kind: 'note', heading: 'Notes' },
    ];
    const out: string[] = ['# Project Wiki', ''];
    for (const section of sections) {
      const entries = this.list(section.kind);
      if (entries.length === 0) continue;
      out.push(`## ${section.heading}`, '');
      for (const entry of entries) {
        out.push(`### ${sanitizeTitle(entry.title)}`);
        if (entry.body) out.push(sanitizeBody(entry.body));
        if (entry.tags.length > 0) out.push(`_tags: ${entry.tags.join(', ')}_`);
        out.push('');
      }
    }
    return out.join('\n').trim();
  }

  /**
   * Markdown for PROMPT INJECTION — a bounded view, distinct from {@link toMarkdown}
   * (which backs the full on-disk wiki and human reading). As knowledge accumulates
   * across runs the full wiki would otherwise bloat every agent call, so here we take
   * the most-recent entries up to a char budget and clip each body. Grouped by kind
   * for readability; a footer notes how many older entries were left on disk.
   */
  toPromptMarkdown(maxChars = 3500, perEntryChars = 400): string {
    const sections: Array<{ kind: WikiEntryKind; heading: string }> = [
      { kind: 'fact', heading: 'Facts' },
      { kind: 'decision', heading: 'Decisions' },
      { kind: 'task', heading: 'Tasks' },
      { kind: 'risk', heading: 'Risks' },
      { kind: 'note', heading: 'Notes' },
    ];
    // Newest first, accept entries until the budget is spent (always keep ≥1 so a
    // single oversized entry still contributes, just clipped).
    const recent = [...this.list()].sort((a, b) => b.createdAt - a.createdAt);
    const chosen = new Set<string>();
    let used = 0;
    for (const e of recent) {
      const cost = sanitizeTitle(e.title).length + Math.min(e.body.length, perEntryChars) + 16;
      if (used + cost > maxChars && chosen.size > 0) break;
      chosen.add(e.id);
      used += cost;
    }
    const omitted = recent.length - chosen.size;
    const out: string[] = ['# Project Wiki', ''];
    for (const section of sections) {
      const entries = this.list(section.kind).filter((e) => chosen.has(e.id));
      if (entries.length === 0) continue;
      out.push(`## ${section.heading}`, '');
      for (const entry of entries) {
        out.push(`### ${sanitizeTitle(entry.title)}`);
        if (entry.body) out.push(clipBody(sanitizeBody(entry.body), perEntryChars));
        if (entry.tags.length > 0) out.push(`_tags: ${entry.tags.join(', ')}_`);
        out.push('');
      }
    }
    if (omitted > 0) {
      out.push(`_(${omitted} older wiki ${omitted === 1 ? 'entry' : 'entries'} omitted here; full wiki is on disk.)_`);
    }
    return out.join('\n').trim();
  }

  /**
   * A compact INDEX for prompts — entry titles only (recent-first, capped), grouped
   * by kind. Paired with a pointer to the on-disk wiki, this lets an agent see WHAT
   * durable knowledge exists and pull the full content on demand with its file tools,
   * instead of every body being pushed into every call (which bloats as runs pile up).
   */
  toIndexMarkdown(maxEntries = 40): string {
    const recent = [...this.list()].sort((a, b) => b.createdAt - a.createdAt).slice(0, maxEntries);
    if (recent.length === 0) return '';
    const order: Array<{ kind: WikiEntryKind; heading: string }> = [
      { kind: 'fact', heading: 'Facts' },
      { kind: 'decision', heading: 'Decisions' },
      { kind: 'risk', heading: 'Risks' },
      { kind: 'task', heading: 'Tasks' },
      { kind: 'note', heading: 'Notes' },
    ];
    const out: string[] = [];
    for (const { kind, heading } of order) {
      const titles = recent.filter((e) => e.kind === kind).map((e) => sanitizeTitle(e.title));
      if (titles.length === 0) continue;
      out.push(`## ${heading}`, ...titles.map((t) => `- ${t}`), '');
    }
    const omitted = this.size - recent.length;
    if (omitted > 0) out.push(`_(+${omitted} older ${omitted === 1 ? 'entry' : 'entries'}.)_`);
    return out.join('\n').trim();
  }

  toJSON(): WikiSnapshot {
    return { entries: this.list().map((e) => ({ ...e, tags: [...e.tags] })) };
  }

  static fromJSON(snapshot: WikiSnapshot, options: ProjectWikiOptions = {}): ProjectWiki {
    let maxSeq = 0;
    for (const e of snapshot.entries) {
      const m = /-(\d+)$/.exec(e.id);
      if (m) maxSeq = Math.max(maxSeq, Number.parseInt(m[1]!, 10));
    }
    const wiki = new ProjectWiki({
      ...options,
      idGenerator: options.idGenerator ?? createIdGenerator(maxSeq),
    });
    for (const entry of snapshot.entries) {
      wiki['entries'].set(entry.id, { ...entry, tags: [...entry.tags] });
      wiki['order'].push(entry.id);
      if (entry.source?.startsWith('task:')) {
        wiki['taskIndex'].set(entry.source.slice(5), entry.id);
      }
    }
    return wiki;
  }
}
