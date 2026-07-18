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

import { slugify, type AnyRunEvent } from '@omakase/core';

interface Step {
  role: string;
  title: string;
  provider: string;
  prompt: string;
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
function agentCallLines(s: Step): string[] {
  const out = [
    `w.agent({`,
    `  role: '${escapeSingle(s.role)}',`,
    `  title: '${escapeSingle(s.title)}',`,
    // The prompt is a template literal and may be many lines; its interior is
    // left flush so the text an agent receives is not reindented.
    `  prompt: \`${s.prompt}\`,`,
  ];
  if (s.provider) out.push(`  provider: '${escapeSingle(s.provider)}',`);
  out.push(`})`);
  return out;
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
      // A retried agent re-announces itself; keep the first sighting so the
      // saved workflow has one step per intended call, not one per attempt.
      if (open.has(e.payload.callId) || steps.some((s) => s.title === e.payload.title && s.phase === phase)) continue;
      open.set(e.payload.callId, {
        role: e.payload.role,
        title: e.payload.title,
        provider: e.payload.provider,
        prompt: generalize(e.payload.prompt, opts.goalText),
        phase,
        start: e.seq,
        end: Number.MAX_SAFE_INTEGER,
      });
    } else if (e.type === 'agent:completed' || e.type === 'agent:failed') {
      const s = open.get(e.payload.callId);
      if (s) {
        s.end = e.seq;
        steps.push(s);
        open.delete(e.payload.callId);
      }
    }
  }
  // An agent still open at the end (a cancel) still describes a real step.
  for (const s of open.values()) steps.push(s);
  if (steps.length === 0) return null;

  const kept = steps.slice(0, MAX_STEPS);
  const phases: string[] = [];
  for (const s of kept) if (!phases.includes(s.phase)) phases.push(s.phase);

  const body: string[] = [];
  for (const p of phases) {
    const grouped = waves(kept.filter((s) => s.phase === p));
    const emit: string[] = [];
    for (const wave of grouped) {
      if (wave.length === 1) {
        const [head, ...rest] = agentCallLines(wave[0]!);
        emit.push(`await ${head}`, ...rest.slice(0, -1), `});`);
      } else {
        emit.push(`await w.parallel([`);
        for (const s of wave) {
          const call = indentCode(agentCallLines(s), '    ');
          emit.push(`  () =>`, ...call.slice(0, -1), `    }),`);
        }
        emit.push(`]);`);
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
  body.push("    await w.parallel(gaps.map((g) => () => w.agent({ role: 'worker', title: 'Fix gap', prompt: `Fix this gap so the goal is satisfied:\\n${g}` })));");
  body.push('    return gaps;');
  body.push('  }, { maxRounds: 2 });');

  const fnName = name.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')) || 'crystallized';
  const description = `Crystallised from a ${opts.sourceWorkflow} run: ${phases.join(' → ') || 'single pass'} across ${kept.length} agent step(s).`;

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
    `\n\n  w.requestReport({ kind: 'final', title: '${escapeSingle(name)} complete', summary: \`Ran ${kept.length} step(s) against: \${w.goal.text}\` });\n` +
    `}\n`;

  const doc =
    `---\n` +
    `name: ${name}\n` +
    `description: ${description}\n` +
    `---\n\n` +
    `# ${name}\n\n` +
    `Saved from a \`${opts.sourceWorkflow}\` run with \`omks run --save-as ${name}\`.\n\n` +
    `## Shape\n\n` +
    phases.map((p) => `- **${p || 'main'}** — ${kept.filter((s) => s.phase === p).map((s) => s.title).join(', ')}`).join('\n') +
    `\n\n## Notes\n\n` +
    `The prompts came from the original run, with its goal text swapped for this\n` +
    `workflow's own goal. Read them before relying on it: anything the original\n` +
    `goal implied but never said is not captured here.\n`;

  return { name, script, doc, phases, stepCount: kept.length };
}
