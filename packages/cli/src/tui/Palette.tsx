/**
 * A generic fuzzy select overlay (commands / sessions / agents / files). The
 * host pre-filters items; this renders a native <select> and reports the picked
 * id. Escape-to-close is handled by the host's key router.
 */
import React from 'react';

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
}

export function Palette(props: {
  title: string;
  items: PaletteItem[];
  onPick: (id: string) => void;
}): React.ReactElement {
  const options = props.items.map((i) => ({ name: i.hint ? `${i.label}  —  ${i.hint}` : i.label, value: i.id }));
  return (
    <box style={{ flexDirection: 'column', flexShrink: 0, border: true, borderColor: 'cyan', paddingLeft: 1, paddingRight: 1 }}>
      <text>{`${props.title}  (↑↓ · enter · esc)`}</text>
      <select
        focused
        options={options}
        onSelect={(_i: number, opt: { value?: string } | null) => {
          if (opt?.value) props.onPick(opt.value);
        }}
      />
    </box>
  );
}
