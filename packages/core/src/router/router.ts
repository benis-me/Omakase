/**
 * The router decides whether a request is a simple single-agent task or a
 * complex orchestration that needs the full planner → workers → reviewer loop.
 *
 * {@link RuleRouter} is a deterministic, testable heuristic. {@link createAgentRouter}
 * wraps an agent for LLM-backed classification, falling back to the rule router
 * when the agent's answer can't be parsed.
 */
import type { AgentRuntime } from '@omakase/daemon';
import type { AgentRole, OrchestrationRequest } from '../types.js';

export type RouteKind = 'simple' | 'complex';

export interface RouteDecision {
  kind: RouteKind;
  reason: string;
  /** 0..1 confidence in the decision. */
  confidence: number;
  signals: string[];
  /** Role to hand a simple task to (always `worker`). */
  suggestedRole: AgentRole;
}

export interface Router {
  route(request: OrchestrationRequest): RouteDecision | Promise<RouteDecision>;
}

export interface RuleRouterOptions {
  /** Complexity score at or above which a request is treated as complex. */
  complexityThreshold?: number;
}

const BUILD_VERBS =
  /\b(build|implement|create|design|refactor|migrate|integrate|scaffold|orchestrate|architect|rewrite|port)\b/g;
const MULTISTEP =
  /\b(and then|then |after that|afterwards|next,|first,|finally|step \d|once .* is)\b/g;
const SIMPLE_LEAD =
  /^\s*(summari[sz]e|explain|what|who|when|where|why|list|show|describe|define|tell me|how many|find)\b/i;
const TRIVIAL_EDIT = /\b(fix (a )?typo|rename|reformat|format|lint|bump version)\b/i;
const BREADTH = /\b(across|whole|entire|codebase|every (file|module)|multiple files|end[- ]to[- ]end)\b/i;
const QUALITY = /\b(test-driven|tdd|spec|acceptance criteria|coverage|ci\b)\b/i;

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export class RuleRouter implements Router {
  private readonly threshold: number;

  constructor(options: RuleRouterOptions = {}) {
    this.threshold = options.complexityThreshold ?? 3;
  }

  route(request: OrchestrationRequest): RouteDecision {
    const text = request.prompt.trim();
    const lower = text.toLowerCase();
    const signals: string[] = [];
    let score = 0;

    const verbs = countMatches(lower, BUILD_VERBS);
    if (verbs > 0) {
      score += Math.min(verbs * 2, 4);
      signals.push(`build/implement verbs ×${verbs}`);
    }

    const steps = countMatches(lower, MULTISTEP);
    if (steps > 0) {
      score += Math.min(steps * 2, 4);
      signals.push(`multi-step connectors ×${steps}`);
    }

    const sentences = countMatches(text, /[.!?]+/g);
    if (sentences >= 3) {
      score += 1;
      signals.push(`${sentences} sentences`);
    }

    const listItems = countMatches(text, /^\s*(?:[-*]|\d+\.)\s+/gm);
    if (listItems >= 2) {
      score += Math.min(listItems, 4);
      signals.push(`${listItems} list items`);
    }

    if (text.length > 280) {
      score += text.length > 600 ? 2 : 1;
      signals.push(`length ${text.length}`);
    }

    // Multiple coordinated clauses ("do X and Y and Z", comma-separated) signal
    // several actions even without explicit step words.
    const coordinations = countMatches(lower, /\band\b/g) + countMatches(text, /,/g);
    if (coordinations >= 2) {
      score += 2;
      signals.push(`${coordinations} coordinated clauses`);
    }

    if (BREADTH.test(lower)) {
      score += 1;
      signals.push('breadth (across/codebase)');
    }
    if (QUALITY.test(lower)) {
      score += 1;
      signals.push('quality bar (tests/spec)');
    }

    const trivial = TRIVIAL_EDIT.test(lower);
    const simpleLead = SIMPLE_LEAD.test(text);
    if (trivial) {
      signals.push('trivial edit');
      score -= 2;
    }
    if (simpleLead && text.length < 200) {
      signals.push('question/lookup lead');
      score -= 1;
    }

    const isComplex = score >= this.threshold;
    const distance = Math.abs(score - this.threshold);
    const confidence = clamp01(0.55 + distance * 0.12);

    return {
      kind: isComplex ? 'complex' : 'simple',
      reason: isComplex
        ? `Complexity score ${score} ≥ threshold ${this.threshold}`
        : `Complexity score ${score} < threshold ${this.threshold}`,
      confidence,
      signals,
      suggestedRole: 'worker',
    };
  }
}

/** Parse a free-form agent classification into a {@link RouteKind}. */
export function parseRouteText(text: string): RouteKind | null {
  const lower = text.toLowerCase();
  const hasComplex = /\bcomplex\b/.test(lower);
  const hasSimple = /\bsimple\b/.test(lower);
  if (hasComplex && !hasSimple) return 'complex';
  if (hasSimple && !hasComplex) return 'simple';
  // If both/neither, prefer the last mentioned.
  const ci = lower.lastIndexOf('complex');
  const si = lower.lastIndexOf('simple');
  if (ci === -1 && si === -1) return null;
  return ci > si ? 'complex' : 'simple';
}

export interface AgentRouterOptions {
  agentId: string;
  model?: string | null;
  fallback?: Router;
  /** Override the classification prompt builder. */
  buildPrompt?: (request: OrchestrationRequest) => string;
}

export function createAgentRouter(
  runtime: Pick<AgentRuntime, 'runAgent'>,
  options: AgentRouterOptions,
): Router {
  const fallback = options.fallback ?? new RuleRouter();
  const buildPrompt =
    options.buildPrompt ??
    ((request: OrchestrationRequest) =>
      [
        'Classify the following request as SIMPLE (a single agent can do it in one shot) ',
        'or COMPLEX (needs planning, multiple steps, or review).',
        'Answer with exactly one word: SIMPLE or COMPLEX.',
        '',
        `Request: ${request.prompt}`,
      ].join('\n'));

  return {
    async route(request: OrchestrationRequest): Promise<RouteDecision> {
      const result = await runtime.runAgent({
        agentId: options.agentId,
        prompt: buildPrompt(request),
        cwd: request.cwd,
        model: options.model,
      });
      const parsed = result.status === 'completed' ? parseRouteText(result.text) : null;
      if (!parsed) return fallback.route(request);
      return {
        kind: parsed,
        reason: `Agent ${options.agentId} classified the request as ${parsed}`,
        confidence: 0.7,
        signals: [`agent:${options.agentId}`],
        suggestedRole: 'worker',
      };
    },
  };
}
