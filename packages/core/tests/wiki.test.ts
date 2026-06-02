import { describe, expect, it } from 'vitest';
import { ProjectWiki } from '../src/knowledge/wiki.js';
import { createIdGenerator } from '../src/ids.js';

function wiki() {
  return new ProjectWiki({ idGenerator: createIdGenerator(), clock: () => 0 });
}

describe('ProjectWiki', () => {
  it('stores facts, decisions, and risks', () => {
    const w = wiki();
    w.addFact({ title: 'Uses pnpm', body: 'Workspace monorepo' });
    w.addDecision({ title: 'ESM only', body: 'NodeNext modules' });
    w.addRisk({ title: 'pi not installed', body: 'fall back to builtin' });
    expect(w.list('fact')).toHaveLength(1);
    expect(w.list('decision')).toHaveLength(1);
    expect(w.list('risk')).toHaveLength(1);
    expect(w.size).toBe(3);
  });

  it('upserts task entries by task id', () => {
    const w = wiki();
    w.recordTask('task-1', 'Build parser', 'running');
    w.recordTask('task-1', 'Build parser', 'succeeded', 'all tests pass');
    const tasks = w.list('task');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.body).toContain('succeeded');
    expect(tasks[0]?.body).toContain('all tests pass');
  });

  it('renders markdown grouped by kind', () => {
    const w = wiki();
    w.addFact({ title: 'F1', body: 'fact body' });
    w.addDecision({ title: 'D1' });
    const md = w.toMarkdown();
    expect(md).toContain('# Project Wiki');
    expect(md).toContain('## Facts');
    expect(md).toContain('### F1');
    expect(md).toContain('## Decisions');
  });

  it('round-trips through JSON, preserving the task index', () => {
    const w = wiki();
    w.recordTask('task-9', 'A task', 'running');
    const snapshot = w.toJSON();
    const restored = ProjectWiki.fromJSON(snapshot);
    restored.recordTask('task-9', 'A task', 'succeeded');
    expect(restored.list('task')).toHaveLength(1);
    // New entries don't collide with restored ids.
    const fact = restored.addFact({ title: 'new' });
    expect(snapshot.entries.some((e) => e.id === fact.id)).toBe(false);
  });
});
