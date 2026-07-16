import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { discoverWorkflows, findWorkflow, loadWorkflow, runGoal, MockHarness, type WorkflowMeta } from '@omakase/engine';
import { Store, slugify } from '@omakase/core';
import { createEventRenderer } from '../ui.ts';
import { parseArgs, flagBool, flagStr, type ParsedArgs } from '../args.ts';
import { openOrInit } from './shared.ts';
import { openContext, tryOpenContext } from '../context.ts';
import { cmdRun } from './run.ts';
import { print, printErr, c, sym } from '../ui.ts';

/** Read-only discover dirs — tolerant of running outside a workspace. */
function discoverDirs() {
  const ctx = tryOpenContext();
  return ctx ? { workspace: ctx.workspace.paths.workflows } : {};
}

export async function cmdWorkflow(rawArgs: string[]): Promise<number> {
  const sub = rawArgs[0];
  const rest = rawArgs.slice(1);
  switch (sub) {
    case undefined:
    case 'list':
    case 'ls':
      return listWorkflows();
    case 'show':
    case 'view':
      return showWorkflow(parseArgs(rest, {}));
    case 'new':
    case 'create':
      return newWorkflow(parseArgs(rest, { alias: {} }));
    case 'run':
      return runWorkflow(rest);
    case 'test':
      return testWorkflow(rest);
    case 'edit':
    case 'path':
      return editWorkflow(parseArgs(rest, {}));
    case 'version':
      return versionWorkflow(parseArgs(rest, { value: ['bump'] }));
    default:
      printErr(`Unknown workflow command: ${sub}. Try: list, show, new, run, edit, version`);
      return 1;
  }
}

function dirs() {
  const ws = openContext().workspace;
  return { ws, dirs: { workspace: ws.paths.workflows } };
}

function listWorkflows(): number {
  const metas = discoverWorkflows(discoverDirs());
  print(c.bold('\nWorkflows') + c.dim(`  (${metas.length})`));
  const nameW = Math.max(8, ...metas.map((m) => m.name.length));
  for (const m of metas) {
    const scope = m.scope === 'builtin' ? c.dim('built-in') : c.green('workspace');
    print(
      `  ${c.cyan(m.name.padEnd(nameW))}  ${c.dim('v' + m.version)}  ${scope}\n` +
        `  ${' '.repeat(nameW)}  ${c.dim(m.description.slice(0, 80))}`,
    );
  }
  print(c.dim(`\nRun one:  omks run "<goal>" --workflow <name>`));
  return 0;
}

function showWorkflow(args: ParsedArgs): number {
  const name = args.positionals[0];
  if (!name) return usage('omks workflow show <name>');
  const meta = findWorkflow(name, discoverDirs());
  if (!meta) return notFound(name);
  print(`\n${c.bold(c.cyan(meta.name))} ${c.dim('v' + meta.version)}  ${meta.scope === 'builtin' ? c.dim('built-in') : c.green('workspace')}`);
  print(`  ${meta.description}`);
  if (meta.whenToUse) print(`  ${c.dim('When:')} ${meta.whenToUse}`);
  if (meta.allowedProviders.length) print(`  ${c.dim('Providers:')} ${meta.allowedProviders.join(', ')}`);
  print(`  ${c.dim('Entry:')} ${meta.entry}`);
  if (meta.docPath) {
    const body = readFileSync(meta.docPath, 'utf8').split('---').slice(2).join('---').trim();
    if (body) print(`\n${body}`);
  }
  return 0;
}

function newWorkflow(args: ParsedArgs): number {
  const rawName = args.positionals[0];
  if (!rawName) return usage('omks workflow new <name> [--flat]');
  const name = slugify(rawName);
  const { ws } = dirs();
  mkdirSync(ws.paths.workflows, { recursive: true });
  const flat = flagBool(args, 'flat');
  const fnName = name.replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());

  if (flat) {
    const file = join(ws.paths.workflows, `${name}.ts`);
    if (existsSync(file)) return exists(file);
    writeFileSync(file, flatTemplate(name, fnName));
    print(`${sym.ok} Created workflow ${c.cyan(name)}\n  ${c.dim(file)}`);
  } else {
    const dir = join(ws.paths.workflows, name);
    if (existsSync(dir)) return exists(dir);
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'WORKFLOW.md'), docTemplate(name));
    writeFileSync(join(dir, 'workflow.ts'), folderTemplate(fnName));
    print(`${sym.ok} Created workflow ${c.cyan(name)}\n  ${c.dim(join(dir, 'WORKFLOW.md'))}\n  ${c.dim(join(dir, 'workflow.ts'))}`);
  }
  print(c.dim(`\nEdit it, then run:  omks run "<goal>" --workflow ${name}`));
  return 0;
}

async function runWorkflow(rest: string[]): Promise<number> {
  const name = rest[0];
  if (!name) return usage('omks workflow run <name> "<goal>"');
  return cmdRun(rest.slice(1), { workflow: name });
}

/** Dry-run a workflow with a deterministic mock harness — no cost, no providers. */
async function testWorkflow(rest: string[]): Promise<number> {
  const name = rest[0];
  if (!name) return usage('omks workflow test <name> ["<goal>"]');
  const ctx = tryOpenContext();
  const workspace = ctx?.workspace;
  if (!workspace) {
    printErr(c.red('Run inside a workspace (omks init) to test workflows.'));
    return 1;
  }
  const meta = findWorkflow(name, { workspace: workspace.paths.workflows });
  if (!meta) return notFound(name);

  const goalText = rest.slice(1).join(' ').trim() || 'test goal';
  const store = new Store(':memory:'); // never persisted
  const harness = new MockHarness();
  print(`${sym.arrow} ${c.bold('test')} ${c.cyan(name)} ${c.dim('· mock harness, no cost')}\n`);
  const render = createEventRenderer();
  const outcome = await runGoal({
    goal: { text: goalText, workflow: name, cwd: workspace.root },
    workspace,
    store,
    harness,
    onEvent: (e) => {
      const line = render(e);
      if (line !== null) print(line);
    },
  });
  store.close();
  print(
    `\n${outcome.status === 'succeeded' ? sym.ok : c.red('✗')} workflow ${c.cyan(name)} ran ${c.bold(String(harness.calls.length))} agent step(s) — ${outcome.status}`,
  );
  return outcome.status === 'failed' ? 1 : 0;
}

