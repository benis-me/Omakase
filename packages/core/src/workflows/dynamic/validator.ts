export class WorkflowScriptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowScriptValidationError';
  }
}

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bimport\s+(?:[^('"`]|$)/, label: 'import' },
  { pattern: /\bimport\s*\(/, label: 'dynamic import' },
  { pattern: /\brequire\s*\(/, label: 'require' },
  { pattern: /\bBun\s*\./, label: 'Bun' },
  { pattern: /\bprocess\b/, label: 'process' },
  { pattern: /\bDeno\s*\./, label: 'Deno' },
  { pattern: /\bnode:/, label: 'node:' },
  { pattern: /\bchild_process\b/, label: 'child_process' },
  { pattern: /\bfs\/promises\b|\bnode:fs\b|\bfrom\s+['"]fs['"]|\bfs\b/, label: 'fs' },
  { pattern: /\bspawn\s*\(/, label: 'spawn' },
  { pattern: /\bexec(File|Sync)?\s*\(/, label: 'exec' },
  { pattern: /\beval\s*\(/, label: 'eval' },
  { pattern: /\bnew\s+Function\s*\(/, label: 'Function' },
];

export function validateWorkflowScriptSource(source: string): void {
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(source)) {
      throw new WorkflowScriptValidationError(
        `Workflow scripts cannot use ${rule.label}; call the Omakase workflow host API instead.`,
      );
    }
  }
  if (!/\bexport\s+default\b/.test(source)) {
    throw new WorkflowScriptValidationError('Workflow script must export a default async function.');
  }
}
