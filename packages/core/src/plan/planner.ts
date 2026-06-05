/**
 * Planners turn a request into a {@link PlanGraph}. {@link RulePlanner} is a
 * deterministic decomposer (split the prompt into sub-goals → worker tasks,
 * gated by a final review task). {@link createAgentPlanner} asks an agent for a
 * structured plan and falls back to the rule planner if the answer is unusable.
 */
import { renderSkillContext, type AgentRuntime, type SkillInfo } from '@omakase/daemon';
import type { IdGenerator } from '../ids.js';
import type { OrchestrationRequest } from '../types.js';
import { PlanGraph } from './plan-graph.js';

export interface PlanContext {
  request: OrchestrationRequest;
  idGenerator?: IdGenerator;
  clock?: () => number;
  /** Optional knowledge snapshot to inform planning. */
  knowledge?: string;
  /** Skills selected for the planner role, injected into agent-backed prompts. */
  skills?: SkillInfo[];
}

export interface Planner {
  plan(ctx: PlanContext): PlanGraph | Promise<PlanGraph>;
}

function shorten(text: string, max = 72): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function dedupeCap(items: string[], cap = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

function cleanPhaseTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return shorten(clean, 40);
}

export function tagsFromAgentPlanTask(raw: unknown, fallbackTitle: string): string[] {
  const task = raw as { phase?: unknown; tags?: unknown };
  const tags: string[] = [];
  const phase = cleanPhaseTag(task.phase);
  if (phase) tags.push(phase);
  if (Array.isArray(task.tags)) {
    for (const tag of task.tags) {
      const clean = cleanPhaseTag(tag);
      if (clean) tags.push(clean);
    }
  }
  return dedupeCap(tags.length > 0 ? tags : [shorten(fallbackTitle, 40)], 4);
}

/** Decompose a prompt into ordered sub-goals. */
export function splitGoals(prompt: string): string[] {
  const text = prompt.trim();
  const listItems = [...text.matchAll(/^\s*(?:[-*]|\d+\.)\s+(.+)$/gm)]
    .map((m) => m[1]!.trim())
    .filter(Boolean);
  if (listItems.length >= 2) return dedupeCap(listItems);

  const parts = text
    .split(/\b(?:and then|then|after that|afterwards)\b|[;\n]+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 4);
  if (parts.length >= 2) return dedupeCap(parts);

  return [text];
}

export class RulePlanner implements Planner {
  plan(ctx: PlanContext): PlanGraph {
    const graph = new PlanGraph({
      ...(ctx.idGenerator ? { idGenerator: ctx.idGenerator } : {}),
      ...(ctx.clock ? { clock: ctx.clock } : {}),
    });
    const goals = splitGoals(ctx.request.prompt);
    const workerIds: string[] = [];
    for (const goal of goals) {
      const task = graph.addTask({
        title: shorten(goal),
        description: goal,
        role: 'worker',
        tags: [shorten(goal, 40)],
      });
      workerIds.push(task.id);
    }
    graph.addTask({
      title: 'Review and verify the work',
      description:
        'Review the completed work for correctness and completeness against the original request, and flag anything that needs another pass.',
      role: 'reviewer',
      dependsOn: workerIds,
      tags: ['Review'],
    });
    graph.refreshReadiness();
    return graph;
  }
}

interface AgentPlanTask {
  title?: unknown;
  description?: unknown;
  dependsOn?: unknown;
  phase?: unknown;
  tags?: unknown;
}

/** Extract the first balanced JSON array from arbitrary text. */
export function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface AgentPlannerOptions {
  agentId: string;
  model?: string | null;
  fallback?: Planner;
  buildPrompt?: (ctx: PlanContext) => string;
}

export function createAgentPlanner(
  runtime: Pick<AgentRuntime, 'runAgent'>,
  options: AgentPlannerOptions,
): Planner {
  const fallback = options.fallback ?? new RulePlanner();
  const buildPrompt =
    options.buildPrompt ??
    ((ctx: PlanContext) =>
      [
        'Break the following request into an ordered implementation plan.',
        'Respond with ONLY a JSON array of objects.',
        'Each object must be: {"title": string, "description": string, "phase": string, "dependsOn": number[]}.',
        'phase is the user-visible stage name shown in the TUI, such as Discovery, Core, TUI, Verification, or Docs.',
        'For broad requests, create 3-7 focused worker tasks and prefer independent tasks that can run in parallel.',
        'Do not collapse unrelated work into one task.',
        'dependsOn uses zero-based indices of earlier tasks.',
        ctx.knowledge ? `\nProject context:\n${ctx.knowledge}\n` : '',
        ctx.skills && ctx.skills.length > 0
          ? `\nApplicable skills (follow them when planning):\n${renderSkillContext(ctx.skills)}\n`
          : '',
        `Request: ${ctx.request.prompt}`,
      ].join('\n'));

  return {
    async plan(ctx: PlanContext): Promise<PlanGraph> {
      const result = await runtime.runAgent({
        agentId: options.agentId,
        prompt: buildPrompt(ctx),
        cwd: ctx.request.cwd,
        model: options.model,
      });
      const arr = result.status === 'completed' ? extractJsonArray(result.text) : null;
      if (!arr || arr.length === 0) return fallback.plan(ctx);

      const graph = new PlanGraph({
        ...(ctx.idGenerator ? { idGenerator: ctx.idGenerator } : {}),
        ...(ctx.clock ? { clock: ctx.clock } : {}),
      });
      const ids: string[] = [];
      for (const raw of arr) {
        const task = raw as AgentPlanTask;
        const title = typeof task.title === 'string' ? task.title : 'Task';
        const description =
          typeof task.description === 'string' ? task.description : title;
        const deps = Array.isArray(task.dependsOn)
          ? task.dependsOn
              .map((d) => (typeof d === 'number' ? ids[d] : undefined))
              .filter((d): d is string => Boolean(d))
          : [];
        const node = graph.addTask({
          title: shorten(title),
          description,
          role: 'worker',
          dependsOn: deps,
          tags: tagsFromAgentPlanTask(task, title),
        });
        ids.push(node.id);
      }
      graph.addTask({
        title: 'Review and verify the work',
        description: 'Review the completed work against the original request.',
        role: 'reviewer',
        dependsOn: ids,
        tags: ['Review'],
      });
      graph.refreshReadiness();
      return graph;
    },
  };
}
