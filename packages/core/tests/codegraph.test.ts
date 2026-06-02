import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src/knowledge/codegraph.js';

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
});
