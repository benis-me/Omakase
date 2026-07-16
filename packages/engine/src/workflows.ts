// Workflow discovery, metadata (L1) and loading. Workflows live either as a
// flat `<name>.ts` file or as a skills-like folder `<name>/` with WORKFLOW.md
// (frontmatter + body) and workflow.ts. Built-ins ship with the engine;
// workspace workflows live in `.omks/workflows/` and accumulate over time.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter, parseCommentMeta, asString, asStringArray } from './frontmatter.ts';
import type { WorkflowFn } from './workflow-types.ts';
import { BUILTINS } from './builtins/registry.ts';

export type WorkflowScope = 'builtin' | 'workspace';

export interface WorkflowMeta {
  name: string;
  description: string;
  version: string;
  whenToUse: string;
  allowedProviders: string[];
  scope: WorkflowScope;
  /** Absolute path to the executable module (the .ts with the default export). */
  entry: string;
  /** Absolute path to WORKFLOW.md, if any. */
  docPath: string | null;
  /** True => must be human-triggered, never auto-selected. */
  disableModelInvocation: boolean;
  /** In-memory function for bundled built-ins (works in a compiled binary). */
  fn?: WorkflowFn;
}

export interface LoadedWorkflow extends WorkflowMeta {
  fn: WorkflowFn;
  /** The markdown body / guidance (L2). */
  body: string;
}

export const BUILTIN_DIR = join(import.meta.dir, 'builtins');

function isWorkflowFile(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts');
}

function metaFromFlat(entry: string, scope: WorkflowScope): WorkflowMeta {
  const text = readFileSync(entry, 'utf8');
  const cm = parseCommentMeta(text);
  const base = entry.split('/').pop()!.replace(/\.ts$/, '');
  return {
    name: asString(cm.name, base) || base,
    description: asString(cm.description) || firstDocComment(text) || base,
    version: asString(cm.version, '0.1.0'),
    whenToUse: asString(cm.when_to_use ?? cm.whenToUse),
    allowedProviders: asStringArray(cm['allowed-providers'] ?? cm.allowedProviders),
    scope,
    entry,
    docPath: null,
    disableModelInvocation:
      cm['disable-model-invocation'] === true || cm.disableModelInvocation === true,
  };
}

function metaFromFolder(dir: string, scope: WorkflowScope): WorkflowMeta | null {
  const entry = join(dir, 'workflow.ts');
  if (!existsSync(entry)) return null;
  const base = dir.split('/').pop()!;
  const docPath = join(dir, 'WORKFLOW.md');
  let data: Record<string, unknown> = {};
  if (existsSync(docPath)) data = parseFrontmatter(readFileSync(docPath, 'utf8')).data;
  return {
    name: asString(data.name as never, base) || base,
    description: asString(data.description as never) || base,
    version: asString(data.version as never, '0.1.0'),
    whenToUse: asString((data.when_to_use ?? data.whenToUse) as never),
    allowedProviders: asStringArray((data['allowed-providers'] ?? data.allowedProviders) as never),
    scope,
    entry,
    docPath: existsSync(docPath) ? docPath : null,
    disableModelInvocation: (data['disable-model-invocation'] as boolean) === true,
  };
}

function firstDocComment(text: string): string {
  for (const line of text.split('\n')) {
    const m = /^\s*\/\/\s*(.+)$/.exec(line);
    if (m && !/^[a-z0-9_-]+:/i.test(m[1]!)) return m[1]!.trim();
    if (line.trim() && !line.trim().startsWith('//')) break;
  }
  return '';
}

/** Scan one directory for workflows (flat files and folders). */
export function scanDir(dir: string, scope: WorkflowScope): WorkflowMeta[] {
  if (!existsSync(dir)) return [];
  const out: WorkflowMeta[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const meta = metaFromFolder(full, scope);
      if (meta) out.push(meta);
    } else if (isWorkflowFile(name)) {
      out.push(metaFromFlat(full, scope));
    }
  }
  return out;
}

export interface DiscoverDirs {
  builtin?: string;
  workspace?: string | null;
}

/**
 * Discover all workflows. Workspace workflows shadow built-ins of the same name
 * (letting a project customize a workflow). Returns L1 metadata only.
 */
export function discoverWorkflows(dirs: DiscoverDirs = {}): WorkflowMeta[] {
  const builtin: WorkflowMeta[] = BUILTINS.map((b) => ({
    name: b.name,
    description: b.description,
    version: b.version,
    whenToUse: b.whenToUse,
    allowedProviders: [],
    scope: 'builtin',
    entry: join(BUILTIN_DIR, `${b.name}.ts`),
    docPath: null,
    disableModelInvocation: false,
    fn: b.fn,
  }));
  const workspace = dirs.workspace ? scanDir(dirs.workspace, 'workspace') : [];
  const byName = new Map<string, WorkflowMeta>();
  for (const m of builtin) byName.set(m.name, m);
  for (const m of workspace) byName.set(m.name, m); // workspace overrides
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findWorkflow(name: string, dirs: DiscoverDirs = {}): WorkflowMeta | null {
  return discoverWorkflows(dirs).find((m) => m.name === name) ?? null;
}

/** Load a workflow's executable function and body. */
export async function loadWorkflow(meta: WorkflowMeta): Promise<LoadedWorkflow> {
  // Bundled built-ins carry their function in-memory (compiled-binary safe).
  let fn: unknown = meta.fn;
  if (typeof fn !== 'function') {
    const mod = (await import(meta.entry)) as { default?: unknown };
    fn = mod.default;
  }
  if (typeof fn !== 'function') {
    throw new Error(`Workflow "${meta.name}" (${meta.entry}) has no default-exported function`);
  }
  let body = '';
  if (meta.docPath && existsSync(meta.docPath)) {
    body = parseFrontmatter(readFileSync(meta.docPath, 'utf8')).body;
  }
  return { ...meta, fn: fn as WorkflowFn, body };
}
