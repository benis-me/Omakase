/**
 * The project wiki: a living store of facts, decisions, risks, task statuses,
 * and notes. The orchestrator feeds it task results and agent summaries; it
 * serializes to JSON for persistence and renders to Markdown for prompt
 * injection or human reading. Updates are incremental (task entries are
 * upserted by task id).
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

export interface ProjectWikiOptions {
  idGenerator?: IdGenerator;
  clock?: () => number;
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

  /** Upsert a task-status entry keyed by task id. */
  recordTask(taskId: string, title: string, status: string, summary = ''): WikiEntry {
    const existingId = this.taskIndex.get(taskId);
    const body = `Status: ${status}${summary ? `\n${summary}` : ''}`;
    if (existingId && this.entries.has(existingId)) {
      return this.update(existingId, { title, body, tags: ['task', status] });
    }
    const entry = this.add('task', {
      title,
      body,
      tags: ['task', status],
      source: `task:${taskId}`,
    });
    this.taskIndex.set(taskId, entry.id);
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
        out.push(`### ${entry.title}`);
        if (entry.body) out.push(entry.body);
        if (entry.tags.length > 0) out.push(`_tags: ${entry.tags.join(', ')}_`);
        out.push('');
      }
    }
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
