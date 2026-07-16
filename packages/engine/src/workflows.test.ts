import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@omakase/core';
import { discoverWorkflows, findWorkflow, loadWorkflow } from './workflows.ts';

test('workspace workflows override built-ins; folder + flat both load', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omks-wf-'));
  const ws = Workspace.init(dir);
  try {
    // Flat override of the built-in "goal".
    writeFileSync(
      join(ws.paths.workflows, 'goal.ts'),
      '// name: goal\n// description: my override\n// version: 9.9.9\nexport default async function goal() {}\n',
    );

    // A skills-like folder workflow.
    const custom = join(ws.paths.workflows, 'custom');
    mkdirSync(custom, { recursive: true });
    writeFileSync(
      join(custom, 'WORKFLOW.md'),
      ['---', 'name: custom', 'description: a custom flow', 'version: 2.0.0', 'allowed-providers: [claude, codex]', '---', '', '# How it works', 'It does the thing.'].join('\n'),
    );
    writeFileSync(join(custom, 'workflow.ts'), 'export default async function custom() {}\n');

    const metas = discoverWorkflows({ workspace: ws.paths.workflows });
    const goal = metas.find((m) => m.name === 'goal');
    expect(goal?.scope).toBe('workspace');
    expect(goal?.version).toBe('9.9.9');

    const c = findWorkflow('custom', { workspace: ws.paths.workflows });
    expect(c).toBeTruthy();
    expect(c!.version).toBe('2.0.0');
    expect(c!.allowedProviders).toEqual(['claude', 'codex']);

    const loaded = await loadWorkflow(c!);
    expect(typeof loaded.fn).toBe('function');
    expect(loaded.body).toContain('How it works');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
