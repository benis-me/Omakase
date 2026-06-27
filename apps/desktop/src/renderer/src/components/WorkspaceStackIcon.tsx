import type { ComponentType } from 'react';
import { FolderGit2 } from 'lucide-react';
import {
  SiNextdotjs,
  SiNuxt,
  SiAstro,
  SiRemix,
  SiExpo,
  SiElectron,
  SiReact,
  SiVuedotjs,
  SiSvelte,
  SiAngular,
  SiVite,
  SiNodedotjs,
  SiDeno,
  SiRust,
  SiGo,
  SiFlutter,
  SiSwift,
  SiDotnet,
  SiGradle,
  SiPython,
  SiDocker,
} from '@icons-pack/react-simple-icons';

type Brand = ComponentType<{ className?: string; color?: string; size?: number }>;

// Stack labels here mirror detect-stack.ts (main).
const STACK_ICON: Record<string, Brand> = {
  'Next.js': SiNextdotjs,
  Nuxt: SiNuxt,
  Astro: SiAstro,
  Remix: SiRemix,
  Expo: SiExpo,
  Electron: SiElectron,
  React: SiReact,
  'Vue.js': SiVuedotjs,
  Svelte: SiSvelte,
  Angular: SiAngular,
  Vite: SiVite,
  Node: SiNodedotjs,
  Deno: SiDeno,
  Rust: SiRust,
  Go: SiGo,
  Flutter: SiFlutter,
  Swift: SiSwift,
  '.NET': SiDotnet,
  JVM: SiGradle,
  Python: SiPython,
  Docker: SiDocker,
};

/** The workspace's detected-stack brand icon (monochrome, inherits text color), or a
 *  folder fallback when the stack is unknown. */
export function WorkspaceStackIcon({ stack, className }: { stack?: string; className?: string }) {
  const Brand = stack ? STACK_ICON[stack] : undefined;
  if (Brand) return <Brand className={className} color="currentColor" />;
  return <FolderGit2 className={className} />;
}
