// name: auto
// description: Prompt self-orchestration — an orchestrator agent designs a bespoke multi-agent plan (a DAG of roles/prompts), which the engine executes with dependencies respected and independent steps run in parallel. The workflow writes itself.
// version: 0.1.0
// when_to_use: When you want Omakase to invent the orchestration for a goal instead of following a fixed workflow.
import type { WorkflowContext } from '../workflow-types.ts';
import { extractJson, bulletLines } from '@omakase/core';

interface PlanStep {
  id: string;
  role?: string;
  title?: string;
  prompt: string;
  provider?: string;
  dependsOn?: string[];
}
interface Plan {
  steps: PlanStep[];
}

export default async function auto(w: WorkflowContext): Promise<void> {
  // Learn from plans that worked in this workspace before.
  const priorRecipes = w
    .recall(30)
    .filter((e) => e.title.startsWith('recipe:'))
    .slice(0, 3);

  const steps = await w.phase('Orchestrate', async () => {
    const res = await w.agent({
      role: 'planner',
      title: 'Design the plan',
      prompt:
        `Design a concrete multi-agent plan to achieve the goal below. Output ONLY JSON:\n` +
        (priorRecipes.length
          ? `Plans that worked before in this workspace (use as inspiration, adapt to THIS goal):\n${priorRecipes.map((r) => r.body).join('\n')}\n`
          : '') +
        `{"steps":[{"id":"s1","role":"worker","title":"short title","prompt":"what this agent must do","provider":"","dependsOn":[]}]}\n` +
        `Rules: 2–6 steps; use dependsOn (step ids) to order work — independent steps run in parallel; ` +
        `role ∈ planner|worker|reviewer|validator|researcher. ` +
        (w.providers.length > 1
          ? `Optionally set "provider" to route a step to the best agent from: ${w.providers.join(', ')} (omit to use the default). `
          : `Leave "provider" empty. `) +
        `No prose outside the JSON.\n\n` +
        `Goal: ${w.goal.text}`,
    });
    if (res.status !== 'ok') return [];
    const plan = extractJson<Plan>(res.text);
    const parsed = plan && Array.isArray(plan.steps) ? plan.steps : [];
    // Fallback: if no valid JSON, treat bullet lines as a linear plan.
    if (parsed.length === 0) {
      return bulletLines(res.text)
        .slice(0, 6)
        .map((line, i): PlanStep => ({ id: `s${i + 1}`, role: 'worker', title: line.slice(0, 40), prompt: line }));
    }
    return parsed.filter((s) => s && typeof s.prompt === 'string' && s.prompt.trim()).slice(0, 8);
  });

  if (steps.length === 0) {
    w.log('No plan produced; doing it in one pass.');
    await w.agent({ role: 'worker', title: 'Do it', prompt: w.goal.text });
  } else {
    w.log(`Self-designed plan: ${steps.length} step(s).`);
    await w.phase('Execute', async () => {
      const done = new Map<string, string>();
      const remaining = new Map(steps.map((s) => [s.id, s]));
      await w.loopUntil(
        async () => {
          if (remaining.size === 0) return [];
          // A step is ready when all of its (known) dependencies have completed.
          let ready = [...remaining.values()].filter((s) =>
            (s.dependsOn ?? []).every((d) => !remaining.has(d)),
          );
          if (ready.length === 0) ready = [...remaining.values()]; // break cycles / unmet deps
          const results = await w.parallel(
            ready.map((s) => () => {
              const ctx = (s.dependsOn ?? []).map((d) => done.get(d)).filter(Boolean);
              const prompt = ctx.length
                ? `${s.prompt}\n\n--- Context from earlier steps ---\n${ctx.join('\n\n')}`
                : s.prompt;
              return w.agent({
                role: s.role ?? 'worker',
                title: s.title ?? s.id,
                prompt,
                ...(s.provider && w.providers.includes(s.provider) ? { provider: s.provider } : {}),
              });
            }),
          );
          ready.forEach((s, i) => {
            done.set(s.id, results[i]?.text ?? '');
            remaining.delete(s.id);
          });
          return remaining.size > 0 ? [1] : [];
        },
        { maxRounds: steps.length + 2 },
      );
    });
  }

  await w.phase('Validate', async () => {
    await w.loopUntil(
      async () => {
        const { met, gaps } = await w.goalMet();
        if (met || gaps.length === 0) return [];
        await w.parallel(gaps.map((g) => () => w.agent({ role: 'worker', title: 'Fix', prompt: `Fix this gap:\n${g}` })));
        return gaps;
      },
      { maxRounds: 2 },
    );
  });

  // Crystallize the plan STRUCTURE (not the goal-specific prompts) as a reusable
  // recipe, so future auto runs get stronger.
  if (steps.length > 0) {
    const recipe = steps.map((s) => ({ id: s.id, role: s.role, title: s.title, provider: s.provider, dependsOn: s.dependsOn ?? [] }));
    w.updateWiki({ title: `recipe: ${w.goal.text.slice(0, 50)}`, body: JSON.stringify({ steps: recipe }) });
  }

  w.requestReport({
    kind: 'final',
    title: 'Auto-orchestrated run complete',
    summary: `Executed a ${steps.length}-step self-designed plan.`,
  });
}
