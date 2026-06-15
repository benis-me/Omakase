import { describe, expect, it } from 'vitest';
import { resolveLeader } from '../src/tui/leader.js';

describe('resolveLeader', () => {
  it('maps known leader keys to actions', () => {
    expect(resolveLeader('l')).toBe('sessions');
    expect(resolveLeader('n')).toBe('new-session');
    expect(resolveLeader('m')).toBe('model');
    expect(resolveLeader('a')).toBe('agent');
    expect(resolveLeader('q')).toBe('quit');
  });

  it('is case-insensitive and returns null for unknown keys', () => {
    expect(resolveLeader('L')).toBe('sessions');
    expect(resolveLeader('z')).toBeNull();
  });
});
