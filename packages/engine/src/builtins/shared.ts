import type { AgentResult } from '../workflow-types.ts';

/** A built-in must never turn a failed required agent into a green report. */
export function requireAgent(result: AgentResult, label: string): AgentResult {
  if (result.status === 'ok') return result;
  const detail = result.text.trim().replace(/\s+/g, ' ').slice(0, 240) || 'unknown error';
  throw new Error(`${label} failed: ${detail}`);
}

export function requireAgents(results: AgentResult[], label: string): AgentResult[] {
  results.forEach((result, index) => requireAgent(result, `${label} ${index + 1}`));
  return results;
}
