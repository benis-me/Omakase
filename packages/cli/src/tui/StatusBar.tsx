/**
 * The top status bar: session title, main agent, work mode, daemon liveness, and
 * active/total agent count. Single plain-string Text to keep Ink's width
 * measurement stable across terminals.
 */
import React from 'react';
import { Box, Text } from 'ink';

export function StatusBar(props: {
  session: string;
  agent: string;
  mode: string;
  daemon: string;
  activeAgents: number;
  totalAgents: number;
}): React.ReactElement {
  const parts = [
    'omakase',
    `session ${props.session}`,
    `agent ${props.agent}`,
    props.mode,
    props.daemon,
    `${props.activeAgents}/${props.totalAgents} agents`,
  ].filter(Boolean);
  return (
    <Box paddingX={1}>
      <Text>{parts.join('  ·  ')}</Text>
    </Box>
  );
}
