/**
 * The input line: a native OpenTUI <textarea> (real multiline editor, correct
 * keybindings) behind a `›`/`$` prompt. Uncontrolled — content is mirrored out
 * via onContentChange; remount via `epoch` clears it. Bash mode flips the glyph.
 */
import React from 'react';

export function Composer(props: {
  glyph: string;
  placeholder: string;
  bashMode: boolean;
  focused: boolean;
  epoch: number;
  onContentChange: (text: string) => void;
  onSubmit: () => void;
}): React.ReactElement {
  return (
    <box
      style={{
        flexDirection: 'row',
        flexShrink: 0,
        border: true,
        borderColor: props.bashMode ? 'yellow' : 'gray',
        minHeight: 3,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text fg={props.bashMode ? 'yellow' : 'cyan'}>{`${props.glyph} `}</text>
      <textarea
        key={props.epoch}
        focused={props.focused}
        placeholder={props.placeholder}
        style={{ flexGrow: 1, minHeight: 1 }}
        onContentChange={(e: { text?: string; content?: string } | string) =>
          props.onContentChange(typeof e === 'string' ? e : (e.text ?? e.content ?? ''))
        }
        onSubmit={props.onSubmit}
      />
    </box>
  );
}
