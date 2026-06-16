/**
 * Fold a run's transcript (plus local bash/system lines) into a flat list of
 * renderable feed lines for the single-column conversation view. Pure: the
 * OpenTUI <Transcript> just paints what this returns. `detail` hides secondary
 * lines (route/report) when the user collapses with ctrl+o.
 */
import type { TranscriptItem } from './view-model.js';

export type FeedTone = 'user' | 'agent' | 'ok' | 'bad' | 'dim' | 'bash';

export interface FeedLine {
  text: string;
  tone: FeedTone;
}

export function transcriptToFeed(items: TranscriptItem[], detail: boolean): FeedLine[] {
  const out: FeedLine[] = [];
  for (const it of items) {
    switch (it.kind) {
      case 'user-message':
        out.push({ text: `› ${it.text}`, tone: 'user' });
        break;
      case 'route':
        if (detail) out.push({ text: `  ⏺ routed → ${it.routeKind} · ${it.reason}`, tone: 'dim' });
        break;
      case 'plan':
        out.push({ text: `  ⏺ planned ${it.taskCount} task(s)`, tone: 'dim' });
        break;
      case 'task-progress': {
        const g = it.status === 'started' ? '⏺' : it.status === 'succeeded' ? '✓' : '✗';
        out.push({
          text: `  ${g} ${it.role}${it.agentLabel ? `[${it.agentLabel}]` : ''} ${it.title}`,
          tone: it.status === 'failed' ? 'bad' : 'agent',
        });
        break;
      }
      case 'review':
        out.push({
          text: `  ⏺ review ${it.approved ? 'APPROVED' : 'REJECTED'} — ${it.notes}`,
          tone: it.approved ? 'ok' : 'bad',
        });
        break;
      case 'report':
        if (detail) out.push({ text: `  ⏺ report: ${it.title}`, tone: 'dim' });
        break;
      case 'workflow-phase':
        out.push({ text: `  ⏺ workflow ${it.status}: ${it.name}`, tone: 'dim' });
        break;
      case 'finished':
        out.push({ text: `  ● ${it.status} — ${it.summary}`, tone: it.status === 'succeeded' ? 'ok' : 'bad' });
        break;
    }
  }
  return out;
}

export function buildFeed(transcript: TranscriptItem[], bashLog: FeedLine[], opts: { detail: boolean }): FeedLine[] {
  return [...transcriptToFeed(transcript, opts.detail), ...bashLog];
}
