import { describe, expect, it } from 'vitest';
import { DAEMON_VERSION } from '../src/index.js';

describe('@omakase/daemon scaffold', () => {
  it('exposes a version constant', () => {
    expect(DAEMON_VERSION).toBe('0.1.0');
  });
});
