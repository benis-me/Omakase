/**
 * Mode-driven agent + model selection.
 *
 * A {@link ModelPolicy} answers "which agent, model, and reasoning effort should
 * role X use right now?" given the set of detected agents. The three work modes
 * encode different strategies; {@link createModelPolicy} builds the matching
 * policy and everything is deterministic and unit-testable.
 */
import type { DetectedAgent } from '@omakase/daemon';
import type { AgentRole, WorkMode } from '../types.js';

export const BUILTIN_AGENT_ID = 'builtin';

export interface RoleAssignment {
  role: AgentRole;
  agentId: string;
  model: string | null;
  reasoning: string | null;
  rationale: string;
}

export interface CustomRoleConfig {
  agentId: string;
  model?: string | null;
  reasoning?: string | null;
  budgetTokens?: number;
}

export interface CustomModeConfig {
  roles?: Partial<Record<AgentRole, CustomRoleConfig>>;
  default?: CustomRoleConfig;
}

export interface SelectionContext {
  available: DetectedAgent[];
  /** Optional hint about the task ('codegen' | 'review' | 'reasoning' | 'route'). */
  taskType?: string;
  /** Stable task id used to distribute worker tasks across the available agent pool. */
  taskId?: string;
  /** Optional task title fallback when no id is available. */
  taskTitle?: string;
}

export interface ModelPolicy {
  readonly mode: WorkMode;
  select(role: AgentRole, ctx: SelectionContext): RoleAssignment;
}

export interface ModelPolicyOptions {
  /** Agent ids in descending capability order. */
  ranking?: string[];
  custom?: CustomModeConfig;
  builtinAgentId?: string;
}

/** Default capability ranking, strongest first. */
export const DEFAULT_AGENT_STRENGTH: readonly string[] = [
  'claude',
  'codex',
  'pi',
  'cursor-agent',
  'gemini',
  'copilot',
  'opencode',
  'qwen',
];

function rankAvailable(
  agents: DetectedAgent[],
  ranking: readonly string[],
): DetectedAgent[] {
  const index = new Map(ranking.map((id, i) => [id, i]));
  return agents
    .filter((a) => a.available && a.authStatus !== 'missing')
    .sort((a, b) => (index.get(a.id) ?? 999) - (index.get(b.id) ?? 999));
}

function pickModelByKeyword(
  agent: DetectedAgent,
  keywords: RegExp,
): string | null {
  for (const model of agent.models) {
    if (model.id === 'default') continue;
    if (keywords.test(`${model.id} ${model.label}`.toLowerCase())) return model.id;
  }
  return null;
}

const STRONG_MODEL = /opus|gpt-5(?:\.\d)?\b|gpt-5-codex|pro\b|sonnet-4-5|max\b|ultra/;
const CHEAP_MODEL = /haiku|mini|flash|small|nano|lite/;

function pickReasoning(agent: DetectedAgent, candidates: string[]): string | null {
  const ids = new Set(agent.reasoningOptions.map((o) => o.id));
  for (const candidate of candidates) {
    if (candidate !== 'default' && ids.has(candidate)) return candidate;
  }
  return null;
}

function stableSlot(ctx: SelectionContext, size: number): number {
  const key = ctx.taskId ?? ctx.taskTitle ?? ctx.taskType ?? '';
  const numeric = /(\d+)$/.exec(key);
  if (numeric) {
    const parsed = Number(numeric[1]);
    if (Number.isFinite(parsed) && parsed > 0) return (parsed - 1) % size;
  }
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % size;
}

function builtinAssignment(role: AgentRole, rationale: string, builtinId: string): RoleAssignment {
  return { role, agentId: builtinId, model: null, reasoning: null, rationale };
}

export function createModelPolicy(
  mode: WorkMode,
  options: ModelPolicyOptions = {},
): ModelPolicy {
  const ranking = options.ranking ?? DEFAULT_AGENT_STRENGTH;
  const builtinId = options.builtinAgentId ?? BUILTIN_AGENT_ID;
  const custom = options.custom;

  const selectAuto = (role: AgentRole, ctx: SelectionContext): RoleAssignment => {
    const ranked = rankAvailable(ctx.available, ranking);
    if (ranked.length === 0) {
      return builtinAssignment(role, 'No installed agent available; using built-in', builtinId);
    }
    const top = ranked[0]!;

    if (mode === 'max-power') {
      return {
        role,
        agentId: top.id,
        model: pickModelByKeyword(top, STRONG_MODEL),
        reasoning: pickReasoning(top, ['xhigh', 'high', 'medium']),
        rationale: `max-power: strongest available agent (${top.id}) at peak reasoning`,
      };
    }

    // normal (also the fallback for custom roles with no explicit config)
    if (role === 'router') {
      return {
        role,
        agentId: top.id,
        model: pickModelByKeyword(top, CHEAP_MODEL),
        reasoning: pickReasoning(top, ['low', 'minimal']),
        rationale: 'normal: light/cheap model for fast routing',
      };
    }
    if (role === 'planner' || role === 'reviewer') {
      return {
        role,
        agentId: top.id,
        model: null,
        reasoning: pickReasoning(top, ['high', 'medium']),
        rationale: `normal: stronger reasoning for ${role}`,
      };
    }
    if (role === 'worker' && ranked.length > 1) {
      const slot = stableSlot(ctx, ranked.length);
      const agent = ranked[slot] ?? top;
      return {
        role,
        agentId: agent.id,
        model: null,
        reasoning: null,
        rationale: `normal: distributed worker ${slot + 1}/${ranked.length} (${agent.id})`,
      };
    }
    return {
      role,
      agentId: top.id,
      model: null,
      reasoning: null,
      rationale: 'normal: default model/reasoning for worker',
    };
  };

  return {
    mode,
    select(role: AgentRole, ctx: SelectionContext): RoleAssignment {
      if (mode === 'custom') {
        const cfg = custom?.roles?.[role] ?? custom?.default;
        if (cfg) {
          return {
            role,
            agentId: cfg.agentId,
            model: cfg.model ?? null,
            reasoning: cfg.reasoning ?? null,
            rationale: `custom: configured ${cfg.agentId}`,
          };
        }
        // No custom entry for this role → fall back to the balanced strategy.
      }
      return selectAuto(role, ctx);
    },
  };
}
