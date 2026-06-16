/**
 * The single-column conversation view: a scrollable feed of turns (orchestration
 * shown inline) plus a live "working…" markdown block while a run streams. Pure
 * presentation over the feed lines built by feed.ts. `scroll` is lines-from-
 * bottom (0 follows newest).
 */
import React from 'react';
import type { FeedLine, FeedTone } from '../feed.js';

const TONE: Record<FeedTone, string | undefined> = {
  user: 'cyan',
  agent: undefined,
  ok: 'green',
  bad: 'red',
  dim: 'gray',
  bash: 'yellow',
};

export function Transcript(props: {
  feed: FeedLine[];
  streaming: string[];
  scroll: number;
  emptyHint: string;
}): React.ReactElement {
  const atBottom = props.scroll <= 0;
  const end = Math.max(0, props.feed.length - Math.max(0, props.scroll));
  const visible = atBottom ? props.feed : props.feed.slice(0, end);
  return (
    <scrollbox focused style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, paddingLeft: 1, paddingRight: 1 }}>
      {visible.length === 0 && props.streaming.length === 0 ? (
        <text fg="gray">{props.emptyHint}</text>
      ) : (
        visible.map((l, i) => (
          <text key={i} fg={TONE[l.tone]}>
            {l.text}
          </text>
        ))
      )}
      {atBottom && props.streaming.length > 0 ? (
        <box style={{ flexDirection: 'column', marginTop: 1 }}>
          <text fg="magenta">▌ working…</text>
          <markdown content={props.streaming.slice(-8).join('\n')} />
        </box>
      ) : null}
    </scrollbox>
  );
}
