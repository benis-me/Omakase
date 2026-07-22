// name: goal
// description: General goal achiever — plan, build steps in a pipeline, then validate and fix until the goal's success criteria are met. The default workflow.
// version: 0.1.0
// when_to_use: Any open-ended objective where you want Omakase to plan and drive it to completion.
import type { WorkflowContext, AgentResult } from '../workflow-types.ts';
import { bulletLines } from '@omakase/core';
import { requireAgent, requireAgents } from './shared.ts';

export default async function goal(w: WorkflowContext): Promise<void> {
  const steps = await w.phase('Plan', async () => {
    const res = await w.agent({
      role: 'planner',
      title: 'Plan the work',
      prompt:
        `Break this goal into 2–5 concrete, independently buildable steps, one per line ` +
        `(no preamble):\n\n${w.goal.text}`,
    });
    // Don't mistake an error message for a plan — bail to a single pass instead.
    if (res.status !== 'ok') {
      w.log(`Planner unavailable (${res.text.slice(0, 80)}); proceeding in one pass.`);
      return [];
    }
    return bulletLines(res.text).slice(0, 6);
  });

  if (steps.length === 0) {
    w.log('No steps planned; doing it in one pass.');
    requireAgent(await w.agent({ role: 'worker', title: 'Do it', prompt: w.goal.text }), 'Fallback agent');
  } else {
    w.log(`Planned ${steps.length} step(s).`);
    await w.phase('Build', async () => {
      const reviewed = await w.pipeline(
        steps,
        (_v, step) =>
          w.agent({
            role: 'worker',
            title: `Build: ${String(step).slice(0, 48)}`,
            prompt: `Implement this step fully in the working directory:\n\n${step}\n\nOverall goal: ${w.goal.text}`,
          }),
        (built, step) => {
          const result = requireAgent(built as AgentResult, `Build ${String(step)}`);
          return w.agent({
            role: 'reviewer',
            title: `Review: ${String(step).slice(0, 48)}`,
            prompt:
              `Review the implementation of this step against the goal and list concrete gaps as bullets ` +
              `(or "none"). Step:\n${step}\n\nWhat was done:\n${result.text}`,
          });
        },
      );
      requireAgents(reviewed as AgentResult[], 'Review');
    });
  }

  await w.phase('Validate', async () => {
    await w.loopUntil(
      async (round) => {
        const check = await w.goalMet();
        if (check.met) {
          w.log('✓ Goal criteria met.');
          return [];
        }
        if (check.gaps.length === 0) return [];
        w.log(`Round ${round + 1}: fixing ${check.gaps.length} gap(s).`);
        const fixes = await w.parallel(
          check.gaps.map((gap) => () =>
            w.agent({
              role: 'worker',
              title: 'Fix gap',
              prompt: `Fix this gap so the goal is satisfied:\n\n${gap}\n\nGoal: ${w.goal.text}`,
            }),
          ),
        );
        requireAgents(fixes, 'Gap repair');
        return check.gaps;
      },
      { maxRounds: 3 },
    );
  });

  w.requestReport({
    kind: 'final',
    title: 'Goal run complete',
    summary: `Planned ${steps.length} step(s), built them, and validated against the goal.`,
  });
}
