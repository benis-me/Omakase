import { describe, expect, it } from 'vitest';
import * as cli from '../src/index.js';

// The Electron desktop app (and any other client) builds on this surface, so
// regressions here would silently break downstream consumers.
describe('@omakase/cli public surface', () => {
  it('re-exports the detached-daemon client seam', () => {
    expect(typeof cli.RunControllerClient).toBe('function');
    expect(typeof cli.ensureDaemon).toBe('function');
    expect(typeof cli.daemonStatus).toBe('function');
    expect(typeof cli.stopDaemon).toBe('function');
    expect(typeof cli.isDaemonAlive).toBe('function');
  });

  it('re-exports the serve composition and the view-model reducer', () => {
    expect(typeof cli.createServer).toBe('function');
    expect(typeof cli.buildRunView).toBe('function');
    expect(typeof cli.reduceRunView).toBe('function');
    expect(typeof cli.initialRunView).toBe('function');
  });
});