function editWorkflow(args: ParsedArgs): number {
  const name = args.positionals[0];
  if (!name) return usage('omks workflow edit <name>');
  const meta = findWorkflow(name, discoverDirs());
  if (!meta) return notFound(name);
  print(meta.entry); // print path so `$(omks workflow edit x)` opens it
  return 0;
}

function versionWorkflow(args: ParsedArgs): number {
  const name = args.positionals[0];
  if (!name) return usage('omks workflow version <name> [--bump patch|minor|major]');
  const ws = openContext().workspace;
  const meta = findWorkflow(name, { workspace: ws.paths.workflows });
  if (!meta) return notFound(name);
  const bump = flagStr(args, 'bump');
  if (!bump) {
    print(`${c.cyan(meta.name)} ${c.bold('v' + meta.version)} ${c.dim(`(${listVersions(ws.paths.workflows, name).join(', ') || 'no snapshots'})`)}`);
    return 0;
  }
  if (meta.scope === 'builtin') {
    printErr(c.red('Cannot version a built-in workflow. Create a workspace copy first.'));
    return 1;
  }
  // bumpVersion falls through to a patch bump for anything it doesn't recognise,
  // so an unvalidated typo would silently persist the wrong version.
  if (bump !== 'patch' && bump !== 'minor' && bump !== 'major') {
    printErr(c.red(`Invalid --bump "${bump}".`) + c.dim('  Use: patch, minor, major'));
    return 1;
  }
  const next = bumpVersion(meta.version, bump);
  // Snapshot the current entry, then rewrite the version in place.
  const snapDir = join(ws.paths.workflows, '.versions');
  mkdirSync(snapDir, { recursive: true });
  copyFileSync(meta.entry, join(snapDir, `${name}@${meta.version}.ts`));
  rewriteVersion(meta, next);
  print(`${sym.ok} ${c.cyan(name)} ${c.dim('v' + meta.version)} ${c.dim('→')} ${c.bold('v' + next)}  ${c.dim('(snapshot saved)')}`);
  return 0;
}

// --- helpers ---------------------------------------------------------------

function listVersions(workflowsDir: string, name: string): string[] {
  const snapDir = join(workflowsDir, '.versions');
  if (!existsSync(snapDir)) return [];
  return readdirSync(snapDir)
    .filter((f) => f.startsWith(`${name}@`))
    .map((f) => f.replace(`${name}@`, '').replace(/\.ts$/, ''));
}

function bumpVersion(v: string, kind: 'patch' | 'minor' | 'major'): string {
  const [maj = 0, min = 0, pat = 0] = v.split('.').map((n) => parseInt(n, 10) || 0);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function rewriteVersion(meta: WorkflowMeta, next: string): void {
  if (meta.docPath && existsSync(meta.docPath)) {
    const md = readFileSync(meta.docPath, 'utf8').replace(/^version:.*$/m, `version: ${next}`);
    writeFileSync(meta.docPath, md);
  } else {
    const src = readFileSync(meta.entry, 'utf8').replace(/^\/\/\s*version:.*$/m, `// version: ${next}`);
    writeFileSync(meta.entry, src);
  }
}

function flatTemplate(name: string, fnName: string): string {
  return `// name: ${name}
// description: Describe what this workflow does and when to use it.
// version: 0.1.0
// when_to_use: When ...
import type { WorkflowContext } from '@omakase/engine';

export default async function ${fnName}(w: WorkflowContext): Promise<void> {
  // The whole \`w\` orchestration API is available:
  //   w.phase(name, fn) · w.agent({role,title,prompt}) · w.parallel([...])
  //   w.pipeline(items, ...stages) · w.loopUntil(fn, {maxRounds})
  //   w.budget() · w.log(msg) · w.goalMet() · w.requestReport(...) · w.updateWiki(...)
  const res = await w.agent({ role: 'worker', title: 'Do the task', prompt: w.goal.text });
  w.requestReport({ kind: 'final', title: 'Done', summary: res.text.slice(0, 300) });
}
`;
}

function folderTemplate(fnName: string): string {
  return `import type { WorkflowContext } from '@omakase/engine';

export default async function ${fnName}(w: WorkflowContext): Promise<void> {
  const res = await w.agent({ role: 'worker', title: 'Do the task', prompt: w.goal.text });
  w.requestReport({ kind: 'final', title: 'Done', summary: res.text.slice(0, 300) });
}
`;
}

function docTemplate(name: string): string {
  return `---
name: ${name}
description: Describe what this workflow does AND when to use it.
version: 0.1.0
when_to_use: When ...
allowed-providers: []
---

# ${name}

Explain the workflow here — its phases, when it shines, and any inputs it expects
via \`w.params\`. This body is progressive-disclosure L2: loaded only when the
workflow is selected.
`;
}

function usage(u: string): number {
  printErr(`Usage: ${c.cyan(u)}`);
  return 1;
}
function notFound(name: string): number {
  printErr(c.red(`No such workflow: ${name}`) + c.dim('  (omks workflow list)'));
  return 1;
}
function exists(path: string): number {
  printErr(c.yellow(`Already exists: ${path}`));
  return 1;
}
