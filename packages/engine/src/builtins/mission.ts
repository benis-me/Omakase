// name: mission
// description: Plan several features, build + review each independently in a pipeline, then loop-until-dry on remaining gaps.
// version: 0.1.0
// when_to_use: Larger efforts with multiple independent features to build and validate.
import type { WorkflowContext } from '../workflow-types.ts';
import { bulletLines } from '@omakase/core';

export default async function mission(w: WorkflowContext): Promise<void> {
  const features = await w.phase('Plan', async () => {
    const res = await w.agent({
      role: 'planner',
      title: 'Plan features',
      prompt: `List 3 to 6 independently buildable features for this goal, one per line:\n\n${w.goal.text}`,
    });
    return bulletLines(res.text).slice(0, 6);
  });

  const left = w.budget();
  w.log(`Building ${features.length} feature(s); ${left.remainingAgents} agent calls left.`);

  await w.phase('Build', async () => {
    await w.pipeline(
      features,
      (_v, feature) =>
        w.agent({
          role: 'worker',
          title: `Build: ${String(feature).slice(0, 48)}`,
          prompt: `Implement this feature, writing tests first:\n${feature}`,
        }),
      (built, feature) =>
        w.agent({
          role: 'reviewer',
          title: `Review: ${String(feature).slice(0, 48)}`,
          prompt: `Review against the feature and list gaps:\n${feature}\n\n${(built as { text: string }).text}`,
        }),
    );
  });

  await w.phase('Validate', async () => {
    await w.loopUntil(
      async (round) => {
        const verdict = await w.agent({
          role: 'validator',
          title: `Validate (round ${round + 1})`,
          prompt:
            'Independently judge correctness and completeness of the work so far. ' +
            'List concrete remaining gaps as bullets, or reply DONE. Do NOT implement fixes.',
        });
        if (/\bDONE\b/i.test(verdict.text)) return [];
        const gaps = bulletLines(verdict.text);
        if (!gaps.length) return [];
        await w.parallel(
          gaps.map((gap) => () => w.agent({ role: 'worker', title: 'Fix', prompt: `Fix this gap:\n${gap}` })),
        );
        return gaps;
      },
      { maxRounds: 3 },
    );
  });

  w.requestReport({
    kind: 'final',
    title: 'Mission complete',
    summary: `Built and validated ${features.length} feature(s).`,
  });
}
