// `omks mcp` — expose Omakase over the Model Context Protocol (stdio transport,
// newline-delimited JSON-RPC 2.0) so other agents can drive goals & workflows.

import type { Workspace, Store, Goal } from '@omakase/core';
import { runGoal, discoverWorkflows, SubprocessHarness, type Harness } from '@omakase/engine';
import { detectCached } from '@omakase/providers';
import { VERSION } from './commands/help.ts';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpContext {
  workspace: Workspace;
  store: Store;
  harness?: Harness;
  signal?: AbortSignal;
}

const PROTOCOL_VERSION = '2024-11-05';

export class McpServer {
  constructor(private ctx: McpContext) {}

  private harness(): Harness {
    return this.ctx.harness ?? new SubprocessHarness({ cachePath: this.ctx.workspace.paths.agentsCache });
  }

  private tools(): ToolDef[] {
    return [
      {
        name: 'omakase_run_goal',
        description: 'Run a goal to completion with a Dynamic Workflow, returning the outcome.',
        inputSchema: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'What to achieve' },
            workflow: { type: 'string', description: 'Workflow name (default: goal)' },
            provider: { type: 'string', description: 'Provider id (default: auto)' },
            maxAgents: { type: 'number' },
          },
          required: ['goal'],
        },
      },
      { name: 'omakase_list_workflows', description: 'List available Dynamic Workflows.', inputSchema: { type: 'object', properties: {} } },
      { name: 'omakase_list_providers', description: 'List installed agent providers.', inputSchema: { type: 'object', properties: {} } },
      {
        name: 'omakase_list_runs',
        description: 'List recent runs.',
        inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      },
      {
        name: 'omakase_get_run',
        description: 'Get a run’s status, summary and reports.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
      },
    ];
  }

  /** Handle one JSON-RPC request. Returns null for notifications (no reply). */
  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const isNotification = req.id === undefined || req.id === null;
    const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id: req.id ?? null, result });
    const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id: req.id ?? null, error: { code, message } });

    try {
      switch (req.method) {
        case 'initialize':
          return reply({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'omakase', version: VERSION },
          });
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools: this.tools() });
        case 'tools/call': {
          const name = String(req.params?.name ?? '');
          const args = (req.params?.arguments as Record<string, unknown>) ?? {};
          const text = await this.callTool(name, args);
          return reply({ content: [{ type: 'text', text }] });
        }
        default:
          if (req.method.startsWith('notifications/')) return null;
          if (isNotification) return null;
          return fail(-32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      if (isNotification) return null;
      return fail(-32603, (err as Error).message);
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'omakase_list_workflows': {
        const wfs = discoverWorkflows({ workspace: this.ctx.workspace.paths.workflows });
        return wfs.map((m) => `${m.name} (v${m.version}, ${m.scope}) — ${m.description}`).join('\n');
      }
      case 'omakase_list_providers': {
        const ps = await detectCached(this.ctx.workspace.paths.agentsCache, { discoverModels: false });
        return ps.map((p) => `${p.id}: ${p.available ? 'available' : 'not installed'}${p.version ? ` (${p.version})` : ''}`).join('\n');
      }
      case 'omakase_list_runs': {
        const limit = typeof args.limit === 'number' ? args.limit : 20;
        const runs = this.ctx.store.listRuns({ limit });
        if (!runs.length) return 'No runs yet.';
        return runs.map((r) => `${r.id}  ${r.status}  ${r.workflow}  ${r.title}`).join('\n');
      }
      case 'omakase_get_run': {
        const run = this.ctx.store.getRun(String(args.runId ?? ''));
        if (!run) return `No such run: ${args.runId}`;
        const reports = this.ctx.store.listReports(run.id).map((r) => `- [${r.kind}] ${r.title}: ${r.summary}`);
        return `${run.title}\nstatus: ${run.status}\nworkflow: ${run.workflow}\nagents: ${run.spentAgents}  cost: $${run.spentCostUsd.toFixed(4)}\n${run.summary ?? ''}\n${reports.join('\n')}`.trim();
      }
      case 'omakase_run_goal': {
        const goalText = String(args.goal ?? '').trim();
        if (!goalText) throw new Error('goal is required');
        const goal: Goal = {
          text: goalText,
          cwd: this.ctx.workspace.root,
          ...(args.workflow ? { workflow: String(args.workflow) } : {}),
          ...(args.provider ? { provider: String(args.provider) } : {}),
        };
        const outcome = await runGoal({
          goal,
          workspace: this.ctx.workspace,
          store: this.ctx.store,
          harness: this.harness(),
          ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
          ...(typeof args.maxAgents === 'number' ? { maxAgents: args.maxAgents } : {}),
        });
        return `Run ${outcome.runId}: ${outcome.status}\n${outcome.summary ?? ''}${outcome.gaps.length ? `\nRemaining: ${outcome.gaps.join('; ')}` : ''}`;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /** Run the stdio server loop until stdin closes. */
  async serve(): Promise<number> {
    const encoder = new TextEncoder();
    const write = (res: JsonRpcResponse) => process.stdout.write(encoder.encode(JSON.stringify(res) + '\n'));
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of Bun.stdin.stream()) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (!line) continue;
        let req: JsonRpcRequest | null = null;
        try {
          req = JSON.parse(line) as JsonRpcRequest;
        } catch {
          continue;
        }
        const res = await this.handle(req);
        if (res) write(res);
      }
    }
    return 0;
  }
}
