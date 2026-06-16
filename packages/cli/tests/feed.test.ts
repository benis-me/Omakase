import { describe, expect, it } from 'vitest';
import { buildFeed, transcriptToFeed } from '../src/feed.js';
import type { TranscriptItem } from '../src/view-model.js';

const items: TranscriptItem[] = [
  { kind: 'user-message', text: 'add OAuth' },
  { kind: 'route', routeKind: 'complex', reason: 'multi-file' },
  { kind: 'plan', taskCount: 4 },
  { kind: 'task-progress', role: 'worker', title: 'callback', agentLabel: 'claude', status: 'succeeded' },
  { kind: 'review', approved: true, notes: 'ok' },
  { kind: 'finished', status: 'succeeded', summary: '4/4' },
];

describe('feed', () => {
  it('renders turns with tones and a leading user glyph', () => {
    const f = transcriptToFeed(items, true);
    expect(f[0]).toEqual({ text: '› add OAuth', tone: 'user' });
    expect(f.some((l) => l.text.includes('routed → complex'))).toBe(true);
    expect(f.find((l) => l.text.includes('callback'))?.tone).toBe('agent');
    expect(f.find((l) => l.text.includes('review'))?.tone).toBe('ok');
    expect(f.at(-1)).toMatchObject({ tone: 'ok' });
  });

  it('detail=false hides route/report secondary lines', () => {
    const f = transcriptToFeed(items, false);
    expect(f.some((l) => l.text.includes('routed'))).toBe(false);
    expect(f.some((l) => l.text.includes('add OAuth'))).toBe(true);
  });

  it('buildFeed appends bash/local lines after the transcript', () => {
    const f = buildFeed(items.slice(0, 1), [{ text: '$ ls', tone: 'bash' }], { detail: true });
    expect(f.at(-1)).toEqual({ text: '$ ls', tone: 'bash' });
  });
});
