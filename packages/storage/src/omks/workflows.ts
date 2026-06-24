/**
 * Dynamic workflow scripts under `.omks/workflows/<id>.ts`. Each file is a
 * self-contained orchestration script (the `agent()/phase()/parallel()` API
 * executed by core's dynamic-workflow runner). The filename stem is the id.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { workflowsDir } from './workspace.js';
import { slugify } from './slug.js';

export interface WorkflowDoc {
  id: string;
  name: string;
  source: string;
  path: string;
}

const workflowFile = (root: string, id: string): string =>
  path.join(workflowsDir(root), `${id}.ts`);

export function listWorkflows(root: string): WorkflowDoc[] {
  let entries: string[];
  try {
    entries = readdirSync(workflowsDir(root));
  } catch {
    return [];
  }
  const workflows: WorkflowDoc[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;
    const workflow = readWorkflow(root, entry.slice(0, -'.ts'.length));
    if (workflow) workflows.push(workflow);
  }
  return workflows.sort((a, b) => a.name.localeCompare(b.name));
}

export function readWorkflow(root: string, id: string): WorkflowDoc | null {
  try {
    const source = readFileSync(workflowFile(root, id), 'utf8');
    return { id, name: workflowName(source) ?? id, source, path: workflowFile(root, id) };
  } catch {
    return null;
  }
}

export function writeWorkflow(root: string, id: string, source: string): void {
  mkdirSync(workflowsDir(root), { recursive: true });
  writeFileSync(workflowFile(root, id), source, 'utf8');
}

export function createWorkflow(root: string, name: string, source?: string): WorkflowDoc {
  const id = slugify(name);
  const body = source ?? defaultWorkflowSource(name);
  writeWorkflow(root, id, body);
  return { id, name, source: body, path: workflowFile(root, id) };
}

export function deleteWorkflow(root: string, id: string): void {
  rmSync(workflowFile(root, id), { force: true });
}

/** Pull a human name from a leading `// name: X` or `/** name * /` hint. */
function workflowName(source: string): string | null {
  const match = /^\s*\/\/\s*name:\s*(.+)$/m.exec(source);
  return match ? match[1].trim() : null;
}

function defaultWorkflowSource(name: string): string {
  return `// name: ${name}
// A dynamic workflow: deterministic multi-agent orchestration.
// See the docs for the agent()/phase()/parallel()/checkpoint() API.

phase('Plan');
const plan = await agent('Outline the steps for: ${name}');

phase('Execute');
await agent(\`Carry out the plan:\\n\${plan}\`);
`;
}
