import { openOrInit } from './shared.ts';
import { McpServer } from '../mcp.ts';

/** Run the MCP stdio server. stdout carries JSON-RPC only — no banners. */
export async function cmdMcp(): Promise<number> {
  const { workspace, store } = openOrInit();
  const server = new McpServer({ workspace, store });
  return await server.serve();
}
