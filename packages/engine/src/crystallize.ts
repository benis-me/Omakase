// Turn a run that already happened into a workflow you can run again.
//
// Omakase's pitch is that it gets stronger the more you use it, but a
// self-orchestrated run used to evaporate: the model designed a good plan, the
// plan executed, and nothing kept it. The event log is the missing ingredient —
// it records every phase, every agent's role/title/provider/prompt, and (from
// the interleaving of started and completed) which agents were in flight
// together. That is a whole workflow, already written down. This reads it back
// out as source.
//
// It crystallises any run, not only `auto`: the engine watched the execution,
// so nothing has to be re-derived by asking a model to guess what happened.

import { slugify, type AnyRunEvent, type PermissionMode } from '@omakase/core';

interface Step {
  role: string;
  /** Its result was the plan itself — a decision this file now hard-codes. */
  designedThePlan?: boolean;
  title: string;
  provider: string;
  model: string | null;
  agentName: string | null;
  permission: PermissionMode | null;
  isolated: boolean;
  prompt: string;
  workflowStepId: string | null;
  dependsOn: string[];
  phase: string;
  start: number;
  end: number;
}

export interface Crystallized {
  name: string;
  /** `workflow.ts` source. */
  script: string;
  /** `WORKFLOW.md` discovery doc. */
  doc: string;
  phases: string[];
  stepCount: number;
}

const MAX_STEPS = 40;

/**
 * Did this agent's reply hand back an orchestration plan? `auto` asks a planner
 * for `{"steps":[…]}` and then executes it; once that shape is written into
 * source, asking for it again is a turn spent on a decision that is already made.
 */
function looksLikePlan(text: string): boolean {
  if (!text || !text.includes('"steps"')) return false;
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return false;
  try {
    const o = JSON.parse(m[0]) as { steps?: unknown };
    return Array.isArray(o.steps) && o.steps.length > 0;
  } catch {
    return false;
  }
}

