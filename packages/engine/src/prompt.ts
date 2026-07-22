// System-prompt composition for agents. Layers: role guidance + workspace
// briefing (AGENTS.md) + the overarching goal. This is where "prompt self-
// orchestration" hooks in — a planner can shape downstream roles.

import type { Goal } from '@omakase/core';
import type { AgentSpec } from './workflow-types.ts';

const ROLE_GUIDANCE: Record<string, string> = {
  planner:
    'You are a planner. Decompose the objective into concrete, independently buildable steps. Be specific and terse. Do not implement — only plan.',
  worker:
    'You are an implementer. Make the change end-to-end in the working directory. Prefer small, verifiable edits. Run the project’s tests when relevant.',
  reviewer:
    'You are a reviewer. Critically assess the work against the objective and list concrete gaps as bullets. Do not implement fixes.',
  validator:
    'You are a strict validator. Independently judge correctness and completeness. List concrete remaining gaps as bullets, or reply DONE. Do not implement.',
  researcher:
    'You are a researcher. Gather the facts needed to proceed and summarize them precisely with sources.',
};

export interface PromptDeps {
  goal: Goal;
  memory: string;
}

export function makeSystemPromptFactory(deps: PromptDeps): (spec: AgentSpec) => string {
  const memoryBlock = deps.memory.trim()
    ? `\n\n## Workspace briefing (AGENTS.md)\n${deps.memory.trim()}`
    : '';
  const goalBlock = `\n\n## Overarching goal\n${deps.goal.text}`;
  return (spec: AgentSpec): string => {
    const role = spec.role ?? 'worker';
    const guidance = ROLE_GUIDANCE[role] ?? ROLE_GUIDANCE.worker!;
    // Read at call time, not closure time: when the goal-loop stalls it puts an
    // advisor's suggestion on the goal, and every agent dispatched afterwards
    // should see it — including the ones in workflows that never look at params.
    const advice = deps.goal.params?.advice;
    const adviceBlock = typeof advice === 'string' && advice.trim() ? `\n\n## ${advice.trim()}` : '';
    const boundary =
      `\n\n## Assignment boundary\n` +
      `You are one step in an Omakase-owned workflow. Complete only the task message for this turn; ` +
      `the overarching goal below is context, not a request to take over later steps. Do not invoke ` +
      `omks or another AI-agent CLI, spawn subagents, or coordinate the rest of the workflow unless ` +
      `this turn's task message explicitly requires testing that CLI. Return your result to Omakase ` +
      `so dependent steps can consume it.`;
    return `You are an Omakase agent operating autonomously in a shared working directory.\nRole: ${role}.\n${guidance}${boundary}${goalBlock}${adviceBlock}${memoryBlock}\n\nWork decisively within this assignment. When done, summarize what you did in a few lines.`;
  };
}
