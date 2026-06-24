/**
 * Authored memory under `.omks/memory/`: the `AGENTS.md` briefing packet and
 * `rules/*.md` (both user-editable), plus read access to `wiki.md` (the
 * git-friendly projection the knowledge store renders from SQLite).
 */
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
