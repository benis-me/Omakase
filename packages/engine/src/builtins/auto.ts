// name: auto
// description: Prompt self-orchestration — an orchestrator agent designs a bespoke multi-agent plan (a DAG of roles/prompts), which the engine executes with dependencies respected and independent steps run in parallel. The workflow writes itself.
// version: 0.1.0
// when_to_use: When you want Omakase to invent the orchestration for a goal instead of following a fixed workflow.
import type { WorkflowContext, AgentResult } from '../workflow-types.ts';
import { extractJson, bulletLines } from '@omakase/core';

interface PlanStep {
  id: string;
  role?: string;
  title?: string;
  prompt: string;
  provider?: string;
  /** A named definition from `.omks/agents/`. */
  agent?: string;
  /** Ask for a private working copy — the way two writers avoid each other. */
  isolate?: boolean;
  dependsOn?: string[];
}
interface Plan {
  steps: PlanStep[];
}

export default async function auto(w: WorkflowContext): Promise<void> {
  const agentNames = w.agentNames;
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
        `{"steps":[{"id":"s1","role":"worker","title":"short title","prompt":"what this agent must do","provider":"","agent":"","isolate":false,"dependsOn":[]}]}\n` +
        `Rules: 2–6 steps; use dependsOn (step ids) to order work — independent steps run in parallel; ` +
        `set "isolate": true on any step that WRITES FILES and runs in parallel with another writer — ` +
        `it then gets its own working copy, merged back when it finishes (read-only steps do not need it); ` +
        (agentNames.length
          ? `you may set "agent" to one of the workspace's defined agents: ${agentNames.join(', ')}. `
          : '') +
        `role ∈ planner|worker|reviewer|validator|researcher. ` +
        (w.goal.provider
          ? `The run pins provider "${w.goal.provider}"; leave "provider" empty on every step. `
          : w.providers.length > 1
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
    const fallback = await w.agent({ role: 'worker', title: 'Do it', prompt: w.goal.text });
    if (fallback.status !== 'ok') throw new Error(`Fallback agent failed: ${fallback.text}`);
  } else {
    w.log(`Self-designed plan: ${steps.length} step(s).`);
    await w.phase('Execute', async () => {
      const done = new Map<string, AgentResult>();
      const failed = new Set<string>();
      const skipped = new Set<string>();
      const remaining = new Map(steps.map((s) => [s.id, s]));
      await w.loopUntil(
        async () => {
          if (remaining.size === 0) return [];
          // A step is ready when all of its (known) dependencies have completed.
          let ready = [...remaining.values()].filter((s) =>
            (s.dependsOn ?? []).every((d) => !remaining.has(d)),
          );
          if (ready.length === 0) ready = [...remaining.values()]; // break cycles / unmet deps

          // A dependent step cannot meaningfully run on an error string. Keep
          // unrelated branches moving, but make failure propagation explicit.
          const blocked = ready.filter((s) =>
            (s.dependsOn ?? []).some((d) => failed.has(d) || skipped.has(d)),
          );
          for (const s of blocked) {
            skipped.add(s.id);
            remaining.delete(s.id);
            w.log(`Skipped ${s.id} (${s.title ?? s.id}): a dependency failed.`);
          }
          ready = ready.filter((s) => !skipped.has(s.id));

          const results = await w.parallel(
            ready.map((s) => () => {
              const ctx = (s.dependsOn ?? [])
                .map((d) => done.get(d))
                .filter((r): r is AgentResult => r?.status === 'ok')
                .map((r) => r.text)
                .filter(Boolean);
              const prompt = ctx.length
                ? `${s.prompt}\n\n--- Context from earlier steps ---\n${ctx.join('\n\n')}`
                : s.prompt;
              return w.agent({
                role: s.role ?? 'worker',
                title: s.title ?? s.id,
                prompt,
                ...(s.agent ? { as: s.agent } : {}),
                // Steps that run together and both write need separate trees.
                ...(s.isolate ? { isolate: true } : {}),
                ...(!w.goal.provider && s.provider && w.providers.includes(s.provider) ? { provider: s.provider } : {}),
                workflowStep: {
                  id: s.id,
                  dependsOn: s.dependsOn ?? [],
                  sourcePrompt: s.prompt,
                },
              });
            }),
          );
          ready.forEach((s, i) => {
            const result = results[i];
            if (result) done.set(s.id, result);
            if (!result || result.status !== 'ok') failed.add(s.id);
            remaining.delete(s.id);
          });
          return remaining.size > 0 ? [1] : [];
        },
        { maxRounds: steps.length + 2 },
      );

      if (failed.size || skipped.size) {
        const failedList = [...failed].join(', ') || 'none';
        const skippedList = [...skipped].join(', ') || 'none';
        throw new Error(`Self-designed plan incomplete (failed: ${failedList}; skipped: ${skippedList}).`);
      }
    });
  }

  await w.phase('Validate', async () => {
    await w.loopUntil(
      async () => {
        const { met, gaps } = await w.goalMet();
        if (met || gaps.length === 0) return [];
        const fixes = await w.parallel(gaps.map((g) => () => w.agent({ role: 'worker', title: 'Fix', prompt: `Fix this gap:\n${g}` })));
        const failed = fixes.filter((r) => r.status !== 'ok');
        if (failed.length) throw new Error(`Gap repair failed: ${failed.map((r) => r.text).join('; ')}`);
        return gaps;
      },
      { maxRounds: 2 },
    );
  });

  // Crystallize the plan STRUCTURE (not the goal-specific prompts) as a reusable
  // recipe, so future auto runs get stronger.
  if (steps.length > 0) {
    const recipe = steps.map((s) => ({
      id: s.id,
      role: s.role,
      title: s.title,
      provider: s.provider,
      agent: s.agent,
      isolate: s.isolate,
      dependsOn: s.dependsOn ?? [],
    }));
    w.updateWiki({ title: `recipe: ${w.goal.text.slice(0, 50)}`, body: JSON.stringify({ steps: recipe }) });
  }

  w.requestReport({
    kind: 'final',
    title: 'Auto-orchestrated run complete',
    summary: `Executed a ${steps.length}-step self-designed plan.`,
  });
}
