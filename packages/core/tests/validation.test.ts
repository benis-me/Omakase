import { describe, expect, it } from 'vitest';
import { buildValidationPrompt, parseValidationVerdict } from '../src/validation.js';

describe('parseValidationVerdict', () => {
  it('parses a passing JSON verdict', () => {
    expect(parseValidationVerdict('{"passed": true, "gaps": [], "notes": "all good"}')).toEqual({
      passed: true,
      gaps: [],
      notes: 'all good',
    });
  });

  it('parses a failing JSON verdict with gaps (prose around it is tolerated)', () => {
    const v = parseValidationVerdict(
      'Sure:\n{"passed": false, "gaps": ["no tests", "missing error handling"], "notes": "incomplete"}',
    );
    expect(v.passed).toBe(false);
    expect(v.gaps).toEqual(['no tests', 'missing error handling']);
  });

  it('treats passed=true with listed gaps as not passed (gaps win)', () => {
    const v = parseValidationVerdict('{"passed": true, "gaps": ["still TODO"], "notes": ""}');
    expect(v.passed).toBe(false);
    expect(v.gaps).toEqual(['still TODO']);
  });

  it('falls back to a heuristic for non-JSON output', () => {
    expect(parseValidationVerdict('Looks good, all criteria met. LGTM.').passed).toBe(true);
    const rejected = parseValidationVerdict('Not done yet:\n- missing CSV escaping\n- no tests');
    expect(rejected.passed).toBe(false);
    expect(rejected.gaps).toEqual(['missing CSV escaping', 'no tests']);
  });

  it('does not pass on ambiguous output', () => {
    expect(parseValidationVerdict('Hmm, I am not sure.').passed).toBe(false);
  });
});

describe('buildValidationPrompt', () => {
  it('includes the goal, numbered criteria, and a JSON contract', () => {
    const p = buildValidationPrompt('Build a parser', ['has tests', 'handles quotes'], '{"tasks":[]}');
    expect(p).toContain('Build a parser');
    expect(p).toContain('1. has tests');
    expect(p).toContain('2. handles quotes');
    expect(p).toContain('"passed"');
  });
});
