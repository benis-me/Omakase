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

  it('sanitizes titles and bodies so untrusted content cannot spoof sections', () => {
    const w = wiki();
    // A note whose (untrusted, agent-derived) title and body try to inject
    // markdown headings into the rendered prompt.
    w.addNote({ title: 'Real title\n## Injected', body: '## Fake Heading\nplain line' });
    const md = w.toMarkdown();
    // Title newline collapsed — no standalone heading line from the title.
    expect(md).not.toContain('\n## Injected');
    // Body heading marker escaped — not rendered as a real heading.
    expect(md).toContain('\\## Fake Heading');
    expect(md).not.toContain('\n## Fake Heading');
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

describe('ProjectWiki.toPromptMarkdown (bounded injection)', () => {
  function growing() {
    let t = 0;
    return new ProjectWiki({ idGenerator: createIdGenerator(), clock: () => t++ });
  }

  it('caps total size, clips oversized entries, keeps recent, notes omissions', () => {
    const w = growing();
    w.addFact({ title: 'Ancient narration', body: 'x'.repeat(5000) }); // oldest + huge
    for (let i = 0; i < 30; i++) w.addFact({ title: `Fact ${i}`, body: `body ${i}` });

    const md = w.toPromptMarkdown(1000, 200);
    expect(md.length).toBeLessThan(2000); // bounded, far below the full ~6k
    expect(md).not.toContain('x'.repeat(250)); // the 5000-char body never injected whole
    expect(md).toContain('Fact 29'); // newest kept
    expect(md).toContain('omitted'); // older entries dropped, with a note
  });

  it('returns the full set (no omission note) when under budget', () => {
    const w = growing();
    w.addFact({ title: 'Alpha', body: 'short' });
    w.addDecision({ title: 'Beta', body: 'short' });
    const md = w.toPromptMarkdown(3500, 400);
    expect(md).toContain('### Alpha');
    expect(md).toContain('### Beta');
    expect(md).not.toContain('omitted');
  });
});

describe('ProjectWiki.toIndexMarkdown (pull index)', () => {
  it('lists titles only — no bodies — grouped by kind', () => {
    const w = new ProjectWiki({ idGenerator: createIdGenerator(), clock: () => 0 });
    w.addFact({ title: 'Uses pnpm', body: 'BODY_SHOULD_NOT_APPEAR '.repeat(20) });
    w.addDecision({ title: 'ESM only', body: 'ALSO_HIDDEN '.repeat(20) });
    const md = w.toIndexMarkdown();
    expect(md).toContain('## Facts');
    expect(md).toContain('- Uses pnpm');
    expect(md).toContain('- ESM only');
    expect(md).not.toContain('BODY_SHOULD_NOT_APPEAR');
    expect(md).not.toContain('ALSO_HIDDEN');
  });

  it('caps to the most recent entries and notes the remainder', () => {
    let t = 0;
    const w = new ProjectWiki({ idGenerator: createIdGenerator(), clock: () => t++ });
    for (let i = 0; i < 50; i++) w.addFact({ title: `Fact ${i}` });
    const md = w.toIndexMarkdown(10);
    expect(md).toContain('- Fact 49'); // newest kept
    expect(md).not.toContain('- Fact 0'); // oldest dropped
    expect(md).toContain('+40 older');
  });
});

describe('ProjectWiki.toCoreMarkdown (always-in-context core)', () => {
  it('keeps decisions + risks with bodies; excludes facts/tasks/notes', () => {
    let t = 0;
    const w = new ProjectWiki({ idGenerator: createIdGenerator(), clock: () => t++ });
    w.addFact({ title: 'a fact', body: 'FACT_BODY_EXCLUDED' });
    w.addDecision({ title: 'use ESM', body: 'NodeNext modules everywhere' });
    w.addRisk({ title: 'flaky network', body: 'retry external calls' });
    w.recordTask('t1', 'TASK_EXCLUDED', 'done');
    const md = w.toCoreMarkdown();
    expect(md).toContain('use ESM');
    expect(md).toContain('NodeNext modules');
    expect(md).toContain('flaky network');
    expect(md).not.toContain('FACT_BODY_EXCLUDED');
    expect(md).not.toContain('TASK_EXCLUDED');
  });

  it('is empty when there are no decisions or risks', () => {
    const w = new ProjectWiki({ idGenerator: createIdGenerator(), clock: () => 0 });
    w.addFact({ title: 'x', body: 'y' });
    expect(w.toCoreMarkdown()).toBe('');
  });
});
