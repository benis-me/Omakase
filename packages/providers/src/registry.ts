// Provider registry. Adding a provider = add one definition + one line here.

import type { AgentProvider } from './types.ts';
import {
  claudeProvider,
  codexProvider,
  geminiProvider,
  cursorProvider,
  copilotProvider,
  qwenProvider,
  opencodeProvider,
} from './providers.ts';

export const AGENT_PROVIDERS: readonly AgentProvider[] = [
  claudeProvider,
  codexProvider,
  geminiProvider,
  cursorProvider,
  copilotProvider,
  qwenProvider,
  opencodeProvider,
];

/** Strip directory and Windows extensions from a command to get its base name. */
export function commandBase(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

/** Resolve a provider by id or command (accepts a full path). */
export function getProvider(command: string): AgentProvider | undefined {
  const base = commandBase(command);
  return AGENT_PROVIDERS.find((p) => p.id === base || p.command === base);
}
