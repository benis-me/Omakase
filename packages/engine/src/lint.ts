// Static checks for workflow scripts, aimed at one specific hazard: resume.
//
// `agent()` results are cached by the call's *structural position* — "the third
// agent inside the Build phase" — not by what it asked for. That is what makes
// resume work across parallel and pipeline. It also means a workflow whose shape
// depends on the clock or a coin flip is quietly broken on resume: the second
// run takes a different branch, the cache hands position three's old result to
// whatever now occupies position three, and the workflow accepts an answer to a
// question it never asked. Nothing raises. It is verifiably real:
//
//   run    → asked for HEADS, got RESULT-FOR-HEADS
//   resume → asked for TAILS, got RESULT-FOR-HEADS
//
// So nondeterminism is an error here, not a style opinion. Timestamps and
// randomness belong in `--param`, where they are recorded with the run and
// replay identically.

export type FindingLevel = 'error' | 'warning';

export interface Finding {
  level: FindingLevel;
  line: number;
  rule: string;
  message: string;
}

export interface LintResult {
  findings: Finding[];
  /** True when nothing at `error` level was found. */
  ok: boolean;
}

/**
 * Blank out comments and string/template bodies, preserving every offset and
 * newline so line numbers still line up. Scanning the result means a rule can
 * never fire on the word "Math.random()" sitting inside a prompt or a comment —
 * which is most of what makes naive regex linting useless.
 */
export function codeOnly(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  // Template literals nest: `${ `inner` }`. Track the depth of ${ } we are in.
  const tmpl: number[] = [];
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        if (src[j] === '\n') break;
        j++;
      }
      blank(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      // Walk the template, blanking literal chunks but leaving ${...} code alone.
      let j = i + 1;
      blank(i, i + 1);
      while (j < src.length) {
        if (src[j] === '\\') {
          blank(j, j + 2);
          j += 2;
          continue;
        }
        if (src[j] === '`') {
          blank(j, j + 1);
          j++;
          break;
        }
        if (src[j] === '$' && src[j + 1] === '{') {
          blank(j, j + 2);
          j += 2;
          tmpl.push(1);
          let depth = 1;
          // Hand the interpolation back to the normal scanner by advancing i.
          while (j < src.length && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            if (depth === 0) break;
            j++;
          }
          tmpl.pop();
          j++;
          continue;
        }
        blank(j, j + 1);
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

interface Rule {
  name: string;
  level: FindingLevel;
  pattern: RegExp;
  message: string;
}

/**
 * Each pattern is checked against code with comments and string bodies removed,
 * so a rule fires on real calls only. Shadowing (`const Math = …`) is not
 * modelled — it does not happen in workflow scripts, and pretending otherwise
 * would cost an AST dependency this package does not carry.
 */
const RULES: Rule[] = [
  {
    name: 'no-random',
    level: 'error',
    pattern: /\bMath\s*\.\s*random\s*\(/g,
    message: 'Math.random() makes the workflow non-replayable; resume would serve cached results to different calls. Pass randomness in via --param.',
  },
  {
    name: 'no-clock',
    level: 'error',
    pattern: /\bDate\s*\.\s*now\s*\(|new\s+Date\s*\(\s*\)/g,
    message: 'reading the clock makes the workflow non-replayable; resume would serve cached results to different calls. Pass timestamps in via --param.',
  },
  {
    name: 'no-random-uuid',
    level: 'error',
    pattern: /\bcrypto\s*\.\s*randomUUID\s*\(/g,
    message: 'crypto.randomUUID() makes the workflow non-replayable. Derive ids from the goal or pass them via --param.',
  },
  {
    name: 'no-perf-clock',
    level: 'error',
    pattern: /\bperformance\s*\.\s*now\s*\(/g,
    message: 'performance.now() makes the workflow non-replayable. Pass timings in via --param.',
  },
];

const DISPATCHES = /\bw\s*\.\s*(agent|parallel|pipeline|spawn)\s*\(/;
const PHASES = /\bw\s*\.\s*phase\s*\(/;

/** Check one workflow script. */
export function lintWorkflow(src: string): LintResult {
  const code = codeOnly(src);
  const findings: Finding[] = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(code))) {
      findings.push({ level: rule.level, line: lineOf(code, m.index), rule: rule.name, message: rule.message });
    }
  }

  // Advisory: shape problems that are suspicious but legal.
  if (!DISPATCHES.test(code)) {
    findings.push({
      level: 'warning',
      line: 1,
      rule: 'no-dispatch',
      message: 'no w.agent / w.parallel / w.pipeline call — this workflow never dispatches an agent.',
    });
  } else if (!PHASES.test(code)) {
    findings.push({
      level: 'warning',
      line: 1,
      rule: 'no-phase',
      message: 'no w.phase() — the run will report progress as one undifferentiated block.',
    });
  }

  findings.sort((a, b) => a.line - b.line);
  return { findings, ok: !findings.some((f) => f.level === 'error') };
}
