/**
 * A dependency-free code graph. It scans a project's source files and extracts
 * module-level structure: imports (resolved to internal files or flagged as
 * external), exports, and top-level symbols. From that it answers dependency
 * and dependents queries, finds import cycles, and produces stats — enough for
 * the orchestrator to reason about blast radius without a full type-checker.
 *
 * Extraction is regex-based (line/offset accurate), which is intentionally
 * lightweight: it sees syntax, not semantics. Incremental `update` re-scans
 * only changed files.
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export type CodeLanguage = 'typescript' | 'javascript' | 'json' | 'markdown' | 'other';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'const'
  | 'let'
  | 'var'
  | 'interface'
  | 'type'
  | 'enum';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  line: number;
}

export interface ImportEdge {
  specifier: string;
  /** Resolved internal file (posix relative path), or null if external/unresolved. */
  to: string | null;
  external: boolean;
  specifiers: string[];
  line: number;
}

export interface CodeSymbolReference {
  from: string;
  to: string;
  imported: string;
  local: string;
  count: number;
  lines: number[];
}

export interface CodeNode {
  path: string;
  language: CodeLanguage;
  loc: number;
  imports: ImportEdge[];
  exports: string[];
  symbols: CodeSymbol[];
  references?: CodeSymbolReference[];
}

export interface CodeGraphSnapshot {
  root: string;
  nodes: CodeNode[];
}

export interface CodeGraphStats {
  files: number;
  internalEdges: number;
  externalEdges: number;
  symbols: number;
  cycles: number;
  byLanguage: Record<string, number>;
}

export interface CodeGraphHotspot {
  path: string;
  dependents: number;
  dependencies: number;
  symbols: number;
  loc: number;
}

export interface CodeGraphExternalDependency {
  specifier: string;
  count: number;
}

export interface CodeGraphPublicApi {
  path: string;
  exports: string[];
  symbols: CodeSymbol[];
  dependents: number;
}

export interface CodeGraphSummary {
  stats: CodeGraphStats;
  dependencyHubs: CodeGraphHotspot[];
  entrypoints: CodeGraphHotspot[];
  publicApis: CodeGraphPublicApi[];
  symbolReferences: CodeSymbolReference[];
  externalDependencies: CodeGraphExternalDependency[];
  cycles: string[][];
}

export interface ScanOptions {
  root: string;
  include?: RegExp;
  ignoreDirs?: ReadonlySet<string>;
  maxFiles?: number;
  maxFileBytes?: number;
  /**
   * tsconfig-style path aliases (root-relative targets) so non-relative imports
   * like `@scope/pkg` resolve to internal files instead of being flagged
   * external. Keys may end with `/*`; targets may contain `*`. Use
   * {@link loadTsconfigAliases} to derive these from a tsconfig.json.
   */
  aliases?: Record<string, string[]>;
}

const DEFAULT_INCLUDE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.omakase',
]);

function detectLanguage(file: string): CodeLanguage {
  const ext = path.extname(file).toLowerCase();
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) return 'typescript';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (ext === '.json') return 'json';
  if (ext === '.md') return 'markdown';
  return 'other';
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseImportSpecifiers(clause: string): string[] {
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1]!.split(',')) {
      let p = part.trim();
      if (!p || p === 'type') continue; // `import { type } from ...` (degenerate)
      if (p.startsWith('type ')) p = p.slice(5).trim(); // strip inline `type` modifier
      const name = p.split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  const star = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
  if (star) names.push(star[1]!);
  const def = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.replace(/\{[^}]*\}/, ''));
  if (def && def[1] && def[1] !== 'type') names.push(def[1]);
  return [...new Set(names)];
}

