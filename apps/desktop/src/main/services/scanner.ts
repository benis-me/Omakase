/**
 * Scan a workspace folder (and any registered project roots) into projects with
 * runnable scripts. Ported/adapted from DevDock's Scanner: detects npm scripts
 * (incl. monorepo packages via `workspaces` / pnpm-workspace.yaml), Makefile /
 * docker-compose / Cargo / Deno targets, `.env*` files, and a display type.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import { parse as parseYaml } from 'yaml';
import type { PackageManager, ProjectInfo, ScriptInfo, ScriptKind } from '@shared/types';

const ENV_FILE = /^\.env(\..+)?$/;
const LONG_RUNNING_NAME = /^(dev|start|serve|watch|preview)(:|$)/i;
const LONG_RUNNING_CMD =
  /(vite(?!st)\b|next\s+dev|nuxt\s+dev|webpack(\s+serve|-dev-server)|react-scripts\s+start|vue-cli-service\s+serve|astro\s+dev|remix\s+dev|nodemon|tsc\s+-w|--watch)/i;

export function classifyScript(name: string, command: string): ScriptKind {
  if (LONG_RUNNING_NAME.test(name)) return 'long-running';
  if (/\bbuild\b/.test(command) && !/(--watch|(^|\s)-w(\s|$))/.test(command)) return 'one-shot';
  if (LONG_RUNNING_CMD.test(command)) return 'long-running';
  return 'one-shot';
}

function detectPackageManager(dir: string): PackageManager {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  if (existsSync(join(dir, 'package.json'))) return 'npm';
  return null;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function relOf(workspaceRoot: string, dir: string): string {
  const r = relative(workspaceRoot, dir).split(sep).join('/');
  if (r === '') return '.';
  return r.startsWith('..') ? basename(dir) : r;
}

interface RawProject {
  rel: string;
  name: string;
  path: string;
  scripts: ScriptInfo[];
}

async function buildProject(workspaceRoot: string, pkgDir: string): Promise<RawProject | null> {
  const pkg = await readJson(join(pkgDir, 'package.json'));
  if (!pkg) return null;
  const rel = relOf(workspaceRoot, pkgDir);
  const scriptsObj = (pkg.scripts as Record<string, string> | undefined) ?? {};
  const scripts: ScriptInfo[] = Object.entries(scriptsObj).map(([name, command]) => ({
    id: `${rel}::${name}`,
    name,
    command,
    cwd: pkgDir,
    projectRel: rel,
    kind: classifyScript(name, command),
  }));
  return { rel, name: (pkg.name as string | undefined) ?? rel, path: pkgDir, scripts };
}

async function workspacePatterns(root: string): Promise<string[]> {
  const patterns: string[] = [];
  const rootPkg = await readJson(join(root, 'package.json'));
  const ws = rootPkg?.workspaces;
  if (Array.isArray(ws)) patterns.push(...(ws as string[]));
  else if (ws && Array.isArray((ws as { packages?: string[] }).packages)) {
    patterns.push(...((ws as { packages: string[] }).packages));
  }
  const pnpmFile = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpmFile)) {
    try {
      const parsed = parseYaml(await readFile(pnpmFile, 'utf8')) as { packages?: string[] } | null;
      if (Array.isArray(parsed?.packages)) patterns.push(...parsed.packages);
    } catch {
      /* malformed yaml */
    }
  }
  return patterns;
}

async function extraScripts(workspaceRoot: string, root: string): Promise<ScriptInfo[]> {
  const out: ScriptInfo[] = [];
  const rel = relOf(workspaceRoot, root);
  const add = (source: string, name: string, command: string, kind?: ScriptKind): void => {
    out.push({
      id: `${rel}::${source}:${name}`,
      name,
      command,
      cwd: root,
      projectRel: rel,
      kind: kind ?? classifyScript(name, command),
    });
  };
  const read = async (f: string): Promise<string | null> => {
    try {
      return await readFile(join(root, f), 'utf8');
    } catch {
      return null;
    }
  };
  const firstExisting = (names: string[]): string | null =>
    names.find((f) => existsSync(join(root, f))) ?? null;

  const mk = firstExisting(['Makefile', 'makefile', 'GNUmakefile']);
  if (mk) {
    const targets = new Set<string>();
    for (const line of ((await read(mk)) ?? '').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/);
      if (m && !m[1].startsWith('.')) targets.add(m[1]);
    }
    for (const t of [...targets].slice(0, 50)) add('make', t, `make ${t}`);
  }

  const compose = firstExisting(['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']);
  if (compose) {
    try {
      const doc = parseYaml((await read(compose)) ?? '') as { services?: Record<string, unknown> } | null;
      for (const svc of Object.keys(doc?.services ?? {})) {
        add('compose', svc, `docker compose up ${svc}`, 'long-running');
      }
    } catch {
      /* ignore */
    }
  }

  if (existsSync(join(root, 'Cargo.toml'))) {
    add('cargo', 'run', 'cargo run', 'long-running');
    add('cargo', 'build', 'cargo build', 'one-shot');
    add('cargo', 'test', 'cargo test', 'one-shot');
  }

  const deno = firstExisting(['deno.json', 'deno.jsonc']);
  if (deno) {
    try {
      const raw = ((await read(deno)) ?? '').replace(/^\s*\/\/.*$/gm, '');
      const cfg = JSON.parse(raw) as { tasks?: Record<string, string> };
      for (const t of Object.keys(cfg?.tasks ?? {})) add('deno', t, `deno task ${t}`);
    } catch {
      /* ignore */
    }
  }
  return out;
}