/** A prompt in source has to survive being pasted into a template literal. */
function escapeTemplate(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function escapeSingle(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
}

/**
 * Put the goal back where it came from. The run's prompts were written for one
 * specific goal; a reusable workflow has to talk about *its* goal instead, so
 * every occurrence of the original text becomes the interpolation that produced
 * it. Longest-first keeps a goal that contains a shorter quoted fragment from
 * being half-replaced.
 */
function generalize(prompt: string, goalText: string): string {
  const goal = goalText.trim();
  let out = escapeTemplate(prompt);
  if (goal.length >= 8) {
    const needle = escapeTemplate(goal);
    out = out.split(needle).join('${w.goal.text}');
  }
  return out;
}

/**
 * Group a phase's steps into waves of agents that were genuinely in flight
 * together. Two steps belong to the same wave when their [start, end] spans
 * overlap, transitively — which is exactly what `w.parallel` reproduces.
 */
function waves(steps: Step[]): Step[][] {
  const out: Step[][] = [];
  let current: Step[] = [];
  let openUntil = -1;
  for (const s of steps.slice().sort((a, b) => a.start - b.start)) {
    if (current.length === 0 || s.start < openUntil) {
      current.push(s);
      openUntil = Math.max(openUntil, s.end);
    } else {
      out.push(current);
      current = [s];
      openUntil = s.end;
    }
  }
  if (current.length) out.push(current);
  return out;
}

/** The `w.agent({...})` call as individual lines, so callers can indent it. */
function agentCallLines(s: Step, contextVar?: string): string[] {
  const contextSuffix = contextVar
    ? ` + (${contextVar}.length ? '\\n\\n--- Context from earlier steps ---\\n' + ${contextVar}.join('\\n\\n') : '')`
    : '';
  const out = [
    `w.agent({`,
    `  role: '${escapeSingle(s.role)}',`,
    ...(s.agentName ? [`  as: '${escapeSingle(s.agentName)}',`] : []),
    `  title: '${escapeSingle(s.title)}',`,
    // The prompt is a template literal and may be many lines; its interior is
    // left flush so the text an agent receives is not reindented.
    `  prompt: \`${s.prompt}\`${contextSuffix},`,
  ];
  if (s.workflowStepId) {
    out.push(
      `  workflowStep: {`,
      `    id: '${escapeSingle(s.workflowStepId)}',`,
      `    dependsOn: ${JSON.stringify(s.dependsOn)},`,
      `    sourcePrompt: \`${s.prompt}\`,`,
      `  },`,
    );
  }
  if (s.provider) out.push(`  provider: '${escapeSingle(s.provider)}',`);
  if (s.model) out.push(`  model: '${escapeSingle(s.model)}',`);
  if (s.permission) out.push(`  permission: '${s.permission}',`);
  if (s.isolated) out.push(`  isolate: true,`);
  out.push(`})`);
  return out;
}

function requireStepLine(step: Step, resultVar: string): string {
  const label = step.workflowStepId ?? step.title;
  return `if (${resultVar}.status !== 'ok') throw new Error(${JSON.stringify(`Step ${label} failed: `)} + ${resultVar}.text);`;
}

/** Exact DAG waves when a dynamic orchestrator recorded step identities. */
function dependencyWaves(steps: Step[]): Step[][] | null {
  if (steps.length === 0 || steps.some((s) => !s.workflowStepId)) return null;
  const ids = new Set(steps.map((s) => s.workflowStepId!));
  if (ids.size !== steps.length) return null;
  if (steps.some((s) => s.dependsOn.some((id) => !ids.has(id)))) return null;

  const remaining = new Set(steps);
  const completed = new Set<string>();
  const out: Step[][] = [];
  while (remaining.size) {
    const ready = [...remaining].filter((s) => s.dependsOn.every((id) => completed.has(id)));
    if (ready.length === 0) return null; // cycle: do not invent a different graph
    out.push(ready);
    for (const step of ready) {
      remaining.delete(step);
      completed.add(step.workflowStepId!);
    }
  }
  return out;
}

function safeVariable(id: string, index: number): string {
  const clean = id.replace(/[^a-zA-Z0-9_$]/g, '_');
  return `step_${/^\d/.test(clean) ? '_' : ''}${clean || 'result'}_${index}`;
}

/** Indent only the lines this generator owns — never the inside of a prompt. */
function indentCode(lines: string[], pad: string): string[] {
  let inPrompt = false;
  return lines.map((l) => {
    const wasIn = inPrompt;
    const ticks = (l.match(/`/g) ?? []).length;
    if (ticks % 2 === 1) inPrompt = !inPrompt;
    return wasIn ? l : pad + l;
  });
}

/**
 * Rebuild the run as workflow source. Returns null when there is nothing worth
 * saving — a run with no agents is not a workflow.
 */
export function crystallize(opts: {
  name: string;
  goalText: string;
  events: AnyRunEvent[];
  sourceWorkflow: string;
}): Crystallized | null {
  const name = slugify(opts.name);
  if (!name) return null;

  const open = new Map<string, Step>();
  const steps: Step[] = [];
  let phase = '';

  for (const e of opts.events) {
    if (e.type === 'phase:started') phase = e.payload.name;
    else if (e.type === 'agent:started') {
      if (open.has(e.payload.callId)) continue;
      open.set(e.payload.callId, {
        role: e.payload.role,
        title: e.payload.title,
        provider: e.payload.provider,
        model: e.payload.model,
        agentName: e.payload.agentName ?? null,
        permission: e.payload.permission ?? null,
        isolated: e.payload.isolated ?? false,
        // A dynamic workflow can append prior results to the actual prompt. Its
        // source prompt is the reusable part; the data flow is rebuilt below.
        prompt: generalize(e.payload.sourcePrompt ?? e.payload.prompt, opts.goalText),
        workflowStepId: e.payload.workflowStepId ?? null,
        dependsOn: [...(e.payload.dependsOn ?? [])],
        phase,
        start: e.seq,
        end: Number.MAX_SAFE_INTEGER,
      });
    } else if (e.type === 'agent:completed') {
      const s = open.get(e.payload.callId);
      if (s) {
        s.end = e.seq;
        // An agent whose answer *was* the plan has already done its job: the
        // shape it chose is what gets written out below. Re-running it in the
        // saved workflow would spend a turn per run on output nothing reads.
        s.designedThePlan = looksLikePlan(e.payload.text);
        steps.push(s);
        open.delete(e.payload.callId);
      }
    } else if (e.type === 'agent:failed') {
      // A failed or cancelled call is evidence, not a proven recipe step. In
      // particular, never paste its error string into a future workflow.
      open.delete(e.payload.callId);
    }
  }
  // Open calls belong to interrupted runs and are deliberately not reusable.

  const planners = steps.filter((s) => s.designedThePlan).length;
  const kept = steps.filter((s) => !s.designedThePlan).slice(0, MAX_STEPS);
  if (kept.length === 0) return null;
  const phases: string[] = [];
  for (const s of kept) if (!phases.includes(s.phase)) phases.push(s.phase);

  const body: string[] = [];
  for (const p of phases) {
    const phaseSteps = kept.filter((s) => s.phase === p);
    const exactWaves = dependencyWaves(phaseSteps);
    const grouped = exactWaves ?? waves(phaseSteps);
    const resultVars = new Map<Step, string>();
    phaseSteps.forEach((step, index) =>
      resultVars.set(step, safeVariable(step.workflowStepId ?? `result_${index}`, index)),
    );
    const emit: string[] = [];
    if (exactWaves) emit.push(`const stepResults = new Map<string, string>();`);
    for (const wave of grouped) {
      const contextVars = new Map<Step, string>();
      if (exactWaves) {
        for (const step of wave) {
          if (step.dependsOn.length === 0) continue;
          const contextVar = `context_${resultVars.get(step)!}`;
          contextVars.set(step, contextVar);
          emit.push(
            `const ${contextVar} = ${JSON.stringify(step.dependsOn)}.map((id) => stepResults.get(id)).filter((value): value is string => Boolean(value));`,
          );
        }
      }
      if (wave.length === 1) {
        const step = wave[0]!;
        const [head, ...rest] = agentCallLines(step, contextVars.get(step));
        const resultVar = resultVars.get(step)!;
        const prefix = `const ${resultVar} = await `;
        emit.push(`${prefix}${head}`, ...rest.slice(0, -1), `});`);
        emit.push(requireStepLine(step, resultVar));
        if (exactWaves) {
          emit.push(`stepResults.set('${escapeSingle(step.workflowStepId!)}', ${resultVar}.text);`);
        }
      } else {
        const lhs = `const [${wave.map((s) => resultVars.get(s)!).join(', ')}] = `;
        emit.push(`${lhs}await w.parallel([`);
        for (const s of wave) {
          const call = indentCode(agentCallLines(s, contextVars.get(s)), '    ');
          emit.push(`  () =>`, ...call.slice(0, -1), `    }),`);
        }
        emit.push(`]);`);
        for (const step of wave) emit.push(requireStepLine(step, resultVars.get(step)!));
        if (exactWaves) {
          for (const step of wave) {
            emit.push(`stepResults.set('${escapeSingle(step.workflowStepId!)}', ${resultVars.get(step)!}.text);`);
          }
        }
      }
    }
    if (p) {
      body.push(`  await w.phase('${escapeSingle(p)}', async () => {`);
      body.push(...indentCode(emit, '    '));
      body.push(`  });`);
    } else {
      body.push(...indentCode(emit, '  '));
    }
  }

  // Whatever the run's own criteria were, a reusable workflow should still hold
  // itself to the goal it is given.
  body.push('');
  body.push('  await w.loopUntil(async () => {');
  body.push('    const { met, gaps } = await w.goalMet();');
  body.push('    if (met || gaps.length === 0) return [];');
  body.push("    const fixes = await w.parallel(gaps.map((g) => () => w.agent({ role: 'worker', title: 'Fix gap', prompt: `Fix this gap so the goal is satisfied:\\n${g}` })));");
  body.push("    const failedFix = fixes.find((fix) => fix.status !== 'ok');");
  body.push("    if (failedFix) throw new Error(`Gap fix failed: ${failedFix.text}`);");
  body.push('    return gaps;');
  body.push('  }, { maxRounds: 2 });');

  const fnName = name.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')) || 'crystallized';
  const article = /^[aeiou]/i.test(opts.sourceWorkflow) ? 'an' : 'a';
  const description = `Crystallised from ${article} ${opts.sourceWorkflow} run: ${phases.join(' → ') || 'single pass'} across ${kept.length} agent step(s).`;

  const script =
    `// name: ${name}\n` +
    `// description: ${description}\n` +
    `// version: 0.1.0\n` +
    `// when_to_use: For goals shaped like the one this was saved from.\n` +
    `//\n` +
    `// Saved from a real run with \`omks run --save-as\`. The structure is what\n` +
    `// actually executed; the prompts are that run's, with its goal replaced by\n` +
    `// this workflow's own. Edit it freely — it is ordinary TypeScript.\n` +
    `import type { WorkflowContext } from '@omakase/engine';\n` +
    `\n` +
    `export default async function ${fnName}(w: WorkflowContext): Promise<void> {\n` +
    body.join('\n') +
    `\n\n  w.requestReport({ kind: 'final', title: '${escapeSingle(name)} complete', summary: '${escapeSingle(name)} completed ${kept.length} step(s).' });\n` +
    `}\n`;

  const doc =
    `---\n` +
    `name: ${name}\n` +
    `description: ${description}\n` +
    `version: 0.1.0\n` +
    `when_to_use: For goals shaped like the one this was saved from.\n` +
    `---\n\n` +
    `# ${name}\n\n` +
    `Saved from ${article} \`${opts.sourceWorkflow}\` run with \`omks run --save-as ${name}\`.\n\n` +
    (planners
      ? `The planning turn that designed this shape is deliberately not included — ` +
        `the plan it produced is the structure written below.\n\n`
      : '') +
    `## Shape\n\n` +
    phases.map((p) => `- **${p || 'main'}** — ${kept.filter((s) => s.phase === p).map((s) => s.title).join(', ')}`).join('\n') +
    `\n\n## Notes\n\n` +
    `The prompts came from the original run, with its goal text swapped for this\n` +
    `workflow's own goal. Read them before relying on it: anything the original\n` +
    `goal implied but never said is not captured here.\n`;

  return { name, script, doc, phases, stepCount: kept.length };
}
