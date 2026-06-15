/**
 * A generic fuzzy select overlay: a title, a filter line, and a navigable list.
 * Reused by the command palette and the session/model/agent selectors. It owns
 * its query + selection and reports a pick or a close; the host suppresses other
 * input while it is active.
 */
import React, { useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { fuzzyFilter } from './fuzzy.js';

export interface OverlayItem {
  id: string;
  label: string;
  hint?: string;
}

export function Overlay(props: {
  title: string;
  items: OverlayItem[];
  active: boolean;
  onPick: (item: OverlayItem) => void;
  onClose: () => void;
}): React.ReactElement {
  const { title, items, active, onPick, onClose } = props;
  const { isRawModeSupported } = useStdin();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  const filtered = fuzzyFilter(items, query, (i) => `${i.label} ${i.hint ?? ''}`);
  const clamped = Math.min(selected, Math.max(0, filtered.length - 1));

  useInput(
    (input, key) => {
      if (key.escape) {
        onClose();
        return;
      }
      if (key.return) {
        const pick = filtered[clamped];
        if (pick) onPick(pick);
        return;
      }
      if (key.upArrow) {
        setSelected((s) => Math.max(0, Math.min(s, filtered.length - 1) - 1));
        return;
      }
      if (key.downArrow) {
        setSelected((s) => Math.min(filtered.length - 1, s + 1));
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setSelected(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        setSelected(0);
      }
    },
    { isActive: active && isRawModeSupported },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{title}</Text>
      <Text>
        <Text dimColor>{'> '}</Text>
        {query}
        <Text inverse> </Text>
      </Text>
      {filtered.length === 0 ? (
        <Text dimColor>no matches</Text>
      ) : (
        filtered.slice(0, 10).map((item, i) => (
          <Text key={item.id} inverse={i === clamped}>
            {item.label}
            {item.hint ? <Text dimColor> — {item.hint}</Text> : null}
          </Text>
        ))
      )}
    </Box>
  );
}
