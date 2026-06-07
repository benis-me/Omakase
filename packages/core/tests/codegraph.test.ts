import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CodeGraph, loadTsconfigAliases } from '../src/knowledge/codegraph.js';
import { createCodeGraphWatcher } from '../src/knowledge/watch.js';

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

  it('strips inline `type` modifiers from import/export specifiers', async () => {
    write(
      'src/a.ts',
      `import { type Foo, Bar } from './b.js';\nexport { type Foo, Bar };\nvoid Bar;\n`,
    );
    write('src/b.ts', `export type Foo = number;\nexport const Bar = 1;\n`);
    const graph = await CodeGraph.scan({ root });
    const a = graph.node('src/a.ts');
    // No garbage "type Foo" name; both the type and value specifiers are clean.
    expect(a?.imports.flatMap((i) => i.specifiers).sort()).toEqual(['Bar', 'Foo']);
    expect(a?.exports.sort()).toEqual(['Bar', 'Foo']);
    expect(a?.exports.some((e) => e.includes('type'))).toBe(false);
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

  it('summarizes codegraph into project knowledge handles', async () => {
    write(
      'src/app.ts',
      `import React from 'react';\nimport { service } from './core/service.js';\nimport { Button } from './ui/button.js';\nexport const app = service(Button, React);\n`,
    );
    write(
      'src/cli.ts',
      `import { service } from './core/service.js';\nexport function main() { return service(null, null); }\n`,
    );
    write(
      'src/ui/button.ts',
      `import React from 'react';\nimport { service } from '../core/service.js';\nexport function Button() { return service(null, React); }\n`,
    );
    write(
      'src/core/service.ts',
      `import { repo } from './repo.js';\nimport { log } from '../shared/logger.js';\nexport function service(a: unknown, b: unknown) { log(a); return repo(b); }\n`,
    );
    write('src/core/repo.ts', `import fs from 'node:fs';\nexport const repo = (value: unknown) => fs.existsSync(String(value));\n`);
    write('src/shared/logger.ts', `export const log = (value: unknown) => value;\n`);
    write('src/cycle/a.ts', `import { b } from './b.js';\nexport const a = b;\n`);
    write('src/cycle/b.ts', `import { a } from './a.js';\nexport const b = a;\n`);

    const graph = await CodeGraph.scan({ root });
    const summary = graph.summary(5);

    expect(summary.stats).toMatchObject({
      files: 8,
      internalEdges: 8,
      externalEdges: 3,
      cycles: 1,
    });
    expect(summary.dependencyHubs[0]).toMatchObject({
      path: 'src/core/service.ts',
      dependents: 3,
      dependencies: 2,
    });
    expect(summary.entrypoints.map((item) => item.path)).toEqual(
      expect.arrayContaining(['src/app.ts', 'src/cli.ts']),
    );
    expect(summary.externalDependencies).toEqual([
      { specifier: 'react', count: 2 },
      { specifier: 'node:fs', count: 1 },
    ]);
    expect(summary.cycles[0]).toEqual(expect.arrayContaining(['src/cycle/a.ts', 'src/cycle/b.ts']));
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

  it('resolves aliases whose target path contains a space', async () => {
    write('src/a.ts', `import '@app/b';\n`);
    write('my pkg/b.ts', `export const b = 1;\n`);
    const graph = await CodeGraph.scan({ root, aliases: { '@app/*': ['my pkg/*'] } });
    expect(graph.dependencies('src/a.ts')).toEqual(['my pkg/b.ts']);
  });

  it('loadTsconfigAliases preserves wildcard targets containing spaces', async () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['my pkg/*'] } } }));
    const aliases = await loadTsconfigAliases(path.join(root, 'tsconfig.json'), root);
    expect(aliases['@app/*']).toEqual(['my pkg/*']);
  });

  it('keeps a separator before the wildcard when baseUrl is a subdir', async () => {
    // baseUrl points at src/ and the target is a bare '*' (wildcard at the
    // baseUrl root). The rewritten target must be 'src/*', not 'src*' — the
    // separator has to survive the prefix/wildcard rejoin.
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { baseUrl: 'src', paths: { '@app/*': ['*'] } } }),
    );
    write('src/a.ts', `import '@app/b';\n`);
    write('src/b.ts', `export const b = 1;\n`);
    const aliases = await loadTsconfigAliases(path.join(root, 'tsconfig.json'), root);
    expect(aliases['@app/*']).toEqual(['src/*']);
    const graph = await CodeGraph.scan({ root, aliases });
    expect(graph.dependencies('src/a.ts')).toEqual(['src/b.ts']);
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

describe('createCodeGraphWatcher', () => {
  it('applies debounced incremental updates and removes vanished files', async () => {
    write('src/a.ts', `import './b.js';\nexport const a = 1;\n`);
    write('src/b.ts', `export const b = 2;\n`);
    const graph = await CodeGraph.scan({ root });
    expect(graph.dependencies('src/a.ts')).toEqual(['src/b.ts']);

    const applied: string[][] = [];
    const watcher = createCodeGraphWatcher(graph, { onUpdate: (p) => applied.push(p) });

    // Drop the dependency, then notify + flush.
    write('src/a.ts', `export const a = 1;\n`);
    watcher.notify('src/a.ts');
    await watcher.flush();
    expect(graph.dependencies('src/a.ts')).toEqual([]);

    // Point a.ts at a brand-new file.
    write('src/a.ts', `import './c.js';\nexport const a = 1;\n`);
    write('src/c.ts', `export const c = 3;\n`);
    watcher.notify('src/a.ts', 'src/c.ts');
    await watcher.flush();
    expect(graph.dependencies('src/a.ts')).toEqual(['src/c.ts']);

    // Delete b.ts; the watcher removes the vanished node.
    rmSync(path.join(root, 'src/b.ts'));
    watcher.notify('src/b.ts');
    await watcher.flush();
    expect(graph.node('src/b.ts')).toBeUndefined();

    expect(applied).toHaveLength(3);
    watcher.stop();
  });

  it('coalesces a burst of notifications into a single batch', async () => {
    write('src/a.ts', `export const a = 1;\n`);
    const graph = await CodeGraph.scan({ root });
    let batches = 0;
    const watcher = createCodeGraphWatcher(graph, { onUpdate: () => { batches += 1; } });
    watcher.notify('src/a.ts');
    watcher.notify('src/a.ts');
    watcher.notify('src/a.ts');
    await watcher.flush();
    expect(batches).toBe(1);
    watcher.stop();
  });
});
