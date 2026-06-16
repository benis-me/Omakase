/**
 * Pure classifier for the composer line — the single source of truth for what a
 * typed line means, shared by the input UI and tests. Recognizes bash (`!`),
 * slash commands (`/`), `/workflow`, and natural-language tasks (with inline
 * `@agent` override and `#file` references stripped out).
 */
export type Intent =
  | { kind: 'empty' }
  | { kind: 'bash'; command: string }
  | { kind: 'command'; name: string; args: string }
  | { kind: 'workflow'; source: string }
  | { kind: 'task'; prompt: string; agentOverride?: string; files: string[] };

const AGENT_RE = /(?:^|\s)@([A-Za-z0-9_.:-]+)/;
const FILE_RE = /(?:^|\s)#(\S+)/g;

export function parseInput(raw: string): Intent {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };

  if (trimmed.startsWith('!')) {
    const command = trimmed.slice(1).trim();
    return command ? { kind: 'bash', command } : { kind: 'empty' };
  }

  if (trimmed.startsWith('/')) {
    const rest = trimmed.slice(1);
    const sp = rest.search(/\s/);
    const name = (sp === -1 ? rest : rest.slice(0, sp)).toLowerCase();
    const args = sp === -1 ? '' : rest.slice(sp + 1).trim();
    if (name === 'workflow') return { kind: 'workflow', source: args };
    return { kind: 'command', name, args };
  }

  let agentOverride: string | undefined;
  let body = trimmed;
  const m = AGENT_RE.exec(trimmed);
  if (m) {
    agentOverride = m[1];
    body = (body.slice(0, m.index) + body.slice(m.index + m[0].length)).trim();
  }
  const files: string[] = [];
  body = body.replace(FILE_RE, (_x, p1: string) => {
    files.push(p1);
    return ' ';
  });
  const prompt = body.replace(/\s+/g, ' ').trim();
  return agentOverride ? { kind: 'task', prompt, agentOverride, files } : { kind: 'task', prompt, files };
}
