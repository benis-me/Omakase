/**
 * Custom slash commands under `.omks/commands/<name>.md`. Optional frontmatter
 * carries a `description`; the body is the command prompt template (with
 * `$ARGUMENTS` expansion handled by the caller). The filename is the command name.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { commandsDir } from './workspace.js';
import { asString, parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';

export interface CommandDoc {
  name: string;
  description: string;
  body: string;
}

const commandFile = (root: string, name: string): string =>
  path.join(commandsDir(root), `${name}.md`);

export function listCommands(root: string): CommandDoc[] {
  let entries: string[];
  try {
    entries = readdirSync(commandsDir(root));
  } catch {
    return [];
  }
  const commands: CommandDoc[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const command = readCommand(root, entry.slice(0, -'.md'.length));
    if (command) commands.push(command);
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

export function readCommand(root: string, name: string): CommandDoc | null {
  try {
    const doc = parseFrontmatter(readFileSync(commandFile(root, name), 'utf8'));
    return { name, description: asString(doc.data.description), body: doc.body };
  } catch {
    return null;
  }
}

export function writeCommand(root: string, command: CommandDoc): void {
  mkdirSync(commandsDir(root), { recursive: true });
  const text = command.description
    ? stringifyFrontmatter({ description: command.description }, command.body)
    : command.body;
  writeFileSync(commandFile(root, command.name), text, 'utf8');
}

export function deleteCommand(root: string, name: string): void {
  rmSync(commandFile(root, name), { force: true });
}
