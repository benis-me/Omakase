// Slash commands for the TUI input. Typing "/" turns the goal field into a
// command palette: the list filters as you type, ↑/↓ picks, ⏎ runs.

export type CommandArg = 'none' | 'workflow' | 'provider' | 'runId' | 'text';

export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  arg: CommandArg;
}

export const COMMANDS: readonly SlashCommand[] = [
  { name: 'workflow', usage: '/workflow <name>', description: 'Switch the workflow for the next run', arg: 'workflow' },
  { name: 'provider', usage: '/provider <id|auto>', description: 'Pin the agent provider (or auto)', arg: 'provider' },
  { name: 'settings', usage: '/settings', description: 'Open workspace settings', arg: 'none' },
  { name: 'runs', usage: '/runs', description: 'Focus the runs list to browse history', arg: 'none' },
  { name: 'resume', usage: '/resume <runId>', description: 'Resume an interrupted run', arg: 'runId' },
  { name: 'cancel', usage: '/cancel', description: 'Cancel the run in progress', arg: 'none' },
  { name: 'clear', usage: '/clear', description: 'Clear the event log view', arg: 'none' },
  { name: 'help', usage: '/help', description: 'Show keys and commands', arg: 'none' },
  { name: 'quit', usage: '/quit', description: 'Exit Omakase', arg: 'none' },
];

/** True when the field should be treated as a command palette. */
export function isCommandInput(value: string): boolean {
  return value.startsWith('/');
}

export interface ParsedCommand {
  name: string;
  arg: string;
}

/** Split "/workflow tdd" → { name: 'workflow', arg: 'tdd' }. */
export function parseCommand(value: string): ParsedCommand | null {
  if (!isCommandInput(value)) return null;
  const rest = value.slice(1);
  const sp = rest.indexOf(' ');
  if (sp === -1) return { name: rest.trim().toLowerCase(), arg: '' };
  return { name: rest.slice(0, sp).trim().toLowerCase(), arg: rest.slice(sp + 1).trim() };
}

/**
 * Commands matching what's typed so far. Before a space we filter by prefix;
 * once a name matches exactly and a space follows, we keep just that command
 * (so the palette shows its usage while the argument is typed).
 */
export function filterCommands(value: string): SlashCommand[] {
  const parsed = parseCommand(value);
  if (!parsed) return [];
  const exact = COMMANDS.find((c) => c.name === parsed.name);
  if (exact && value.includes(' ')) return [exact];
  if (!parsed.name) return [...COMMANDS];
  return COMMANDS.filter((c) => c.name.startsWith(parsed.name));
}

/** Suggestions for a command's argument (workflow names, provider ids, run ids). */
export function argSuggestions(cmd: SlashCommand, ctx: { workflows: string[]; providers: string[]; runIds: string[] }): string[] {
  switch (cmd.arg) {
    case 'workflow':
      return ctx.workflows;
    case 'provider':
      return ['auto', ...ctx.providers];
    case 'runId':
      return ctx.runIds.slice(0, 8);
    default:
      return [];
  }
}
