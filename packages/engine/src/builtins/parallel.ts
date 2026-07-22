// name: parallel
// description: Plan independent components and build them concurrently, each in its OWN isolated subdirectory so agents never edit the same files.
// version: 0.1.0
// when_to_use: When the goal splits into independent pieces that can be built in parallel without conflicts.
import type { WorkflowContext } from '../workflow-types.ts';
import { bulletLines, slugify } from '@omakase/core';
import { requireAgent, requireAgents } from './shared.ts';

export default async function parallel(w: WorkflowContext): Promise<void> {
  const components = await w.phase('Plan', async () => {
    const res = await w.agent({
      role: 'planner',
      title: 'Plan components',
      prompt: `List 2–5 INDEPENDENT components for this goal that can be built in separate folders, one per line:\n\n${w.goal.text}`,
    });
    return res.status === 'ok' ? bulletLines(res.text).slice(0, 5) : [];
  });

  if (components.length === 0) {
    requireAgent(await w.agent({ role: 'worker', title: 'Do it', prompt: w.goal.text }), 'Fallback agent');
  } else {
    w.log(`Building ${components.length} component(s) in isolated subdirs.`);
    await w.phase('Build', async () => {
      const built = await w.parallel(
        components.map((component) => () => {
          const dir = slugify(String(component));
          w.subdir(dir);
          return w.agent({
            role: 'worker',
            title: `Build: ${String(component).slice(0, 40)}`,
            cwd: dir,
            prompt: `Build this component entirely inside the current directory (it is yours alone):\n${component}\n\nGoal: ${w.goal.text}`,
          });
        }),
      );
      requireAgents(built, 'Component build');
    });
  }

  await w.phase('Validate', async () => {
    await w.loopUntil(async () => {
      const { met, gaps } = await w.goalMet();
      if (met || gaps.length === 0) return [];
      const fixes = await w.parallel(gaps.map((g) => () => w.agent({ role: 'worker', title: 'Fix', prompt: `Fix this gap:\n${g}` })));
      requireAgents(fixes, 'Gap repair');
      return gaps;
    }, { maxRounds: 2 });
  });

  w.requestReport({ kind: 'final', title: 'Parallel build complete', summary: `Built ${components.length} isolated component(s).` });
}
