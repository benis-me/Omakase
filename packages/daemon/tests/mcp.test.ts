import { describe, expect, it } from 'vitest';
import {
  applyMcpInjection,
  buildClaudeMcpJson,
  buildOpenCodeConfigContent,
  mergeAcpMcpServers,
} from '../src/runtime/mcp.js';

const fs = { name: 'fs', command: 'mcp-fs', args: ['--root', '.'], env: { TOKEN: 'x' } };
const remote = { name: 'web', url: 'https://example.com/mcp', type: 'http' as const };

describe('MCP builders', () => {
  it('buildClaudeMcpJson handles stdio and remote servers', () => {
    const out = buildClaudeMcpJson([fs, remote]);
    expect(out.mcpServers.fs).toEqual({ command: 'mcp-fs', args: ['--root', '.'], env: { TOKEN: 'x' } });
    expect(out.mcpServers.web).toEqual({ type: 'http', url: 'https://example.com/mcp' });
  });

  it('buildOpenCodeConfigContent serializes the opencode mcp schema', () => {
    const parsed = JSON.parse(buildOpenCodeConfigContent([fs, remote]));
    expect(parsed.mcp.fs).toEqual({
      type: 'local',
      command: ['mcp-fs', '--root', '.'],
      enabled: true,
      environment: { TOKEN: 'x' },
    });
    expect(parsed.mcp.web).toEqual({ type: 'remote', url: 'https://example.com/mcp', enabled: true });
  });

  it('mergeAcpMcpServers merges stdio entries without duplicates', () => {
    const merged = mergeAcpMcpServers(
      [{ name: 'existing', command: 'x', args: [], env: [] }],
      [fs, { name: 'existing', command: 'dupe' }],
    );
    expect(merged.map((s) => s.name)).toEqual(['existing', 'fs']);
    expect(merged[1]?.env).toEqual([{ name: 'TOKEN', value: 'x' }]);
  });
});

describe('applyMcpInjection', () => {
  it('writes the claude file via an injected writer', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const result = await applyMcpInjection({
      strategy: 'claude-mcp-json',
      servers: [fs],
      cwd: '/proj',
      env: {},
      writeProjectFile: async (p, c) => void writes.push({ path: p, content: c }),
    });
    expect(result.wroteFiles).toEqual(['/proj/.mcp.json']);
    expect(JSON.parse(writes[0]!.content).mcpServers.fs.command).toBe('mcp-fs');
  });

  it('merges into an existing .mcp.json instead of clobbering it', async () => {
    let written = '';
    await applyMcpInjection({
      strategy: 'claude-mcp-json',
      servers: [fs],
      cwd: '/proj',
      env: {},
      readProjectFile: async () =>
        JSON.stringify({ mcpServers: { userSrv: { command: 'user-srv' } }, otherKey: 1 }),
      writeProjectFile: async (_p, c) => void (written = c),
    });
    const out = JSON.parse(written);
    expect(out.mcpServers.userSrv.command).toBe('user-srv'); // user server preserved
    expect(out.mcpServers.fs.command).toBe('mcp-fs'); // injected server added
    expect(out.otherKey).toBe(1); // other top-level keys preserved
  });

  it('omits env on remote servers in both builders', () => {
    expect((buildClaudeMcpJson([remote]).mcpServers.web as Record<string, unknown>).env).toBeUndefined();
    const oc = JSON.parse(buildOpenCodeConfigContent([{ ...remote, env: { K: 'v' } }]));
    expect(oc.mcp.web.environment).toBeUndefined();
  });

  it('is a no-op for acp-merge on the direct-spawn path and when no servers', async () => {
    expect((await applyMcpInjection({ strategy: 'acp-merge', servers: [fs], env: { A: '1' } })).env).toEqual({ A: '1' });
    expect((await applyMcpInjection({ strategy: 'claude-mcp-json', servers: [], env: { A: '1' } })).wroteFiles).toEqual([]);
  });
});
