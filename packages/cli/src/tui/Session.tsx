/**
 * The conversation scrollback: the focused session's transcript rendered as a
 * readable chat timeline. The newest items are kept visible by tailing the
 * array to the available rows. Pure presentation over TranscriptItem[].
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { TranscriptItem } from '../view-model.js';
import { MarkdownView } from './render/MarkdownView.js';

function line(item: TranscriptItem): React.ReactElement {
  switch (item.kind) {
    case 'user-message':
      return <Text color="cyan">› {item.text}</Text>;
    case 'route':
      return (
        <Text dimColor>
          {'  '}↪ router → {item.routeKind} ({item.reason})
        </Text>
      );
    case 'plan':
      return <Text dimColor>{'  '}▤ planned {item.taskCount} task(s)</Text>;
    case 'task-progress':
      return (
        <Text>
          {'  '}
          {item.status === 'started' ? '▸' : item.status === 'succeeded' ? '✓' : '✗'} {item.role}
          {item.agentLabel ? `[${item.agentLabel}]` : ''} {item.title}
        </Text>
      );
    case 'review':
      return (
        <Text color={item.approved ? 'green' : 'red'}>
          {'  '}⚖ {item.approved ? 'APPROVED' : 'REJECTED'} — {item.notes}
        </Text>
      );
    case 'report':
      return <Text dimColor>{'  '}▣ report: {item.title}</Text>;
    case 'workflow-phase':
      return (
        <Text dimColor>
          {'  '}▧ workflow phase {item.status}: {item.name}
        </Text>
      );
    case 'finished':
      return (
        <Text color={item.status === 'succeeded' ? 'green' : 'yellow'}>
          {'  '}■ {item.status} — {item.summary}
        </Text>
      );
  }
}

export function Session(props: {
  transcript: TranscriptItem[];
  title: string;
  focused: boolean;
  rows: number;
  /** Live agent prose (RunView.activity tail) rendered as a streaming message. */
  streaming?: string[];
}): React.ReactElement {
  const { transcript, title, focused, rows, streaming = [] } = props;
  const budget = Math.max(4, rows - 2);
  const stream = streaming.slice(-6);
  const visible = transcript.slice(-Math.max(2, budget - stream.length));
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      <Text bold>session · {title}</Text>
      {visible.length === 0 && stream.length === 0 ? (
        <Text dimColor>type a task below to start — router will plan and dispatch agents</Text>
      ) : (
        visible.map((item, i) => <Box key={i}>{line(item)}</Box>)
      )}
      {stream.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="magenta">▌ assistant</Text>
          <MarkdownView source={stream.join('\n')} />
        </Box>
      )}
    </Box>
  );
}
