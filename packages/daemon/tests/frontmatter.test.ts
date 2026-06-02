import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/skills/frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses scalars, arrays, nested maps, and the body', () => {
    const src = [
      '---',
      'name: spec-driven',
      'description: Drive work from a spec',
      'version: 2',
      'enabled: true',
      'triggers:',
      '  - spec',
      '  - acceptance criteria',
      'omakase:',
      '  roles:',
      '    - planner',
      '    - reviewer',
      '  category: workflow',
      '---',
      '# Body heading',
      '',
      'Body text here.',
    ].join('\n');
    const { data, body } = parseFrontmatter(src);
    expect(data.name).toBe('spec-driven');
    expect(data.version).toBe(2);
    expect(data.enabled).toBe(true);
    expect(data.triggers).toEqual(['spec', 'acceptance criteria']);
    expect(data.omakase).toEqual({ roles: ['planner', 'reviewer'], category: 'workflow' });
    expect(body).toContain('# Body heading');
    expect(body).toContain('Body text here.');
  });

  it('handles inline arrays, quoted strings, and url values', () => {
    const src = [
      '---',
      'tags: [a, b, c]',
      'title: "Quoted: value"',
      'docsUrl: https://example.com/docs',
      '---',
      'body',
    ].join('\n');
    const { data } = parseFrontmatter(src);
    expect(data.tags).toEqual(['a', 'b', 'c']);
    expect(data.title).toBe('Quoted: value');
    expect(data.docsUrl).toBe('https://example.com/docs');
  });

  it('parses block scalars', () => {
    const src = [
      '---',
      'instructions: |',
      '  line one',
      '  line two',
      'name: x',
      '---',
      'body',
    ].join('\n');
    const { data } = parseFrontmatter(src);
    expect(data.instructions).toBe('line one\nline two');
    expect(data.name).toBe('x');
  });

  it('returns empty data when there is no frontmatter', () => {
    const { data, body } = parseFrontmatter('just a body\n');
    expect(data).toEqual({});
    expect(body).toBe('just a body\n');
  });
});
