// A custom Dynamic Workflow. The `import type` is erased at runtime, so this
// file has zero runtime dependencies — it is a pure function of `w`.
import type { WorkflowContext } from '@omakase/engine';

/** Split agent output into clean, de-bulleted lines. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^[-*\d.)\]\s]+/, '').trim())
    .filter(Boolean);
}

export default async function shipFeature(w: WorkflowContext): Promise<void> {
  // 1) Learn from anything earlier runs recorded in this workspace.
  const priorKnowledge = w.recall(5).map((e) => `- ${e.title}`).join('\n');

  // 2) Plan independent, parallel-buildable features.
  const features = await w.phase('Plan', async () => {
    const res = await w.agent({
      role: 'planner',
      title: 'Plan features',
      prompt:
        `Break this goal into 2–4 INDEPENDENT features that can be built in parallel, one per line:\n\n${w.goal.text}` +
        (priorKnowledge ? `\n\nRelevant prior knowledge:\n${priorKnowledge}` : ''),
    });
    return res.status === 'ok' ? lines(res.text).slice(0, 4) : [];
  });

  if (features.length === 0) {
    await w.agent({ role: 'worker', title: 'Do it', prompt: w.goal.text });
  } else {
    w.log(`Building ${features.length} feature(s), each isolated and routed to a provider.`);

    // 3) Build each feature concurrently in its own isolated worktree, routing
    //    it to a provider round-robin across whatever agents are installed.
    await w.phase('Build', async () => {
      await w.parallel(
        features.map((feature, i) => () =>
          w.isolate(`feature-${i}`, (dir) =>
            w.agent({
              role: 'worker',
              title: `Build: ${feature.slice(0, 40)}`,
              cwd: dir,
              ...(w.providers.length ? { provider: w.providers[i % w.providers.length]! } : {}),
              prompt: `Implement this feature end-to-end, writing tests, in the current directory:\n${feature}\n\nOverall goal: ${w.goal.text}`,
            }),
          ),
        ),
      );
    });
  }

  // 4) Validate against the goal and fix any remaining gaps, bounded.
  await w.phase('Validate', async () => {
    await w.loopUntil(
      async () => {
        const { met, gaps } = await w.goalMet();
        if (met || gaps.length === 0) return [];
        await w.parallel(gaps.map((g) => () => w.agent({ role: 'worker', title: 'Fix', prompt: `Fix this gap:\n${g}` })));
        return gaps;
      },
      { maxRounds: 3 },
    );
  });

  // 5) Record what we did so future runs can recall it.
  w.updateWiki({ title: `shipped: ${w.goal.text.slice(0, 50)}`, body: `Built ${features.length} feature(s): ${features.join('; ')}` });
  w.requestReport({ kind: 'final', title: 'Feature shipped', summary: `Built and validated ${features.length} feature(s) in isolation.` });
}
