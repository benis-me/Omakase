/**
 * External MCP server injection. Each adapter declares an
 * `externalMcpInjection` strategy describing how it consumes MCP servers; this
 * module turns a list of {@link McpServerConfig} into the concrete artifact each
 * strategy needs:
 *   - `claude-mcp-json`      → write `.mcp.json` into the project cwd (Claude auto-loads it)
 *   - `opencode-env-content` → set `OPENCODE_CONFIG_CONTENT` in the spawn env
 *   - `acp-merge`            → merge stdio entries into an ACP launch descriptor
 *
 * The builders are pure and unit-testable; {@link applyMcpInjection} performs
 * the side effects (env mutation, file write) the spawn layer needs.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeAgentDef } from '../runtimes/types.js';

export type McpInjectionStrategy = NonNullable<RuntimeAgentDef['externalMcpInjection']>;

export interface McpServerConfig {
  name: string;
  /** stdio command (for local servers). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Transport kind; defaults to stdio when a command is given, http when a url is. */
  type?: 'stdio' | 'http' | 'sse';
  /** Remote server url (for http/sse servers). */
  url?: string;
}

/** Claude Code `.mcp.json` shape. */
export function buildClaudeMcpJson(
  servers: readonly McpServerConfig[],
): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.name] = s.url
      ? { type: s.type ?? 'http', url: s.url, ...(s.env ? { env: s.env } : {}) }
      : { command: s.command ?? '', args: s.args ?? [], ...(s.env ? { env: s.env } : {}) };
  }
  return { mcpServers };
}

/** OpenCode `OPENCODE_CONFIG_CONTENT` JSON. */
export function buildOpenCodeConfigContent(servers: readonly McpServerConfig[]): string {
  const mcp: Record<string, unknown> = {};
  for (const s of servers) {
    mcp[s.name] = s.url
      ? { type: 'remote', url: s.url, enabled: true }
      : {
          type: 'local',
          command: [s.command, ...(s.args ?? [])].filter((p): p is string => Boolean(p)),
          enabled: true,
          ...(s.env ? { environment: s.env } : {}),
        };
  }
  return JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp });
}

export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

/** Merge stdio servers into an existing ACP `mcpServers` array (no duplicates by name). */
export function mergeAcpMcpServers(
  existing: readonly AcpMcpServer[],
  servers: readonly McpServerConfig[],
): AcpMcpServer[] {
  const out: AcpMcpServer[] = [...existing];
  const names = new Set(existing.map((e) => e.name));
  for (const s of servers) {
    if (names.has(s.name) || !s.command) continue;
    names.add(s.name);
    out.push({
      name: s.name,
      command: s.command,
      args: s.args ?? [],
      env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })),
    });
  }
  return out;
}

export interface ApplyMcpInjectionContext {
  strategy: McpInjectionStrategy | undefined;
  servers: readonly McpServerConfig[];
  cwd?: string;
  env: Record<string, string | undefined>;
  /** Override the file writer (tests). Defaults to writing under cwd. */
  writeProjectFile?: (filePath: string, content: string) => Promise<void>;
}

export interface ApplyMcpInjectionResult {
  env: Record<string, string | undefined>;
  wroteFiles: string[];
}

async function defaultWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

/**
 * Apply the adapter's MCP-injection strategy. Returns the (possibly augmented)
 * spawn env and any files written. `acp-merge` is a no-op here (it applies to
 * ACP launch descriptors, not the direct-spawn path) — use {@link mergeAcpMcpServers}.
 */
export async function applyMcpInjection(
  ctx: ApplyMcpInjectionContext,
): Promise<ApplyMcpInjectionResult> {
  if (!ctx.strategy || ctx.servers.length === 0) {
    return { env: ctx.env, wroteFiles: [] };
  }
  switch (ctx.strategy) {
    case 'claude-mcp-json': {
      if (!ctx.cwd) return { env: ctx.env, wroteFiles: [] };
      const filePath = path.join(ctx.cwd, '.mcp.json');
      const write = ctx.writeProjectFile ?? defaultWrite;
      await write(filePath, JSON.stringify(buildClaudeMcpJson(ctx.servers), null, 2));
      return { env: ctx.env, wroteFiles: [filePath] };
    }
    case 'opencode-env-content':
      return {
        env: { ...ctx.env, OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent(ctx.servers) },
        wroteFiles: [],
      };
    case 'acp-merge':
      // No ACP launch descriptor on the direct-spawn path; nothing to do.
      return { env: ctx.env, wroteFiles: [] };
  }
}
