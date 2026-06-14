/**
 * A session groups multiple serial runs into one continuous conversation. The
 * heavy run state stays in the {@link RunStore}; a session only stores the run
 * id references plus a rolling summary that bridges context from one run to the
 * next. Files live under `.omakase/sessions/<id>.json`.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Session {
  id: string;
  title: string;
  /** Run ids belonging to this session, in submission order. */
  runIds: string[];
  /** Carried-forward context summary, injected into each new run's prompt. */
  rollingSummary: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionStore {
  create(input: { id: string; title: string; now: number }): Promise<Session>;
  load(id: string): Promise<Session | null>;
  list(): Promise<Session[]>;
  appendRun(id: string, runId: string, now: number): Promise<void>;
  updateSummary(id: string, summary: string, now: number): Promise<void>;
  updateTitle(id: string, title: string, now: number): Promise<void>;
  delete(id: string): Promise<void>;
}

export function isValidSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<Session>;
  return (
    typeof s.id === 'string' &&
    typeof s.title === 'string' &&
    Array.isArray(s.runIds) &&
    s.runIds.every((r) => typeof r === 'string') &&
    typeof s.rollingSummary === 'string' &&
    typeof s.createdAt === 'number' &&
    typeof s.updatedAt === 'number'
  );
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  async create(input: { id: string; title: string; now: number }): Promise<Session> {
    const session: Session = {
      id: input.id,
      title: input.title,
      runIds: [],
      rollingSummary: '',
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.sessions.set(session.id, session);
    return structuredClone(session);
  }

  async load(id: string): Promise<Session | null> {
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : null;
  }

  async list(): Promise<Session[]> {
    return [...this.sessions.values()]
      .map((s) => structuredClone(s))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async appendRun(id: string, runId: string, now: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    if (!s.runIds.includes(runId)) s.runIds.push(runId);
    s.updatedAt = now;
  }

  async updateSummary(id: string, summary: string, now: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.rollingSummary = summary;
    s.updatedAt = now;
  }

  async updateTitle(id: string, title: string, now: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.title = title;
    s.updatedAt = now;
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}

export class FileSessionStore implements SessionStore {
  private tmpSeq = 0;
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private async write(session: Session): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(session.id);
    this.tmpSeq += 1;
    const tmp = `${target}.${this.tmpSeq}.tmp`;
    await writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
    await rename(tmp, target); // atomic: never a partial canonical file
  }

  async create(input: { id: string; title: string; now: number }): Promise<Session> {
    const session: Session = {
      id: input.id,
      title: input.title,
      runIds: [],
      rollingSummary: '',
      createdAt: input.now,
      updatedAt: input.now,
    };
    await this.write(session);
    return session;
  }

  async load(id: string): Promise<Session | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file(id), 'utf8')) as unknown;
      return isValidSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<Session[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: Session[] = [];
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      const s = await this.load(e.slice(0, -'.json'.length));
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async mutate(id: string, fn: (s: Session) => void, now: number): Promise<void> {
    const s = await this.load(id);
    if (!s) return;
    fn(s);
    s.updatedAt = now;
    await this.write(s);
  }

  async appendRun(id: string, runId: string, now: number): Promise<void> {
    await this.mutate(
      id,
      (s) => {
        if (!s.runIds.includes(runId)) s.runIds.push(runId);
      },
      now,
    );
  }

  async updateSummary(id: string, summary: string, now: number): Promise<void> {
    await this.mutate(
      id,
      (s) => {
        s.rollingSummary = summary;
      },
      now,
    );
  }

  async updateTitle(id: string, title: string, now: number): Promise<void> {
    await this.mutate(
      id,
      (s) => {
        s.title = title;
      },
      now,
    );
  }

  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}
