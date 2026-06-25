/**
 * The validator: an independent judge of whether a run's work actually meets its
 * goal and acceptance criteria. Unlike the per-task {@link parseReview reviewer},
 * the validator assesses the WHOLE run at the finish line — it judges completion
 * and surfaces concrete remaining gaps as fix-tasks, but never implements fixes
 * itself (Factory-Missions style: workers build, an independent validator gates).
 *
 * Pure + deterministic: the orchestrator runs a validator agent and feeds its
 * text through {@link parseValidationVerdict}; both the prompt and the parse are
 * unit-tested here.
 */

export interface ValidationVerdict {
  /** True only when the goal and every criterion are genuinely met. */
  passed: boolean;
  /** Concrete, actionable remaining gaps (each becomes a fix-task). Empty if passed. */
  gaps: string[];
  /** Short rationale. */
  notes: string;
}

export function buildValidationPrompt(prompt: string, criteria: string[], context: string): string {
  const criteriaBlock = criteria.length
    ? criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '(none stated — judge against the request itself)';
  return [
    'You are an independent VALIDATOR. The work below claims to be complete.',
    'Judge whether it actually satisfies the goal and every acceptance criterion.',
    'Do NOT implement anything — only assess, and list concrete remaining gaps.',
    '',
    `GOAL:\n${prompt}`,
    '',
    `ACCEPTANCE CRITERIA:\n${criteriaBlock}`,
    '',
    `RUN CONTEXT (tasks, acceptance, reports):\n${context}`,
    '',
    'Reply with a single JSON object and nothing else:',
    '{ "passed": <true only if the goal and ALL criteria are genuinely met>,',
    '  "gaps": [<short, concrete, actionable fix descriptions; empty if passed>],',
    '  "notes": "<one or two sentences of rationale>" }',
    'Default to passed=false when you are not confident the work is complete.',
  ].join('\n');
}

export function parseValidationVerdict(text: string): ValidationVerdict {
  const obj = extractJsonObject(text);
  if (obj && typeof obj.passed === 'boolean') {
    const gaps = Array.isArray(obj.gaps)
      ? (obj.gaps.filter((g) => typeof g === 'string') as string[]).map((g) => g.trim()).filter(Boolean)
      : [];
    const notes = typeof obj.notes === 'string' ? obj.notes : '';
    // "passed" with listed gaps is contradictory — the gaps win.
    return { passed: obj.passed && gaps.length === 0, gaps, notes };
  }
  // Heuristic fallback for non-JSON output.
  const lower = text.toLowerCase();
  const gaps = extractBulletGaps(text);
  const rejected = gaps.length > 0 || /\b(incomplete|not done|missing|fails?|does not|todo|gap)\b/.test(lower);
  const approved = /\b(passed|approved|complete|all criteria met|looks good|lgtm)\b/.test(lower);
  return { passed: approved && !rejected, gaps, notes: text.trim().slice(0, 400) };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, i + 1)) as unknown;
          return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function extractBulletGaps(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+(.*\S)/);
    if (m) out.push(m[1].trim());
  }
  return out.slice(0, 12);
}