async function scanEnvFiles(projectDir: string): Promise<string[]> {
  try {
    const entries = await readdir(projectDir);
    return entries.filter((e) => ENV_FILE.test(e)).sort();
  } catch {
    return [];
  }
}

async function detectType(root: string, scripts: ScriptInfo[], pm: PackageManager): Promise<string | null> {
  const has = (f: string): boolean => existsSync(join(root, f));
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    /* ignore */
  }
  const anyEnds = (...exts: string[]): boolean => entries.some((e) => exts.some((x) => e.endsWith(x)));
  if (anyEnds('.xcodeproj', '.xcworkspace')) return 'Xcode';
  if (has('Package.swift')) return 'Swift';
  if (has('pubspec.yaml')) return 'Flutter';
  if (has('build.gradle') || has('build.gradle.kts') || has('pom.xml')) return 'JVM';
  const text = scripts.map((s) => s.command.toLowerCase()).join('\n');
  const cmd = (re: RegExp): boolean => re.test(text);
  if (cmd(/\bnext\s+(dev|build|start)/)) return 'Next.js';
  if (cmd(/\bnuxt\b/)) return 'Nuxt';
  if (cmd(/\bastro\b/)) return 'Astro';
  if (cmd(/\bremix\b/)) return 'Remix';
  if (cmd(/\bexpo\b/)) return 'Expo';
  if (cmd(/\belectron(-vite)?\b/)) return 'Electron';
  if (cmd(/sveltekit|svelte-kit|\bsvelte\b/)) return 'Svelte';
  if (cmd(/@angular|(^|\s)ng\s/)) return 'Angular';
  if (cmd(/\bvite(?!st)\b/)) return 'Vite';
  if (has('go.mod')) return 'Go';
  if (has('Cargo.toml')) return 'Rust';
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) return 'Python';
  if (has('deno.json') || has('deno.jsonc')) return 'Deno';
  if (has('package.json')) return pm;
  return null;
}

async function scanOneRoot(workspaceRoot: string, root: string): Promise<ProjectInfo[]> {
  const pm = detectPackageManager(root);
  const patterns = await workspacePatterns(root);
  const raw: RawProject[] = [];

  const rootProject = await buildProject(workspaceRoot, root);
  if (rootProject) raw.push(rootProject);

  if (patterns.length > 0) {
    const globs = patterns.map((p) => `${p.replace(/\/$/, '')}/package.json`);
    const found = await fg(globs, { cwd: root, absolute: true, ignore: ['**/node_modules/**'], onlyFiles: true });
    const built = await Promise.all(found.map((f) => buildProject(workspaceRoot, dirname(f))));
    for (const p of built) if (p) raw.push(p);
  }

  // Attach non-npm scripts to the root project.
  const extra = await extraScripts(workspaceRoot, root);
  if (extra.length > 0) {
    let rootRef = raw.find((p) => p.path === root);
    if (!rootRef) {
      rootRef = { rel: relOf(workspaceRoot, root), name: basename(root), path: root, scripts: [] };
      raw.unshift(rootRef);
    }
    rootRef.scripts = [...rootRef.scripts, ...extra];
  }

  const projects: ProjectInfo[] = [];
  for (const p of raw) {
    if (p.scripts.length === 0 && p.path !== root) continue;
    projects.push({
      rel: p.rel,
      name: p.name,
      path: p.path,
      packageManager: pm,
      type: await detectType(p.path, p.scripts, pm),
      scripts: p.scripts,
      envFiles: await scanEnvFiles(p.path),
    });
  }
  return projects;
}

/** Scan a workspace root plus any registered project roots into projects. */
export async function scanWorkspace(
  workspaceRoot: string,
  projectRels: string[] = [],
): Promise<ProjectInfo[]> {
  const roots = [workspaceRoot, ...projectRels.map((r) => resolve(workspaceRoot, r))];
  const seenRoot = new Set<string>();
  const projects: ProjectInfo[] = [];
  const seenProject = new Set<string>();
  for (const root of roots) {
    if (seenRoot.has(root) || !existsSync(root)) continue;
    seenRoot.add(root);
    for (const p of await scanOneRoot(workspaceRoot, root)) {
      if (seenProject.has(p.path)) continue;
      seenProject.add(p.path);
      projects.push(p);
    }
  }
  projects.sort((a, b) => (a.rel === '.' ? -1 : b.rel === '.' ? 1 : a.rel.localeCompare(b.rel)));
  return projects;
}
