/**
 * Skill discovery. Scans one or more roots for `<dir>/SKILL.md` files, parses
 * their frontmatter, and returns a de-duplicated listing. Roots are given in
 * priority order: the first root to surface a given id wins, so a project-level
 * skill can shadow a built-in of the same name without deleting it.
 *
 * Skills are the prompt/context-injection source the core uses to specialise
 * router/planner/worker/reviewer roles.
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  parseFrontmatter,
  type FrontmatterData,
  type FrontmatterValue,
} from './frontmatter.js';

export type SkillSource = 'project' | 'user' | 'builtin';

export interface SkillRoot {
  dir: string;
  source: SkillSource;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  /** The SKILL.md body (everything after the frontmatter). */
  body: string;
  triggers: string[];
  /** Roles this skill applies to (frontmatter `roles:` / `omakase.roles:`). */
  roles: string[];
  source: SkillSource;
  /** The root directory the skill was discovered under. */
  root: string;
  /** The skill's own directory. */
  dir: string;
  frontmatter: FrontmatterData;
}

function asString(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

function normalizeRoots(roots: string | readonly (string | SkillRoot)[]): SkillRoot[] {
  const list = typeof roots === 'string' ? [roots] : [...roots];
  return list.map((root, index): SkillRoot => {
    if (typeof root === 'string') {
      // Bare strings default by position: project, then user, then builtin.
      const source: SkillSource = index === 0 ? 'project' : index === 1 ? 'user' : 'builtin';
      return { dir: root, source };
    }
    return root;
  });
}

async function readSkillDir(
  root: SkillRoot,
  entry: Dirent,
): Promise<SkillInfo | null> {
  const dir = path.join(root.dir, entry.name);
  const skillPath = path.join(dir, 'SKILL.md');
  try {
    const stats = await stat(skillPath);
    if (!stats.isFile()) return null;
  } catch {
    return null;
  }
  const raw = await readFile(skillPath, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  const omakase = (data.omakase && typeof data.omakase === 'object' && !Array.isArray(data.omakase)
    ? (data.omakase as FrontmatterData)
    : {}) as FrontmatterData;
  const id = asString(data.name) || entry.name;
  return {
    id,
    name: asString(data.name) || entry.name,
    description: asString(data.description) ?? '',
    body: body.trim(),
    triggers: asStringArray(data.triggers),
    roles: [...asStringArray(data.roles), ...asStringArray(omakase.roles)],
    source: root.source,
    root: root.dir,
    dir,
    frontmatter: data,
  };
}

/**
 * List skills across roots. The first root to surface a given id wins; later
 * roots only contribute ids not already seen.
 */
export async function listSkills(
  roots: string | readonly (string | SkillRoot)[],
): Promise<SkillInfo[]> {
  const normalized = normalizeRoots(roots);
  const out: SkillInfo[] = [];
  const seen = new Set<string>();
  for (const root of normalized) {
    if (!root.dir) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      let info: SkillInfo | null;
      try {
        info = await readSkillDir(root, entry);
      } catch {
        info = null;
      }
      if (!info || seen.has(info.id)) continue;
      seen.add(info.id);
      out.push(info);
    }
  }
  return out;
}

export function findSkillById(
  skills: readonly SkillInfo[],
  id: string,
): SkillInfo | undefined {
  return skills.find((skill) => skill.id === id);
}

export interface SkillSelectionOptions {
  /** Restrict to skills that declare this role (or no role at all). */
  role?: string;
  /** Cap the number of selected skills (highest match score first). */
  limit?: number;
  /** Include skills with matching role even if no trigger matched (default true). */
  includeRoleMatches?: boolean;
}

/**
 * Select skills relevant to a prompt. A skill matches when one of its triggers
 * (or words from its name/description) appears in the prompt, or when its role
 * matches the requested role. Returned highest-scoring first.
 */
export function selectSkillsForPrompt(
  skills: readonly SkillInfo[],
  prompt: string,
  options: SkillSelectionOptions = {},
): SkillInfo[] {
  const haystack = prompt.toLowerCase();
  const includeRoleMatches = options.includeRoleMatches ?? true;
  const scored: Array<{ skill: SkillInfo; score: number }> = [];

  for (const skill of skills) {
    if (options.role && skill.roles.length > 0 && !skill.roles.includes(options.role)) {
      continue;
    }
    let score = 0;
    for (const trigger of skill.triggers) {
      if (trigger && haystack.includes(trigger.toLowerCase())) score += 2;
    }
    const nameWords = `${skill.name} ${skill.description}`.toLowerCase().split(/\W+/);
    for (const word of nameWords) {
      if (word.length >= 4 && haystack.includes(word)) score += 1;
    }
    const roleMatch = options.role ? skill.roles.includes(options.role) : false;
    if (roleMatch && includeRoleMatches) score += 2;
    if (score > 0) scored.push({ skill, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const selected = scored.map((s) => s.skill);
  return options.limit ? selected.slice(0, options.limit) : selected;
}

/** Render selected skills into a prompt-injectable context block. */
export function renderSkillContext(skills: readonly SkillInfo[]): string {
  if (skills.length === 0) return '';
  const sections = skills.map((skill) => {
    const header = `## Skill: ${skill.name}`;
    const desc = skill.description ? `\n${skill.description}` : '';
    return `${header}${desc}\n\n${skill.body}`.trim();
  });
  return `# Available skills\n\n${sections.join('\n\n---\n\n')}`;
}
