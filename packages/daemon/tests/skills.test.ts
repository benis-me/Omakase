import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  findSkillById,
  listSkills,
  renderSkillContext,
  selectSkillsForPrompt,
  type SkillRoot,
} from '../src/skills/skills.js';

let projectRoot: string;
let builtinRoot: string;

function writeSkill(root: string, dir: string, frontmatter: string, body: string): void {
  const skillDir = path.join(root, dir);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`);
}

beforeAll(() => {
  projectRoot = mkdtempSync(path.join(os.tmpdir(), 'omakase-skills-proj-'));
  builtinRoot = mkdtempSync(path.join(os.tmpdir(), 'omakase-skills-builtin-'));

  writeSkill(
    projectRoot,
    'tdd',
    ['name: tdd', 'description: Red-green-refactor', 'triggers:', '  - test', '  - tdd', 'roles:', '  - worker'].join('\n'),
    '# TDD\nWrite a failing test first.',
  );
  // Same id as a builtin → project should win.
  writeSkill(projectRoot, 'spec-local', ['name: spec-driven', 'description: project override'].join('\n'), 'project body');

  writeSkill(
    builtinRoot,
    'spec',
    ['name: spec-driven', 'description: builtin spec workflow', 'triggers:', '  - spec'].join('\n'),
    'builtin body',
  );
  writeSkill(
    builtinRoot,
    'security',
    ['name: security-review', 'description: Audit for vulnerabilities', 'triggers:', '  - security', '  - vulnerability'].join('\n'),
    '# Security review',
  );
  // A directory with no SKILL.md is ignored.
  mkdirSync(path.join(builtinRoot, 'not-a-skill'), { recursive: true });
});

function roots(): SkillRoot[] {
  return [
    { dir: projectRoot, source: 'project' },
    { dir: builtinRoot, source: 'builtin' },
  ];
}

describe('listSkills', () => {
  it('discovers skills across roots and parses frontmatter', async () => {
    const skills = await listSkills(roots());
    const ids = skills.map((s) => s.id).sort();
    expect(ids).toContain('tdd');
    expect(ids).toContain('security-review');
    const tdd = findSkillById(skills, 'tdd');
    expect(tdd?.description).toBe('Red-green-refactor');
    expect(tdd?.triggers).toEqual(['test', 'tdd']);
    expect(tdd?.roles).toEqual(['worker']);
    expect(tdd?.body).toContain('Write a failing test first.');
  });

  it('lets the first root shadow a later root on id collision', async () => {
    const skills = await listSkills(roots());
    const spec = findSkillById(skills, 'spec-driven');
    expect(spec?.source).toBe('project');
    expect(spec?.description).toBe('project override');
  });

  it('ignores directories without a SKILL.md and missing roots', async () => {
    const skills = await listSkills([
      { dir: builtinRoot, source: 'builtin' },
      { dir: path.join(os.tmpdir(), 'omakase-does-not-exist-xyz'), source: 'user' },
    ]);
    expect(skills.find((s) => s.id === 'not-a-skill')).toBeUndefined();
    expect(skills.length).toBeGreaterThan(0);
  });
});

describe('selectSkillsForPrompt', () => {
  it('ranks skills by trigger and keyword matches', async () => {
    const skills = await listSkills(roots());
    const selected = selectSkillsForPrompt(skills, 'please run a security audit for vulnerabilities');
    expect(selected[0]?.id).toBe('security-review');
  });

  it('filters by role', async () => {
    const skills = await listSkills(roots());
    const selected = selectSkillsForPrompt(skills, 'write a test', { role: 'worker' });
    expect(selected.map((s) => s.id)).toContain('tdd');
  });

  it('renders selected skills into a context block', async () => {
    const skills = await listSkills(roots());
    const selected = selectSkillsForPrompt(skills, 'tdd test');
    const ctx = renderSkillContext(selected);
    expect(ctx).toContain('# Available skills');
    expect(ctx).toContain('## Skill: tdd');
  });
});
