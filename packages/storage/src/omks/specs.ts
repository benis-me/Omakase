/**
 * Specs are first-class authored documents under `.omks/specs/<id>.md`:
 * YAML frontmatter (id/title/phase/status/tags/timestamps) + a markdown body
 * holding the spec itself (summary, acceptance criteria, plan, test strategy).
 * The file is the source of truth; the spec-mode loop reads/advances it.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SpecPhase, SpecTransition } from '@omakase/core';
import { specsDir } from './workspace.js';
import {
  asNumber,
  asString,
  asStringArray,
  parseFrontmatter,
  stringifyFrontmatter,
  type FrontmatterDoc,
} from './frontmatter.js';
import { slugId } from './slug.js';

export type SpecStatus = 'draft' | 'ready' | 'running' | 'done' | 'archived';

export interface SpecDoc {
  id: string;
  title: string;
  phase: SpecPhase;
  status: SpecStatus;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  body: string;
  /** Structured phase artifacts (the SpecWorkflow's idea=title, spec=body live implicitly). */
  acceptanceCriteria: string[];
  testPlan: string[];
  tasks: string[];
  /** Audit log of phase transitions, mirroring SpecWorkflow.history. */
  history: SpecTransition[];
}

const VALID_PHASES: readonly SpecPhase[] = ['idea', 'spec', 'acceptance', 'test-plan', 'tasks', 'done'];
const VALID_STATUS: readonly SpecStatus[] = ['draft', 'ready', 'running', 'done', 'archived'];

const specFile = (root: string, id: string): string => path.join(specsDir(root), `${id}.md`);

/**
 * Coerce a hand-editable `history` frontmatter value into well-formed transitions:
 * keep only objects whose `from`/`to` are valid phases and whose `at` is numeric.
 */
function asTransitions(value: unknown): SpecTransition[] {
  if (!Array.isArray(value)) return [];
  const out: SpecTransition[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { from, to, at } = entry as { from?: unknown; to?: unknown; at?: unknown };
    if (typeof from !== 'string' || !VALID_PHASES.includes(from as SpecPhase)) continue;
    if (typeof to !== 'string' || !VALID_PHASES.includes(to as SpecPhase)) continue;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    out.push({ from: from as SpecPhase, to: to as SpecPhase, at });
  }
  return out;
}

function coerceSpec(id: string, doc: FrontmatterDoc): SpecDoc {
  const phase = asString(doc.data.phase) as SpecPhase;
  const status = asString(doc.data.status) as SpecStatus;
  return {
    id,
    title: asString(doc.data.title, id),
    phase: VALID_PHASES.includes(phase) ? phase : 'idea',
    status: VALID_STATUS.includes(status) ? status : 'draft',
    tags: asStringArray(doc.data.tags),
    createdAt: asNumber(doc.data.createdAt),
    updatedAt: asNumber(doc.data.updatedAt),
    body: doc.body,
    acceptanceCriteria: asStringArray(doc.data.acceptanceCriteria),
    testPlan: asStringArray(doc.data.testPlan),
    tasks: asStringArray(doc.data.tasks),
    history: asTransitions(doc.data.history),
  };
}

export function listSpecs(root: string): SpecDoc[] {
  let entries: string[];
  try {
    entries = readdirSync(specsDir(root));
  } catch {
    return [];
  }
  const specs: SpecDoc[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const spec = readSpec(root, entry.slice(0, -'.md'.length));
    if (spec) specs.push(spec);
  }
  return specs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readSpec(root: string, id: string): SpecDoc | null {
  try {
    return coerceSpec(id, parseFrontmatter(readFileSync(specFile(root, id), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Acceptance criteria of a spec: its structured frontmatter list, or — for a raw
 * agent-authored spec with no frontmatter — the bullet lines under the
 * `## Acceptance criteria` heading (checkboxes included).
 */
export function extractAcceptanceCriteria(spec: SpecDoc): string[] {
  if (spec.acceptanceCriteria.length) return spec.acceptanceCriteria;
  const out: string[] = [];
  let inAcceptance = false;
  for (const line of spec.body.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) inAcceptance = /acceptance/i.test(line);
    if (!inAcceptance) continue;
    const m = line.match(/^\s*[-*]\s*(?:\[[ xX]?\]\s*)?(.+)$/);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

/**
 * Acceptance criteria of every spec file modified at or after `sinceMs` — i.e.
 * specs authored or edited during a run. Detection is by file mtime because a raw
 * agent-authored spec carries no frontmatter `updatedAt`.
 */
export function authoredSpecCriteriaSince(root: string, sinceMs: number): string[] {
  let files: string[];
  try {
    files = readdirSync(specsDir(root)).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const file of files) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path.join(specsDir(root), file)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < sinceMs) continue;
    const spec = readSpec(root, file.slice(0, -'.md'.length));
    if (spec) out.push(...extractAcceptanceCriteria(spec));
  }
  return out;
}

export function writeSpec(root: string, spec: SpecDoc): void {
  mkdirSync(specsDir(root), { recursive: true });
  writeFileSync(
    specFile(root, spec.id),
    stringifyFrontmatter(
      {
        id: spec.id,
        title: spec.title,
        phase: spec.phase,
        status: spec.status,
        tags: spec.tags,
        createdAt: spec.createdAt,
        updatedAt: spec.updatedAt,
        acceptanceCriteria: spec.acceptanceCriteria,
        testPlan: spec.testPlan,
        tasks: spec.tasks,
        history: spec.history.map((h) => ({ from: h.from, to: h.to, at: h.at })),
      },
      spec.body,
    ),
    'utf8',
  );
}

export interface CreateSpecInput {
  title: string;
  body?: string;
  phase?: SpecPhase;
  status?: SpecStatus;
  tags?: string[];
  now?: number;
}

export function createSpec(root: string, input: CreateSpecInput): SpecDoc {
  const now = input.now ?? Date.now();
  const spec: SpecDoc = {
    id: slugId(input.title),
    title: input.title,
    phase: input.phase ?? 'idea',
    status: input.status ?? 'draft',
    tags: input.tags ?? [],
    createdAt: now,
    updatedAt: now,
    body: input.body ?? defaultSpecBody(input.title),
    acceptanceCriteria: [],
    testPlan: [],
    tasks: [],
    history: [],
  };
  writeSpec(root, spec);
  return spec;
}

export function deleteSpec(root: string, id: string): void {
  rmSync(specFile(root, id), { force: true });
}

function defaultSpecBody(title: string): string {
  return `# ${title}

## Summary

_One paragraph: what we are building and why._

## Acceptance criteria

- [ ] _A testable behavioral assertion that defines done._

## Implementation plan

1. _First slice._

## Test strategy

_How completion is verified objectively._
`;
}
