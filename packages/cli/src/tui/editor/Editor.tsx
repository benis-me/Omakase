/**
 * The multiline composer view. It normalizes Ink key events into {@link EditorKey}
 * and folds them through the pure {@link reduceEditor} model, renders the buffer
 * with an inline cursor, submits on Enter, and inserts a newline on ctrl+j /
 * alt+enter. All edit logic lives in the model; this file is just I/O + paint.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import {
  editorText,
  initialEditorState,
  isEmpty,
  reduceEditor,
  type EditorKey,
  type EditorState,
} from './state.js';

function toEditorKey(input: string, key: Record<string, boolean>): EditorKey {
  if (input === '\n' || (key.meta && key.return)) return { input: '', name: 'newline' };
  if (key.leftArrow) return { input: '', name: 'left' };
  if (key.rightArrow) return { input: '', name: 'right' };
  if (key.upArrow) return { input: '', name: 'up' };
  if (key.downArrow) return { input: '', name: 'down' };
  if (key.backspace) return { input: '', name: 'backspace' };
  if (key.delete) return { input: '', name: 'delete' };
  if (key.ctrl) return { input, ctrl: true };
  return { input };
}

export function Editor(props: {
  focused: boolean;
  hint: string;
  onSubmit: (text: string) => void;
  onChange: (text: string) => void;
}): React.ReactElement {
  const { focused, hint, onSubmit, onChange } = props;
  const { isRawModeSupported } = useStdin();
  const [state, setState] = useState<EditorState>(initialEditorState);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    onChange(editorText(state));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useInput(
    (input, key) => {
      // Enter (CR) submits; ctrl+j (LF, input '\n') and alt+enter insert a newline.
      if (key.return && input !== '\n') {
        const current = stateRef.current;
        if (!isEmpty(current)) {
          onSubmit(editorText(current));
          setState(initialEditorState());
        }
        return;
      }
      const ev = toEditorKey(input, key as unknown as Record<string, boolean>);
      setState((s) => reduceEditor(s, ev));
    },
    { isActive: focused && isRawModeSupported },
  );

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} paddingX={1} flexDirection="column">
        {state.lines.map((line, r) => {
          const prefix = r === 0 ? '› ' : '  ';
          if (focused && r === state.row) {
            const before = line.slice(0, state.col);
            const at = line.slice(state.col, state.col + 1) || ' ';
            const after = line.slice(state.col + 1);
            return (
              <Text key={r}>
                {prefix}
                {before}
                <Text inverse>{at}</Text>
                {after}
              </Text>
            );
          }
          return (
            <Text key={r}>
              {prefix}
              {line}
            </Text>
          );
        })}
      </Box>
      {hint ? <Text dimColor>{hint}</Text> : null}
    </Box>
  );
}
