/**
 * The composer input line. Captures keystrokes (gated on raw-mode support),
 * shows a completion menu for `/` slash commands, and emits the raw string on
 * enter for the App to parse via parseComposerInput. Kept presentation-only:
 * all classification lives in the pure composer-parse module.
 */
import React, { useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

const COMMANDS = [
  '/new',
  '/sessions',
  '/runs',
  '/stop',
  '/pause',
  '/resume',
  '/model',
  '/agent',
  '/workflow',
  '/web',
  '/clear',
  '/help',
];

export function Composer(props: {
  focused: boolean;
  hint: string;
  onSubmit: (raw: string) => void;
}): React.ReactElement {
  const { focused, hint, onSubmit } = props;
  const { isRawModeSupported } = useStdin();
  const [value, setValue] = useState('');

  useInput(
    (input, key) => {
      if (key.return) {
        const raw = value;
        setValue('');
        if (raw.trim()) onSubmit(raw);
        return;
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow) return;
      if (input) setValue((v) => v + input);
    },
    { isActive: focused && isRawModeSupported },
  );

  const showMenu = value.startsWith('/');
  const matches = showMenu ? COMMANDS.filter((c) => c.startsWith(value.split(/\s/)[0] ?? '')) : [];

  return (
    <Box flexDirection="column">
      {showMenu && matches.length > 0 && (
        <Box paddingX={1}>
          <Text dimColor>{matches.join('  ')}</Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} paddingX={1}>
        <Text>
          {'› '}
          {value}
          {focused ? '▍' : ''}
        </Text>
      </Box>
      {hint ? <Text dimColor>{hint}</Text> : null}
    </Box>
  );
}
