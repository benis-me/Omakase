/**
 * Best-effort detection of a workspace's primary tech stack, for the sidebar icon.
 * Reads a few well-known marker files; the result is a short label that the renderer
 * maps to a brand icon. Cached per path for the session (a restart re-detects).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const cache = new Map<string, string | undefined>();

const has = (root: string, file: string): boolean => existsSync(join(root, file));
const hasExt = (root: string, ext: string): boolean => {
  try {
    return readdirSync(root).some((f) => f.endsWith(ext));
  } catch {
    return false;
  }
};

function fromPackageJson(root: string): string {
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    /* unreadable package.json — fall through to a generic Node label */
  }
  const d = (name: string): boolean => name in deps;
  // Framework before bundler before view library (most specific wins).
  if (d('next')) return 'Next.js';
  if (d('nuxt')) return 'Nuxt';
  if (d('astro')) return 'Astro';
  if (Object.keys(deps).some((k) => k.startsWith('@remix-run/'))) return 'Remix';
  if (d('expo')) return 'Expo';
  if (d('electron')) return 'Electron';
  if (d('vite')) return 'Vite';
  if (d('@angular/core')) return 'Angular';
  if (d('vue')) return 'Vue.js';
  if (d('svelte')) return 'Svelte';
  if (d('react')) return 'React';
  return 'Node';
}

function compute(root: string): string | undefined {
  if (has(root, 'package.json')) return fromPackageJson(root);
  if (has(root, 'deno.json') || has(root, 'deno.jsonc')) return 'Deno';
  if (has(root, 'Cargo.toml')) return 'Rust';
  if (has(root, 'go.mod')) return 'Go';
  if (has(root, 'pubspec.yaml')) return 'Flutter';
  if (has(root, 'Package.swift') || hasExt(root, '.xcodeproj')) return 'Swift';
  if (hasExt(root, '.csproj') || hasExt(root, '.sln')) return '.NET';
  if (has(root, 'build.gradle') || has(root, 'build.gradle.kts') || has(root, 'pom.xml')) return 'JVM';
  if (has(root, 'pyproject.toml') || has(root, 'requirements.txt') || has(root, 'setup.py')) return 'Python';
  if (has(root, 'Dockerfile')) return 'Docker';
  return undefined;
}

export function detectStack(root: string): string | undefined {
  const cached = cache.get(root);
  if (cached !== undefined || cache.has(root)) return cached;
  const stack = compute(root);
  cache.set(root, stack);
  return stack;
}
