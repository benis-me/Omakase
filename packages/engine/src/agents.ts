// Agent definitions: named, reusable descriptions of *who* runs a step.
//
// A role used to be a bare string that only picked a paragraph of system prompt,
// so everything else about an agent — which CLI, which model, what it may touch,
// whether it needs its own copy of the tree — had to be repeated at every call
// site, and a self-designed plan could not express any of it at all.
//
// A definition is a markdown file in `.omks/agents/`, the directory the
// workspace has always created and nothing ever read:
//
//   ---
//   name: strict-reviewer
//   description: Reviews against the goal and never edits
//   role: reviewer
//   provider: codex
//   permission: read-only
//   ---
//   Extra guidance appended to this agent's system prompt.
//
// Resolution is explicit-wins, so a definition sets the defaults and the call
// site keeps the last word: `w.agent({ as: 'strict-reviewer', title, prompt })`.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { slugify, type PermissionMode } from '@omakase/core';
import { parseFrontmatter, asString } from './frontmatter.ts';
import type { AgentSpec } from './workflow-types.ts';

export interface AgentDefinition {
  name: string;
  description: string;
  /** Prompt persona this agent adopts (planner/worker/reviewer/...). */
  role?: string;
  provider?: string;
  model?: string;
  permission?: PermissionMode;
  /** Give this agent its own working copy rather than the shared tree. */
  isolate?: boolean;
  /** Body text, appended to the system prompt. */
  guidance: string;
  path: string;
}

const PERMISSIONS = new Set(['read-only', 'edit', 'bypass']);

function truthy(v: string): boolean {
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Read one definition file. Returns null when it has no usable name. */
export function parseAgentDefinition(text: string, path: string): AgentDefinition | null {
  const { data, body } = parseFrontmatter(text);
  // Check the declared name before slugifying: slugify() substitutes a
  // placeholder for empty input, so asking it first would turn every stray
  // README in the directory into an agent called "untitled".
  const declared = asString(data.name).trim();
  if (!declared) return null;
  const name = slugify(declared);
  const permission = asString(data.permission).trim();
  const isolate = asString(data.isolate).trim();
  return {
    name,
    description: asString(data.description),
    ...(asString(data.role) ? { role: asString(data.role) } : {}),
    ...(asString(data.provider) ? { provider: asString(data.provider) } : {}),
    ...(asString(data.model) ? { model: asString(data.model) } : {}),
    ...(PERMISSIONS.has(permission) ? { permission: permission as PermissionMode } : {}),
    ...(isolate ? { isolate: truthy(isolate) } : {}),
    guidance: body.trim(),
    path,
  };
}

/**
 * Every definition in a workspace's `agents/` directory. Unreadable or nameless
 * files are skipped rather than failing a run — a broken definition should cost
 * you that agent's defaults, not the whole workflow.
 */
export function discoverAgents(dir: string): AgentDefinition[] {
  if (!dir || !existsSync(dir)) return [];
  const out: AgentDefinition[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(md|markdown)$/i.test(entry.name)) continue;
    const path = join(dir, entry.name);
    try {
      const def = parseAgentDefinition(readFileSync(path, 'utf8'), path);
      if (def && !out.some((d) => d.name === def.name)) out.push(def);
    } catch {
      /* skip an unreadable definition */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fold a definition into a call. The call site wins every field it states —
 * a definition describes an agent's habits, not a rule it cannot break.
 */
export function applyAgentDefinition(spec: AgentSpec, def: AgentDefinition | undefined): AgentSpec {
  if (!def) return spec;
  const merged: AgentSpec = { ...spec };
  if (spec.role === undefined && def.role) merged.role = def.role;
  if (spec.provider === undefined && def.provider) merged.provider = def.provider;
  if (spec.model === undefined && def.model) merged.model = def.model;
  if (spec.permission === undefined && def.permission) merged.permission = def.permission;
  if (spec.isolate === undefined && def.isolate !== undefined) merged.isolate = def.isolate;
  // Guidance is additive: it sharpens the role's prompt rather than replacing
  // a system prompt the caller went to the trouble of writing.
  if (def.guidance) {
    merged.systemPrompt = spec.systemPrompt
      ? `${spec.systemPrompt}\n\n${def.guidance}`
      : undefined;
    if (!spec.systemPrompt) merged.guidance = def.guidance;
  }
  return merged;
}
