import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { detectStack } from './detect-stack.js';

function ws(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'stack-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}
const pkg = (deps: Record<string, string>): string => JSON.stringify({ dependencies: deps });

describe('detectStack', () => {
  it('picks the framework over the bundler over the view library', () => {
    expect(detectStack(ws({ 'package.json': pkg({ next: '14', react: '18' }) }))).toBe('Next.js');
    expect(detectStack(ws({ 'package.json': pkg({ vite: '5', react: '18' }) }))).toBe('Vite');
    expect(detectStack(ws({ 'package.json': pkg({ react: '18' }) }))).toBe('React');
    expect(detectStack(ws({ 'package.json': pkg({ '@remix-run/node': '2' }) }))).toBe('Remix');
    expect(detectStack(ws({ 'package.json': pkg({ electron: '30' }) }))).toBe('Electron');
  });

  it('falls back to Node for a plain package.json', () => {
    expect(detectStack(ws({ 'package.json': pkg({ lodash: '4' }) }))).toBe('Node');
  });

  it('detects non-JS stacks from their marker files', () => {
    expect(detectStack(ws({ 'Cargo.toml': '[package]' }))).toBe('Rust');
    expect(detectStack(ws({ 'go.mod': 'module x' }))).toBe('Go');
    expect(detectStack(ws({ 'pyproject.toml': '' }))).toBe('Python');
    expect(detectStack(ws({ Dockerfile: 'FROM node' }))).toBe('Docker');
    expect(detectStack(ws({ 'pubspec.yaml': '' }))).toBe('Flutter');
  });

  it('returns undefined for an unrecognized folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-'));
    mkdirSync(join(root, 'src'));
    expect(detectStack(root)).toBeUndefined();
  });
});
