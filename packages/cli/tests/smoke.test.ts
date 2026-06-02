import { describe, expect, it, vi } from 'vitest';
import { CLI_VERSION, main } from '../src/index.js';

describe('@omakase/cli scaffold', () => {
  it('prints a version line', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    await main(['--version']);
    spy.mockRestore();
    expect(writes.join('')).toContain(`omakase ${CLI_VERSION}`);
  });
});
