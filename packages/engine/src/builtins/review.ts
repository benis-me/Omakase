// name: review
// description: Review the working directory across several dimensions in parallel, adversarially verify findings, and report.
// version: 0.1.0
// when_to_use: To audit existing code for bugs, quality and security without changing it.
// disable-model-invocation: false
import type { WorkflowContext } from '../workflow-types.ts';
import { bulletLines } from '@omakase/core';
import { requireAgents } from './shared.ts';

const DIMENSIONS = [
  { key: 'correctness', prompt: 'Find correctness bugs and logic errors.' },
  { key: 'security', prompt: 'Find security issues (injection, secrets, unsafe I/O).' },
  { key: 'quality', prompt: 'Find quality/simplification opportunities and dead code.' },
];

export default async function review(w: WorkflowContext): Promise<void> {
  const findings = await w.phase('Review', async () => {
    const perDim = await w.parallel(
      DIMENSIONS.map((d) => () =>
        w.agent({
          role: 'reviewer',
          title: `Review: ${d.key}`,
          prompt: `${d.prompt}\nContext/goal: ${w.goal.text}\nList each finding as a bullet with file:line and a one-line description. Do not modify anything.`,
        }),
      ),
    );
    requireAgents(perDim, 'Review dimension');
    return perDim.flatMap((r) => bulletLines(r.text).map((f) => ({ dim: 'finding', text: f })));
  });

  const confirmed = await w.phase('Verify', async () => {
    const verdicts = await w.parallel(
      findings.slice(0, 24).map((f) => () =>
        w.agent({
          role: 'validator',
          title: 'Verify finding',
          prompt: `Adversarially verify this finding by inspecting the code. Reply "REAL: <why>" or "NOTREAL: <why>". Default to NOTREAL if unsure.\n\n${f.text}`,
        }),
      ),
    );
    requireAgents(verdicts, 'Finding verification');
    return verdicts.filter((v) => /^\s*REAL\b/i.test(v.text.trim())).map((v) => v.text);
  });

  w.requestReport({
    kind: 'review',
    title: 'Review complete',
    summary: `${confirmed.length} confirmed finding(s) out of ${findings.length} raised.`,
  });
}
