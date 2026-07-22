// name: research
// description: Decompose a question, investigate sub-questions in parallel, then synthesize a cited answer.
// version: 0.1.0
// when_to_use: To research a topic or codebase question before acting.
import type { WorkflowContext } from '../workflow-types.ts';
import { bulletLines } from '@omakase/core';
import { requireAgent, requireAgents } from './shared.ts';

export default async function research(w: WorkflowContext): Promise<void> {
  const subs = await w.phase('Decompose', async () => {
    const res = await w.agent({
      role: 'planner',
      title: 'Sub-questions',
      prompt: `Break this research question into 3–5 focused sub-questions, one per line:\n\n${w.goal.text}`,
    });
    return bulletLines(requireAgent(res, 'Research planner').text).slice(0, 5);
  });

  const notes = await w.phase('Investigate', async () => {
    return requireAgents(await w.parallel(
      subs.map((q) => () =>
        w.agent({
          role: 'researcher',
          title: `Investigate: ${String(q).slice(0, 48)}`,
          prompt: `Investigate and answer precisely, with evidence/sources:\n${q}`,
        }),
      ),
    ), 'Research');
  });

  await w.phase('Synthesize', async () => {
    const synthesis = await w.agent({
      role: 'planner',
      title: 'Synthesize',
      prompt:
        `Synthesize these findings into a single, well-organized answer to: ${w.goal.text}\n\n` +
        notes.map((n, i) => `## Finding ${i + 1}\n${n.text}`).join('\n\n'),
    });
    requireAgent(synthesis, 'Synthesis');
    w.updateWiki({ title: `Research: ${w.goal.text.slice(0, 60)}`, body: synthesis.text });
    w.requestReport({ kind: 'final', title: 'Research complete', summary: synthesis.text.slice(0, 400) });
  });
}