function parseImports(content: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();
  const push = (specifier: string, index: number, specifiers: string[] = []): void => {
    const key = `${specifier}@${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      specifier,
      to: null,
      external: !specifier.startsWith('.'),
      specifiers,
      line: lineAt(content, index),
    });
  };

  const fromRe = /\b(?:import|export)\s+([^;]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  for (let m = fromRe.exec(content); m; m = fromRe.exec(content)) {
    push(m[2]!, m.index, parseImportSpecifiers(m[1]!));
  }
  const bareRe = /\bimport\s*['"]([^'"]+)['"]/g;
  for (let m = bareRe.exec(content); m; m = bareRe.exec(content)) push(m[1]!, m.index);
  const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m = requireRe.exec(content); m; m = requireRe.exec(content)) push(m[1]!, m.index);
  const dynamicRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m = dynamicRe.exec(content); m; m = dynamicRe.exec(content)) push(m[1]!, m.index);

  return edges;
}

function parseExports(content: string): string[] {
  const names = new Set<string>();
  const declRe =
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (let m = declRe.exec(content); m; m = declRe.exec(content)) names.add(m[1]!);
  if (/\bexport\s+default\b/.test(content)) names.add('default');
  const namedRe = /\bexport\s*\{([^}]*)\}/g;
  for (let m = namedRe.exec(content); m; m = namedRe.exec(content)) {
    for (const part of m[1]!.split(',')) {
      let p = part.trim();
      if (!p || p === 'type') continue;
      if (p.startsWith('type ')) p = p.slice(5).trim(); // strip inline `type` modifier
      const name = p.split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

function parseSymbols(content: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const re =
    /(?:^|\n)([ \t]*)(export\s+)?(?:default\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    // Only top-level declarations (no leading indentation).
    if ((m[1] ?? '').length > 0) continue;
    symbols.push({
      name: m[4]!,
      kind: m[3] as SymbolKind,
      exported: Boolean(m[2]),
      line: lineAt(content, m.index + (m[0].startsWith('\n') ? 1 : 0)),
    });
  }
  return symbols;
}

function toPosixRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export class CodeGraph {
  readonly root: string;
  private readonly nodes = new Map<string, CodeNode>();
  private readonly contents = new Map<string, string>();
  private readonly options: Required<Omit<ScanOptions, 'root'>>;

  constructor(root: string, options: Omit<ScanOptions, 'root'> = {}) {
    this.root = root;
    this.options = {
      include: options.include ?? DEFAULT_INCLUDE,
      ignoreDirs: options.ignoreDirs ?? DEFAULT_IGNORE,
      maxFiles: options.maxFiles ?? 5000,
      maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
      aliases: options.aliases ?? {},
    };
  }

  static async scan(options: ScanOptions): Promise<CodeGraph> {
    const graph = new CodeGraph(options.root, options);
    await graph.rescanAll();
    return graph;
  }

  private async rescanAll(): Promise<void> {
    this.nodes.clear();
    this.contents.clear();
    const files = await this.collectFiles();
    for (const file of files) {
      const node = await this.parseFile(file);
      if (node) this.nodes.set(node.path, node);
    }
    this.resolveEdges();
  }

  private async collectFiles(): Promise<string[]> {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (files.length >= this.options.maxFiles) return;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= this.options.maxFiles) break;
        if (entry.isDirectory()) {
          if (this.options.ignoreDirs.has(entry.name)) continue;
          if (entry.name.startsWith('.') && entry.name !== '.') continue;
          await walk(path.join(dir, entry.name));
        } else if (entry.isFile() && this.options.include.test(entry.name)) {
          files.push(path.join(dir, entry.name));
        }
      }
    };
    await walk(this.root);
    return files;
  }

  private async parseFile(absPath: string): Promise<CodeNode | null> {
    try {
      const stats = await stat(absPath);
      if (!stats.isFile() || stats.size > this.options.maxFileBytes) return null;
      const content = await readFile(absPath, 'utf8');
      const rel = toPosixRelative(this.root, absPath);
      this.contents.set(rel, content);
      return {
        path: rel,
        language: detectLanguage(absPath),
        loc: content.split('\n').length,
        imports: parseImports(content),
        exports: parseExports(content),
        symbols: parseSymbols(content),
      };
    } catch {
      return null;
    }
  }

  private resolveEdges(): void {
    const known = new Set(this.nodes.keys());
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
    const resolveTarget = (joinedRaw: string): string | null => {
      const joined = path.posix.normalize(joinedRaw);
      const candidates = [joined];
      for (const ext of exts) candidates.push(joined + ext);
      for (const ext of exts) candidates.push(path.posix.join(joined, `index${ext}`));
      if (joined.endsWith('.js')) {
        candidates.push(joined.replace(/\.js$/, '.ts'), joined.replace(/\.js$/, '.tsx'));
      }
      return candidates.find((c) => known.has(c)) ?? null;
    };
    const tryRelative = (fromPath: string, specifier: string): string | null => {
      if (!specifier.startsWith('.')) return null;
      return resolveTarget(path.posix.join(path.posix.dirname(fromPath), specifier));
    };
    const tryAlias = (specifier: string): string | null => {
      for (const [pattern, targets] of Object.entries(this.options.aliases)) {
        if (pattern.endsWith('/*')) {
          const prefix = pattern.slice(0, -1); // keep trailing slash
          if (!specifier.startsWith(prefix)) continue;
          const rest = specifier.slice(prefix.length);
          for (const target of targets) {
            const joined = target.includes('*') ? target.replace('*', rest) : target;
            const resolved = resolveTarget(joined);
            if (resolved) return resolved;
          }
        } else if (specifier === pattern) {
          for (const target of targets) {
            const resolved = resolveTarget(target);
            if (resolved) return resolved;
          }
        }
      }
      return null;
    };
    for (const node of this.nodes.values()) {
      for (const edge of node.imports) {
        const resolved = edge.specifier.startsWith('.')
          ? tryRelative(node.path, edge.specifier)
          : tryAlias(edge.specifier);
        edge.to = resolved;
        // A non-relative import that resolved via an alias is internal.
        edge.external = resolved ? false : !edge.specifier.startsWith('.');
      }
    }
    this.resolveSymbolReferences();
  }

  private resolveSymbolReferences(): void {
    for (const node of this.nodes.values()) {
      const content = this.contents.get(node.path);
      if (!content) {
        node.references = Array.isArray(node.references) ? node.references : [];
        continue;
      }
      const refs: CodeSymbolReference[] = [];
      const lines = content.split(/\r?\n/);
      for (const edge of node.imports) {
        if (!edge.to || edge.specifiers.length === 0) continue;
        for (const local of edge.specifiers) {
          const re = new RegExp(`\\b${escapeRegExp(local)}\\b`, 'g');
          let count = 0;
          const hitLines: number[] = [];
          lines.forEach((line, idx) => {
            const trimmed = line.trim();
            if (/^import\b/.test(trimmed) || /^export\s+\{.*\}\s+from\b/.test(trimmed)) return;
            const matches = line.match(re);
            if (!matches) return;
            count += matches.length;
            hitLines.push(idx + 1);
          });
          if (count > 0) {
            refs.push({
              from: node.path,
              to: edge.to,
              imported: local,
              local,
              count,
              lines: [...new Set(hitLines)],
            });
          }
        }
      }
      node.references = refs.sort((a, b) => b.count - a.count || a.to.localeCompare(b.to) || a.local.localeCompare(b.local));
    }
  }

  /** Incrementally re-scan changed files (relative or absolute paths). Removes vanished files. */
  async update(changedPaths: string[]): Promise<void> {
    for (const p of changedPaths) {
      const abs = path.isAbsolute(p) ? p : path.join(this.root, p);
      const rel = toPosixRelative(this.root, abs);
      if (!this.options.include.test(abs)) continue;
      const node = await this.parseFile(abs);
      if (node) this.nodes.set(rel, node);
      else {
        this.nodes.delete(rel);
        this.contents.delete(rel);
      }
    }
    this.resolveEdges();
  }

  removeFile(relPath: string): boolean {
    const deleted = this.nodes.delete(relPath);
    this.contents.delete(relPath);
    if (deleted) this.resolveEdges();
    return deleted;
  }

  node(relPath: string): CodeNode | undefined {
    return this.nodes.get(relPath);
  }

  nodesList(): CodeNode[] {
    return [...this.nodes.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  get size(): number {
    return this.nodes.size;
  }

  /** Internal files this file imports. */
  dependencies(relPath: string): string[] {
    const node = this.nodes.get(relPath);
    if (!node) return [];
    return [...new Set(node.imports.map((e) => e.to).filter((t): t is string => Boolean(t)))];
  }

  /** Internal files that import this file. */
  dependents(relPath: string): string[] {
    const out: string[] = [];
    for (const node of this.nodes.values()) {
      if (node.imports.some((e) => e.to === relPath)) out.push(node.path);
    }
    return out.sort();
  }

  externalDependencies(): string[] {
    const set = new Set<string>();
    for (const node of this.nodes.values()) {
      for (const edge of node.imports) {
        if (edge.external) set.add(edge.specifier);
      }
    }
    return [...set].sort();
  }

  /**
   * All distinct import cycles (each as a path of file ids). Uses an iterative
   * DFS with an explicit work stack so a very deep dependency chain cannot
   * overflow the JS call stack.
   */
  cycles(): string[][] {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const found: string[][] = [];
    const seenKeys = new Set<string>();
    const color = new Map<string, number>();
    // Precompute dependencies once (instead of recomputing per visit).
    const depsOf = new Map<string, string[]>();
    for (const id of this.nodes.keys()) {
      color.set(id, WHITE);
      depsOf.set(id, this.dependencies(id));
    }

    for (const start of this.nodes.keys()) {
      if (color.get(start) !== WHITE) continue;
      const frames: Array<{ id: string; deps: string[]; index: number }> = [
        { id: start, deps: depsOf.get(start) ?? [], index: 0 },
      ];
      const pathStack: string[] = [start];
      color.set(start, GRAY);

      while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        if (frame.index < frame.deps.length) {
          const dep = frame.deps[frame.index]!;
          frame.index += 1;
          const c = color.get(dep);
          if (c === GRAY) {
            const at = pathStack.indexOf(dep);
            const cycle = pathStack.slice(at).concat(dep);
            const key = [...cycle].sort().join('|');
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              found.push(cycle);
            }
          } else if (c === WHITE) {
            color.set(dep, GRAY);
            frames.push({ id: dep, deps: depsOf.get(dep) ?? [], index: 0 });
            pathStack.push(dep);
          }
        } else {
          color.set(frame.id, BLACK);
          frames.pop();
          pathStack.pop();
        }
      }
    }
    return found;
  }

  stats(): CodeGraphStats {
    let internalEdges = 0;
    let externalEdges = 0;
    let symbols = 0;
    const byLanguage: Record<string, number> = {};
    for (const node of this.nodes.values()) {
      symbols += node.symbols.length;
      byLanguage[node.language] = (byLanguage[node.language] ?? 0) + 1;
      for (const edge of node.imports) {
        if (edge.external) externalEdges += 1;
        else if (edge.to) internalEdges += 1;
      }
    }
    return {
      files: this.nodes.size,
      internalEdges,
      externalEdges,
      symbols,
      cycles: this.cycles().length,
      byLanguage,
    };
  }

  summary(limit = 8): CodeGraphSummary {
    const hotspots = this.nodesList().map((node) => ({
      path: node.path,
      dependents: this.dependents(node.path).length,
      dependencies: this.dependencies(node.path).length,
      symbols: node.symbols.length,
      loc: node.loc,
    }));
    const byHubRank = (a: CodeGraphHotspot, b: CodeGraphHotspot): number =>
      b.dependents - a.dependents ||
      b.dependencies - a.dependencies ||
      b.symbols - a.symbols ||
      a.path.localeCompare(b.path);
    const byEntryRank = (a: CodeGraphHotspot, b: CodeGraphHotspot): number =>
      b.dependencies - a.dependencies ||
      b.symbols - a.symbols ||
      a.path.localeCompare(b.path);
    const externalCounts = new Map<string, number>();
    for (const node of this.nodes.values()) {
      for (const edge of node.imports) {
        if (edge.external) externalCounts.set(edge.specifier, (externalCounts.get(edge.specifier) ?? 0) + 1);
      }
    }

    return {
      stats: this.stats(),
      dependencyHubs: hotspots
        .filter((item) => item.dependents > 0)
        .sort(byHubRank)
        .slice(0, limit),
      entrypoints: hotspots
        .filter((item) => item.dependents === 0)
        .sort(byEntryRank)
        .slice(0, limit),
      publicApis: this.nodesList()
        .filter((node) => node.exports.length > 0)
        .map((node) => ({
          path: node.path,
          exports: [...node.exports].sort(),
          symbols: node.symbols
            .filter((symbol) => symbol.exported || node.exports.includes(symbol.name))
            .sort((a, b) => a.name.localeCompare(b.name)),
          dependents: this.dependents(node.path).length,
        }))
        .sort(
          (a, b) =>
            b.dependents - a.dependents ||
            b.exports.length - a.exports.length ||
            a.path.localeCompare(b.path),
        )
        .slice(0, limit),
      symbolReferences: this.nodesList()
        .flatMap((node) => (Array.isArray(node.references) ? node.references : []))
        .sort(
          (a, b) =>
            b.count - a.count ||
            a.to.localeCompare(b.to) ||
            a.from.localeCompare(b.from) ||
            a.local.localeCompare(b.local),
        )
        .slice(0, limit),
      externalDependencies: [...externalCounts.entries()]
        .map(([specifier, count]) => ({ specifier, count }))
        .sort((a, b) => b.count - a.count || a.specifier.localeCompare(b.specifier))
        .slice(0, limit),
      cycles: this.cycles().slice(0, limit),
    };
  }

  toJSON(): CodeGraphSnapshot {
    return { root: this.root, nodes: this.nodesList() };
  }

  static fromJSON(snapshot: CodeGraphSnapshot, options: Omit<ScanOptions, 'root'> = {}): CodeGraph {
    const graph = new CodeGraph(snapshot.root, options);
    for (const node of snapshot.nodes) graph['nodes'].set(node.path, node);
    return graph;
  }
}

/**
 * Derive {@link ScanOptions.aliases} from a tsconfig.json: reads
 * `compilerOptions.baseUrl` + `compilerOptions.paths` and rewrites each target
 * relative to `root` (the CodeGraph root) so non-relative imports like
 * `@scope/pkg` resolve to internal files. Expects JSON-valid tsconfig (no
 * comments); returns an empty map on any error.
 *
 * For deeper analysis (type-level edges, call graphs) the CodeGraph is
 * intentionally pluggable — a downstream can back it with an OSS tool such as
 * dependency-cruiser, madge, or ts-morph and feed results into
 * `CodeGraph.fromJSON`.
 */
export async function loadTsconfigAliases(
  tsconfigPath: string,
  root: string,
): Promise<Record<string, string[]>> {
  try {
    const json = JSON.parse(await readFile(tsconfigPath, 'utf8')) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const compilerOptions = json.compilerOptions ?? {};
    const paths = compilerOptions.paths ?? {};
    const baseDir = path.resolve(
      path.dirname(tsconfigPath),
      compilerOptions.baseUrl ?? '.',
    );
    const out: Record<string, string[]> = {};
    for (const [pattern, targets] of Object.entries(paths)) {
      const toRel = (q: string): string =>
        path.relative(root, path.resolve(baseDir, q)).split(path.sep).join('/');
      out[pattern] = targets.map((target) => {
        const starIdx = target.indexOf('*');
        // Resolve only the literal prefix and re-attach the wildcard; never run
        // the '*' through path resolution.
        if (starIdx === -1) return toRel(target);
        const prefix = target.slice(0, starIdx);
        const suffix = target.slice(starIdx + 1);
        const strippedEmpty = prefix.replace(/[/\\]+$/, '') === '';
        // The wildcard sits at a directory boundary when the prefix ends with a
        // separator OR is empty (resolves to baseUrl) — so re-attach a '/'.
        const atDirBoundary = /[/\\]$/.test(prefix) || strippedEmpty;
        const relPrefix = strippedEmpty ? toRel('.') : toRel(prefix);
        const sep = atDirBoundary && relPrefix && !relPrefix.endsWith('/') ? '/' : '';
        return `${relPrefix}${sep}*${suffix}`;
      });
    }
    return out;
  } catch {
    return {};
  }
}
