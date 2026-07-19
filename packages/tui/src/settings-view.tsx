import React, { useState, useCallback } from 'react';
import { useKeyboard } from '@opentui/react';
import { PERMISSION_MODES, resolvePermission } from '@omakase/core';
import type { Workspace, WorkspaceSettings } from '@omakase/core';
import type { ProviderInfo } from '@omakase/providers';
import { theme } from './render.ts';

export interface SettingsViewProps {
  workspace: Workspace;
  providers: ProviderInfo[];
  onClose: () => void;
  width: number;
}

type RowKind = 'enum' | 'bool' | 'number' | 'list';
interface Row {
  key: keyof WorkspaceSettings;
  label: string;
  kind: RowKind;
  hint: string;
}

const ROWS: Row[] = [
  { key: 'defaultProvider', label: 'Default provider', kind: 'enum', hint: 'Agent used when a run or workflow does not pin one' },
  { key: 'defaultModel', label: 'Default model', kind: 'enum', hint: 'Model for the default provider' },
  { key: 'maxAgentsPerRun', label: 'Max agents / run', kind: 'number', hint: 'Budget: how many agent turns a single run may spend' },
  { key: 'permission', label: 'Permission', kind: 'enum', hint: 'What agents may do: read-only · edit the workspace · bypass all approval' },
  { key: 'providerPreference', label: 'Provider order', kind: 'list', hint: 'Fallback order when a provider fails (← → rotates)' },
];

const DEFAULT_ORDER = ['claude', 'codex', 'gemini', 'cursor-agent'];

export function SettingsView(props: SettingsViewProps) {
  const [sel, setSel] = useState(0);
  const [settings, setSettings] = useState<WorkspaceSettings>({ ...props.workspace.settings });

  const availableIds = props.providers.filter((p) => p.available).map((p) => p.id);
  const providerChoices = ['auto', ...availableIds];
  const activeProvider = settings.defaultProvider;
  const modelChoices = [
    'auto',
    ...(activeProvider ? (props.providers.find((p) => p.id === activeProvider)?.models ?? []) : []),
  ];

  const save = useCallback(
    (patch: Partial<WorkspaceSettings>) => {
      props.workspace.updateSettings(patch);
      setSettings((s) => ({ ...s, ...patch }));
    },
    [props.workspace],
  );

  const cycle = useCallback(
    (dir: 1 | -1) => {
      const row = ROWS[sel]!;
      switch (row.key) {
        case 'defaultProvider': {
          const cur = settings.defaultProvider ?? 'auto';
          const i = Math.max(0, providerChoices.indexOf(cur));
          const next = providerChoices[(i + dir + providerChoices.length) % providerChoices.length]!;
          // Changing provider invalidates a model pinned to the old one.
          save({ ...(next === 'auto' ? { defaultProvider: undefined } : { defaultProvider: next }), defaultModel: undefined });
          break;
        }
        case 'defaultModel': {
          const cur = settings.defaultModel ?? 'auto';
          const i = Math.max(0, modelChoices.indexOf(cur));
          const next = modelChoices[(i + dir + modelChoices.length) % modelChoices.length]!;
          save(next === 'auto' ? { defaultModel: undefined } : { defaultModel: next });
          break;
        }
        case 'maxAgentsPerRun': {
          const cur = settings.maxAgentsPerRun ?? 64;
          save({ maxAgentsPerRun: Math.min(512, Math.max(1, cur + dir * 8)) });
          break;
        }
        case 'permission': {
          const cur = resolvePermission(settings);
          const i = PERMISSION_MODES.indexOf(cur);
          const next = PERMISSION_MODES[(i + dir + PERMISSION_MODES.length) % PERMISSION_MODES.length]!;
          save({ permission: next });
          break;
        }
        case 'providerPreference': {
          const cur = settings.providerPreference ?? DEFAULT_ORDER;
          const next = dir === 1 ? [...cur.slice(1), cur[0]!] : [cur[cur.length - 1]!, ...cur.slice(0, -1)];
          save({ providerPreference: next });
          break;
        }
      }
    },
    [sel, settings, providerChoices, modelChoices, save],
  );

  useKeyboard((key: { name?: string; ctrl?: boolean }) => {
    const name = key.name ?? '';
    if (name === 'escape' || name === 'return' || name === 'enter' || (name === 'c' && key.ctrl)) {
      props.onClose();
      return;
    }
    if (name === 'up') setSel((s) => Math.max(0, s - 1));
    else if (name === 'down') setSel((s) => Math.min(ROWS.length - 1, s + 1));
    else if (name === 'left') cycle(-1);
    else if (name === 'right' || name === 'space') cycle(1);
  });

  const valueOf = (row: Row): string => {
    switch (row.key) {
      case 'defaultProvider':
        return settings.defaultProvider ?? 'auto';
      case 'defaultModel':
        return settings.defaultModel ?? 'auto';
      case 'maxAgentsPerRun':
        return String(settings.maxAgentsPerRun ?? 64);
      case 'permission':
        return resolvePermission(settings);
      case 'providerPreference':
        return (settings.providerPreference ?? DEFAULT_ORDER).join(' → ');
      default:
        return '';
    }
  };

  const labelW = 18;

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1 }}>
      <box
        style={{
          flexDirection: 'column',
          flexGrow: 1,
          paddingLeft: 1,
          paddingRight: 1,
          border: true,
          borderStyle: 'rounded',
          borderColor: theme.borderFocus,
          backgroundColor: theme.canvas,
        }}
        title=" settings "
        titleColor={theme.accent}
        titleAlignment="left"
      >
        {ROWS.map((row, i) => {
          const active = i === sel;
          return (
            <box key={row.key} style={{ flexDirection: 'row' }}>
              <text fg={active ? theme.accent : theme.faint}>{active ? '▍ ' : '  '}</text>
              <text fg={active ? theme.fg : theme.dim}>{row.label.padEnd(labelW)}</text>
              <text fg={active ? theme.accent : theme.info}>{valueOf(row)}</text>
            </box>
          );
        })}
        <box style={{ flexDirection: 'row', paddingTop: 1 }}>
          <text fg={theme.faint}>{ROWS[sel]!.hint}</text>
        </box>
        <box style={{ flexDirection: 'row', paddingTop: 1 }}>
          <text fg={theme.faint}>{`saved to ${props.workspace.paths.configFile}`}</text>
        </box>
      </box>
      <box style={{ flexDirection: 'row', paddingLeft: 1 }}>
        <text fg={theme.dim}>↑↓</text>
        <text fg={theme.faint}> select  </text>
        <text fg={theme.dim}>←→</text>
        <text fg={theme.faint}> change  </text>
        <text fg={theme.dim}>⏎/esc</text>
        <text fg={theme.faint}> back</text>
      </box>
    </box>
  );
}
