// name: tdd
// description: Red → Green → Refactor for each behaviour, run as an independent pipeline.
// version: 0.1.0
// when_to_use: When you want the work built strictly test-first.
import type { WorkflowContext, AgentResult } from '../workflow-types.ts';
import { bulletLines } from '@omakase/core';
import { requireAgent, requireAgents } from './shared.ts';

export default async function tdd(w: WorkflowContext): Promise<void> {
  const behaviours = await w.phase('Plan', async () => {
    const res = await w.agent({
      role: 'planner',
      title: 'List behaviours',
      prompt: `List the behaviours to build test-first for this goal, one per line:\n\n${w.goal.text}`,
    });
    return bulletLines(requireAgent(res, 'Behaviour planner').text).slice(0, 8);
  });

  await w.phase('Cycle', async () => {
    const refactored = await w.pipeline(
      behaviours,
      (_v, b) => w.agent({ role: 'worker', title: `Red: ${String(b).slice(0, 40)}`, prompt: `Write a FAILING test for this behaviour, then stop:\n${b}` }),
      (red, b) => {
        requireAgent(red as AgentResult, `Red ${String(b)}`);
        return w.agent({ role: 'worker', title: `Green: ${String(b).slice(0, 40)}`, prompt: `Write the minimum code to make the test pass:\n${b}` });
      },
      (green, b) => {
        requireAgent(green as AgentResult, `Green ${String(b)}`);
        return w.agent({ role: 'worker', title: `Refactor: ${String(b).slice(0, 40)}`, prompt: `Refactor while keeping all tests green:\n${b}` });
      },
    );
    requireAgents(refactored as AgentResult[], 'Refactor');
  });

  w.requestReport({
    kind: 'final',
    title: 'TDD complete',
    summary: `Implemented ${behaviours.length} behaviour(s) test-first.`,
  });
}
