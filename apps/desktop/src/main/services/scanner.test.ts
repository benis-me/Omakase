import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyScript, scanWorkspace } from './scanner.js';

describe('classifyScript', () => {
  it('separates long-running from one-shot scripts', () => {
    expect(classifyScript('dev', 'vite')).toBe('long-running');
    expect(classifyScript('start', 'next start')).toBe('long-running');
    expect(classifyScript('watch', 'tsc -w')).toBe('long-running');
    expect(classifyScript('build', 'vite build')).toBe('one-shot');
    expect(classifyScript('test', 'vitest run')).toBe('one-shot');
  });
});

describe('scanWorkspace', () => {
  it('detects package.json scripts, env files, and project type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-scan-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { dev: 'vite', build: 'vite build' } }),
    );
    writeFileSync(join(dir, '.env'), 'X=1');
    writeFileSync(join(dir, '.env.local'), 'Y=2');

    const projects = await scanWorkspace(dir);
    expect(projects).toHaveLength(1);
    const project = projects[0];
    expect(project.rel).toBe('.');
    expect(project.name).toBe('demo');
    expect(project.type).toBe('Vite');
    expect(project.scripts.map((s) => s.name).sort()).toEqual(['build', 'dev']);

    const dev = project.scripts.find((s) => s.name === 'dev');
    expect(dev?.id).toBe('.::dev');
    expect(dev?.kind).toBe('long-running');
    expect(dev?.cwd).toBe(dir);
    expect(project.envFiles).toEqual(['.env', '.env.local']);
  });

  it('detects monorepo packages via pnpm-workspace.yaml', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-mono-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', scripts: { 'build:all': 'turbo build' } }),
    );
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'a', 'package.json'),
      JSON.stringify({ name: 'pkg-a', scripts: { test: 'vitest' } }),
    );

    const projects = await scanWorkspace(dir);
    const rels = projects.map((p) => p.rel);
    expect(rels).toContain('.');
    expect(rels).toContain('packages/a');
    const a = projects.find((p) => p.rel === 'packages/a');
    expect(a?.scripts[0]?.id).toBe('packages/a::test');
  });
});
