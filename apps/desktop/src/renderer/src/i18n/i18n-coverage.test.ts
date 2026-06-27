import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zh } from './zh.js';

// The renderer source root (src/renderer/src), two levels up from this file.
const RENDERER = resolve(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'i18n') continue; // the dictionary itself isn't a consumer
      out.push(...sourceFiles(p));
    } else if (p.endsWith('.tsx') || p.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

// Literal first-argument string keys passed to the t() translator.
function translatorKeys(src: string): string[] {
  const keys: string[] = [];
  const re = /\bt\(\s*(['"])((?:\\.|(?!\1).)*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    keys.push(m[2].replace(/\\'/g, "'").replace(/\\"/g, '"'));
  }
  return keys;
}

describe('i18n coverage', () => {
  it('every t() key in the renderer has a Chinese translation in zh.ts', () => {
    const known = new Set(Object.keys(zh));
    const missing = new Set<string>();
    for (const file of sourceFiles(RENDERER)) {
      for (const key of translatorKeys(readFileSync(file, 'utf8'))) {
        if (!known.has(key)) missing.add(`${file.replace(RENDERER + '/', '')} → ${JSON.stringify(key)}`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
