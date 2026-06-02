import { describe, expect, it } from 'vitest';
import { CORE_VERSION, DAEMON_VERSION } from '../src/index.js';

describe('@omakase/core scaffold', () => {
  it('exposes its own version and re-exports the daemon version', () => {
    expect(CORE_VERSION).toBe('0.1.0');
    expect(DAEMON_VERSION).toBe('0.1.0');
  });
});
