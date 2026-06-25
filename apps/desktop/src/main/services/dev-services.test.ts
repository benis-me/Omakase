import { describe, expect, it } from 'vitest';
import { parseLsof, PortService } from './port-service.js';
import { GitService, parseAheadBehind, parsePorcelain } from './git-service.js';

describe('parseLsof', () => {
  it('parses listeners, skipping the header and deduping by pid', () => {
    const out = 'COMMAND   PID USER\nnode    1234 me\nnode    1234 me\nnode    5678 me\n';
    expect(parseLsof(out, 3000)).toEqual([
      { port: 3000, pid: 1234, command: 'node' },
      { port: 3000, pid: 5678, command: 'node' },
    ]);
  });
});

describe('PortService.killPort', () => {
  it('SIGTERMs listeners then reports the handled pids', async () => {
    const killed: Array<[number, string]> = [];
    let call = 0;
    const run = async (): Promise<string> => (call++ === 0 ? 'node 111 me' : '');
    const svc = new PortService(run, (pid, sig) => killed.push([pid, sig]), async () => {});
    expect(await svc.killPort(3000)).toEqual([111]);
    expect(killed).toContainEqual([111, 'SIGTERM']);
  });
});

describe('git parsers', () => {
  it('counts porcelain change lines', () => {
    expect(parsePorcelain(' M a\n?? b\n\n')).toBe(2);
  });
  it('parses ahead/behind (behind<TAB>ahead)', () => {
    expect(parseAheadBehind('2\t3')).toEqual({ behind: 2, ahead: 3 });
    expect(parseAheadBehind('garbage')).toEqual({ behind: 0, ahead: 0 });
  });
});

describe('GitService.info', () => {
  it('returns null outside a work tree', async () => {
    const svc = new GitService(async () => ({ ok: true, out: 'false' }));
    expect(await svc.info('/x')).toBeNull();
  });

  it('assembles branch/dirty/ahead/behind inside a work tree', async () => {
    const svc = new GitService(async (args) => {
      const a = args.join(' ');
      if (a.includes('is-inside-work-tree')) return { ok: true, out: 'true' };
      if (a.includes('branch')) return { ok: true, out: 'main\n' };
      if (a.includes('status')) return { ok: true, out: ' M a\n' };
      if (a.includes('rev-list')) return { ok: true, out: '0\t2\n' };
      return { ok: false, out: '' };
    });
    expect(await svc.info('/x')).toEqual({
      branch: 'main',
      dirty: true,
      changes: 1,
      ahead: 2,
      behind: 0,
    });
  });
});
