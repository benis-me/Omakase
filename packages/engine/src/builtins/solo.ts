// name: solo
// description: One agent, one pass — the simplest workflow. Hand the whole goal to a single provider.
// version: 0.1.0
// when_to_use: Small, self-contained tasks that don't need decomposition.
import type { WorkflowContext } from '../workflow-types.ts';

export default async function solo(w: WorkflowContext): Promise<void> {
  const res = await w.agent({
    role: 'worker',
    title: 'Do the task',
    prompt: w.goal.text,
  });
  w.requestReport({
    kind: 'final',
    title: 'Done',
    summary: res.text.slice(0, 400) || (res.status === 'ok' ? 'Completed.' : 'Failed.'),
  });
}
