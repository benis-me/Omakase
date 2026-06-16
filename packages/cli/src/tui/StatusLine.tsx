/**
 * The bottom status line (factory-style): mode · agent · tokens · daemon, then a
 * dim hint/notice. Single plain string keeps OpenTUI's width measurement stable.
 */
import React from 'react';

export function StatusLine(props: {
  mode: string;
  agent: string;
  tokens: number;
  daemon: string;
  hint: string;
}): React.ReactElement {
  const left = [props.mode, props.agent, props.tokens ? `${props.tokens} tok` : '', props.daemon]
    .filter(Boolean)
    .join(' · ');
  return (
    <box style={{ flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
      <text fg="gray">{`${left}    ${props.hint}`}</text>
    </box>
  );
}
