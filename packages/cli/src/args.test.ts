import { test, expect } from 'bun:test';
import { parseArgs, flagStr, flagBool, flagNum } from './args.ts';

test('positionals + value flags + booleans', () => {
  const a = parseArgs(['run', 'build the thing', '--workflow', 'goal', '--json'], {
    value: ['workflow'],
  });
  expect(a.positionals).toEqual(['run', 'build the thing']);
  expect(flagStr(a, 'workflow')).toBe('goal');
  expect(flagBool(a, 'json')).toBe(true);
});

test('--flag=value and short aliases', () => {
  const a = parseArgs(['-w=mission', '-p', 'claude', '--max=3'], {
    value: ['workflow', 'provider', 'max'],
    alias: { w: 'workflow', p: 'provider' },
  });
  expect(flagStr(a, 'workflow')).toBe('mission');
  expect(flagStr(a, 'provider')).toBe('claude');
  expect(flagNum(a, 'max')).toBe(3);
});

test('repeatable flags collect into multi', () => {
  const a = parseArgs(['--check', 'bun test', '--check', 'ls', '--criteria', 'works'], {
    repeatable: ['check', 'criteria'],
  });
  expect(a.multi['check']).toEqual(['bun test', 'ls']);
  expect(a.multi['criteria']).toEqual(['works']);
});

test('-- terminator puts the rest into positionals', () => {
  const a = parseArgs(['run', '--', '--not-a-flag', 'x'], {});
  expect(a.positionals).toEqual(['run', '--not-a-flag', 'x']);
});

test('negative numbers are positionals, not flags', () => {
  const a = parseArgs(['scale', '-5'], {});
  expect(a.positionals).toEqual(['scale', '-5']);
});

test('value flag at end with no value becomes boolean', () => {
  const a = parseArgs(['--provider'], { value: ['provider'] });
  expect(a.flags['provider']).toBe(true);
});
