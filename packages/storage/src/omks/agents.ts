/**
 * User-authored agent definitions under `.omks/agents/<id>.md`: frontmatter
 * (which runtime agent + model/reasoning/role/tools) plus a markdown body that
 * is the agent's system prompt / instructions. These are reusable subagents the
 * orchestrator can assign, in the spirit of Factory's "custom droids".
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentsDir } from './workspace.js';
import {
  asString,
  asStringArray,
  asNumber,
  parseFrontmatter,
  stringifyFrontmatter,
  type FrontmatterDoc,
} from './frontmatter.js';
import { slugId } from './slug.js';

export interface AgentDoc {
  id: string;
  name: string;
  /** Orchestration role this agent fills: an AgentRole or 'custom'. */
  role: string;
  /** Runtime agent id to drive (e.g. 'claude', 'codex', 'builtin'). */
  agentId: string;
  model: string | null;
  reasoning: string | null;
  tools: string[];
  createdAt: number;
  updatedAt: number;
  /** System prompt / instructions for the agent. */
  body: string;
}

const agentFile = (root: string, id: string): string => path.join(agentsDir(root), `${id}.md`);

function coerceAgent(id: string, doc: FrontmatterDoc): AgentDoc {
  const model = asString(doc.data.model);
  const reasoning = asString(doc.data.reasoning);
  return {
    id,
    name: asString(doc.data.name, id),
    role: asString(doc.data.role, 'custom'),
    agentId: asString(doc.data.agentId, 'builtin'),
    model: model === '' ? null : model,
    reasoning: reasoning === '' ? null : reasoning,
    tools: asStringArray(doc.data.tools),
    createdAt: asNumber(doc.data.createdAt),
    updatedAt: asNumber(doc.data.updatedAt),
    body: doc.body,
  };
}

export function listAgents(root: string): AgentDoc[] {
  let entries: string[];
  try {
    entries = readdirSync(agentsDir(root));
  } catch {
    return [];
  }
  const agents: AgentDoc[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const agent = readAgent(root, entry.slice(0, -'.md'.length));
    if (agent) agents.push(agent);
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

export function readAgent(root: string, id: string): AgentDoc | null {
  try {
    return coerceAgent(id, parseFrontmatter(readFileSync(agentFile(root, id), 'utf8')));
  } catch {
    return null;
  }
}

export function writeAgent(root: string, agent: AgentDoc): void {
  mkdirSync(agentsDir(root), { recursive: true });
  writeFileSync(
    agentFile(root, agent.id),
    stringifyFrontmatter(
      {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        agentId: agent.agentId,
        model: agent.model ?? '',
        reasoning: agent.reasoning ?? '',
        tools: agent.tools,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      },
      agent.body,
    ),
    'utf8',
  );
}

export interface CreateAgentInput {
  name: string;
  role?: string;
  agentId?: string;
  model?: string | null;
  reasoning?: string | null;
  tools?: string[];
  body?: string;
  now?: number;
}

export function createAgent(root: string, input: CreateAgentInput): AgentDoc {
  const now = input.now ?? Date.now();
  const agent: AgentDoc = {
    id: slugId(input.name),
    name: input.name,
    role: input.role ?? 'custom',
    agentId: input.agentId ?? 'builtin',
    model: input.model ?? null,
    reasoning: input.reasoning ?? null,
    tools: input.tools ?? [],
    createdAt: now,
    updatedAt: now,
    body: input.body ?? `You are ${input.name}. _Describe this agent's responsibilities._\n`,
  };
  writeAgent(root, agent);
  return agent;
}

export function deleteAgent(root: string, id: string): void {
  rmSync(agentFile(root, id), { force: true });
}
