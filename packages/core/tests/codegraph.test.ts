import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CodeGraph, loadTsconfigAliases } from '../src/knowledge/codegraph.js';

let root: string;

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'omakase-cg-'));
});

describe('CodeGraph', () => {
  it('extracts imports, exports, symbols, and resolves internal edges', async () => {
    write('src/a.ts', `import { b } from './b.js';\nexport const a = 1;\nexport function fa() { return b; }\n`);
    write('src/b.ts', `export const b = 2;\nexport interface Thing { x: number }\n`);
    write('src/c.ts', `import fs from 'node:fs';\nimport { a } from './a.js';\nexport class C {}\nvoid fs; void a;\n`);

    const graph = await CodeGraph.scan({ root });
    expect(graph.size).toBe(3);

    const a = graph.node('src/a.ts');
    expect(a?.exports.sort()).toEqual(['a', 'fa']);
    expect(a?.symbols.map((s) => s.name).sort()).toEqual(['a', 'fa']);

    expect(graph.dependencies('src/a.ts')).toEqual(['src/b.ts']);
    expect(graph.dependents('src/b.ts')).toEqual(['src/a.ts']);
    expect(graph.dependents('src/a.ts')).toEqual(['src/c.ts']);
    expect(graph.externalDependencies()).toContain('node:fs');
  });

  it('detects import cycles', async () => {
    write('a.ts', `import './b.js';\nexport const a = 1;\n`);
    write('b.ts', `import './a.js';\nexport const b = 2;\n`);
    const graph = await CodeGraph.scan({ root });
    const cycles = graph.cycles();
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toContain('a.ts');
    expect(cycles[0]).toContain('b.ts');
  });

  it('updates incrementally when a file changes', async () => {
    write('a.ts', `import './b.js';\nexport const a = 1;\n`);
    write('b.ts', `import './a.js';\nexport const b = 2;\n`);
    const graph = await CodeGraph.scan({ root });
    expect(graph.cycles().length).toBeGreaterThan(0);

    // Break the cycle by removing a's import of b.
    write('a.ts', `export const a = 1;\n`);
    await graph.update(['a.ts']);
    expect(graph.cycles().length).toBe(0);
    expect(graph.dependencies('a.ts')).toEqual([]);
  });

  it('round-trips through JSON', async () => {
    write('a.ts', `export const a = 1;\n`);
    const graph = await CodeGraph.scan({ root });
    const restored = CodeGraph.fromJSON(graph.toJSON());
    expect(restored.node('a.ts')?.exports).toEqual(['a']);
    expect(restored.stats().files).toBe(1);
  });

  it('resolves non-relative imports through exact and wildcard aliases', async () => {
    write('src/a.ts', `import { b } from '@app/b';\nimport '@lib/c';\nexport const a = 1;\nvoid b;\n`);
    write('pkg/b.ts', `export const b = 2;\n`);
    write('lib/c.ts', `export const c = 3;\n`);
    const graph = await CodeGraph.scan({
      root,
      aliases: { '@app/b': ['pkg/b.ts'], '@lib/*': ['lib/*'] },
    });
    expect(graph.dependencies('src/a.ts').sort()).toEqual(['lib/c.ts', 'pkg/b.ts']);
    expect(graph.externalDependencies()).not.toContain('@app/b');
    expect(graph.dependents('pkg/b.ts')).toEqual(['src/a.ts']);
  });

  it('loads aliases from a tsconfig.json and resolves them', async () => {
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['pkg/*'] } } }),
    );
    write('src/a.ts', `import '@app/b';\n`);
    write('pkg/b.ts', `export const b = 2;\n`);
    const aliases = await loadTsconfigAliases(path.join(root, 'tsconfig.json'), root);
    expect(aliases['@app/*']).toEqual(['pkg/*']);
    const graph = await CodeGraph.scan({ root, aliases });
    expect(graph.dependencies('src/a.ts')).toEqual(['pkg/b.ts']);
  });

  it('handles a very deep import chain without overflowing the stack', () => {
    // A linear chain longer than the JS recursion limit (~4k) — the old
    // recursive cycles() crashed here; the iterative one must not.
    const n = 6000;
    const nodes = Array.from({ length: n }, (_, i) => ({
      path: `a${i}.ts`,
      language: 'typescript' as const,
      loc: 1,
      imports:
        i < n - 1
          ? [{ specifier: `./a${i + 1}.js`, to: `a${i + 1}.ts`, external: false, specifiers: [], line: 1 }]
          : [],
      exports: [],
      symbols: [],
    }));
    const graph = CodeGraph.fromJSON({ root: '/x', nodes });
    expect(() => graph.cycles()).not.toThrow();
    expect(graph.cycles()).toEqual([]);
  });
});
