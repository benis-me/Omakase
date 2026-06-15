/**
 * Renders a unified diff with additions green, deletions red, hunk headers cyan,
 * and metadata dimmed. Pure presentation over {@link tokenizeDiff}.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { tokenizeDiff } from './diff.js';

const COLOR: Record<string, string | undefined> = {
  add: 'green',
  del: 'red',
  hunk: 'cyan',
};

export function DiffView(props: { patch: string }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {tokenizeDiff(props.patch).map((l, i) => (
        <Text key={i} color={COLOR[l.kind]} dimColor={l.kind === 'meta'}>
          {l.text || ' '}
        </Text>
      ))}
    </Box>
  );
}
