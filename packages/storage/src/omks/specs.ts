/**
 * Specs are first-class authored documents under `.omks/specs/<id>.md`:
 * YAML frontmatter (id/title/phase/status/tags/timestamps) + a markdown body
 * holding the spec itself (summary, acceptance criteria, plan, test strategy).
 * The file is the source of truth; the spec-mode loop reads/advances it.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SpecPhase } from '@omakase/core';
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
}

const VALID_PHASES: readonly SpecPhase[] = ['idea', 'spec', 'acceptance', 'test-plan', 'tasks', 'done'];
const VALID_STATUS: readonly SpecStatus[] = ['draft', 'ready', 'running', 'done', 'archived'];

const specFile = (root: string, id: string): string => path.join(specsDir(root), `${id}.md`);

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
