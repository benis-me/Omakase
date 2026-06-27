/**
 * Authored memory under `.omks/memory/`: the `AGENTS.md` briefing packet and
 * `rules/*.md` (both user-editable), plus read access to `wiki.md` (the
 * git-friendly projection the knowledge store renders from SQLite).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { memoryDir, rulesDir } from './workspace.js';

const agentsMdFile = (root: string): string => path.join(memoryDir(root), 'AGENTS.md');
const wikiMdFile = (root: string): string => path.join(memoryDir(root), 'wiki.md');
const ruleFile = (root: string, name: string): string => path.join(rulesDir(root), `${name}.md`);

export function readAgentsMd(root: string): string {
  try {
    return readFileSync(agentsMdFile(root), 'utf8');
  } catch {
    return '';
  }
}

export function writeAgentsMd(root: string, text: string): void {
  mkdirSync(memoryDir(root), { recursive: true });
  writeFileSync(agentsMdFile(root), text, 'utf8');
}

/** The rendered wiki markdown (read-only; the knowledge store owns it). */
export function readWikiMarkdown(root: string): string {
  try {
    return readFileSync(wikiMdFile(root), 'utf8');
  } catch {
    return '';
  }
}

export interface RuleDoc {
  name: string;
  body: string;
}

export function listRules(root: string): RuleDoc[] {
  let entries: string[];
  try {
    entries = readdirSync(rulesDir(root));
  } catch {
    return [];
  }
  const rules: RuleDoc[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -'.md'.length);
    try {
      rules.push({ name, body: readFileSync(ruleFile(root, name), 'utf8') });
    } catch {
      // skip unreadable rule file
    }
  }
  return rules.sort((a, b) => a.name.localeCompare(b.name));
}

export function writeRule(root: string, name: string, body: string): void {
  mkdirSync(rulesDir(root), { recursive: true });
  writeFileSync(ruleFile(root, name), body, 'utf8');
}

export function deleteRule(root: string, name: string): void {
  rmSync(ruleFile(root, name), { force: true });
}

/**
 * Entropy guardrail (P3). Instruction-level memory — `AGENTS.md` and `rules/*.md`
 * — biases every future run, so an autonomous agent silently rewriting it is the
 * classic self-poisoning failure mode. We can't mediate the external agent CLI's
 * file writes, so instead we fingerprint instruction memory before a run and
 * audit it after: any drift on an unattended run is surfaced for human review.
 */
export interface InstructionMemorySnapshot {
  /** sha256 of `AGENTS.md` content ('' when absent). */
  agents: string;
  /** ruleName → sha256 of that rule's body. */
  rules: Record<string, string>;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function snapshotInstructionMemory(root: string): InstructionMemorySnapshot {
  const rules: Record<string, string> = {};
  for (const rule of listRules(root)) rules[rule.name] = sha256(rule.body);
  return { agents: sha256(readAgentsMd(root)), rules };
}

export interface InstructionMemoryDrift {
  agentsChanged: boolean;
  /** Rule names added, modified, or removed (sorted, de-duplicated). */
  changedRules: string[];
}

export function diffInstructionMemory(
  before: InstructionMemorySnapshot,
  after: InstructionMemorySnapshot,
): InstructionMemoryDrift {
  const names = new Set([...Object.keys(before.rules), ...Object.keys(after.rules)]);
  const changedRules = [...names].filter((n) => before.rules[n] !== after.rules[n]).sort();
  return { agentsChanged: before.agents !== after.agents, changedRules };
}

/** Whether any instruction-level memory changed between two snapshots. */
export function instructionMemoryDrifted(drift: InstructionMemoryDrift): boolean {
  return drift.agentsChanged || drift.changedRules.length > 0;
}

/** A short human-readable summary of what drifted, for notifications. */
export function describeInstructionDrift(drift: InstructionMemoryDrift): string {
  const parts: string[] = [];
  if (drift.agentsChanged) parts.push('AGENTS.md');
  if (drift.changedRules.length > 0) {
    parts.push(`${drift.changedRules.length} rule(s): ${drift.changedRules.join(', ')}`);
  }
  return parts.join('; ');
}
