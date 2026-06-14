/**
 * Pure parser for the TUI composer line. Classifies raw input into a task
 * (natural language, with optional inline `@agent` override and `#file`
 * references), a slash command, a `/workflow` request, or empty. Kept pure so
 * the completion UI and the App can both rely on identical, unit-tested rules.
 */
export type ComposerIntent =
  | { kind: 'empty' }
  | { kind: 'task'; prompt: string; agentOverride?: string; files: string[] }
  | { kind: 'command'; name: string; args: string }
  | { kind: 'workflow'; source: string };

/** An @agent or #file token only counts at a word boundary (so emails don't match). */
const AGENT_RE = /(?:^|\s)@([A-Za-z0-9_.:-]+)/;
const FILE_RE = /(?:^|\s)#(\S+)/g;

export function parseComposerInput(raw: string): ComposerIntent {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };

  if (trimmed.startsWith('/')) {
    const rest = trimmed.slice(1);
    const sp = rest.search(/\s/);
    const name = (sp === -1 ? rest : rest.slice(0, sp)).toLowerCase();
    const args = sp === -1 ? '' : rest.slice(sp + 1).trim();
    if (name === 'workflow') return { kind: 'workflow', source: args };
    return { kind: 'command', name, args };
  }

  let agentOverride: string | undefined;
  const agentMatch = AGENT_RE.exec(trimmed);
  let body = trimmed;
  if (agentMatch) {
    agentOverride = agentMatch[1];
    body = (body.slice(0, agentMatch.index) + body.slice(agentMatch.index + agentMatch[0].length)).trim();
  }

  const files: string[] = [];
  body = body.replace(FILE_RE, (_m, p1: string) => {
    files.push(p1);
    return ' ';
  });
  const prompt = body.replace(/\s+/g, ' ').trim();

  return agentOverride
    ? { kind: 'task', prompt, agentOverride, files }
    : { kind: 'task', prompt, files };
}

/**
 * Build the final run prompt for a task submitted inside a session: the session's
 * rolling summary (if any) is prepended as context, and any #file references are
 * appended as an explicit list. Pure and deterministic.
 */
export function composeSessionPrompt(
  intent: { prompt: string; files: string[] },
  rollingSummary: string,
): string {
  const parts: string[] = [];
  if (rollingSummary.trim()) {
    parts.push(`Session context so far:\n${rollingSummary.trim()}\n`);
  }
  parts.push(intent.prompt);
  if (intent.files.length > 0) {
    parts.push(`\nContext files:\n${intent.files.map((f) => `- ${f}`).join('\n')}`);
  }
  return parts.join('\n');
}
