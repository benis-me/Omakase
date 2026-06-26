import {
  Bot,
  Brain,
  FileText,
  ListTree,
  TerminalSquare,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { NavSection } from '@/store/useAppStore';

export interface NavItem {
  id: NavSection;
  label: string;
  icon: LucideIcon;
  hint: string;
}

export const NAV_SECTIONS: readonly NavItem[] = [
  { id: 'runs', label: 'Runs', icon: ListTree, hint: 'Active and past agent runs' },
  { id: 'specs', label: 'Specs', icon: FileText, hint: 'Specifications you hand to the loop' },
  { id: 'agents', label: 'Agents', icon: Bot, hint: 'Live sub-agents spawned by runs' },
  { id: 'automations', label: 'Automations', icon: Zap, hint: 'Triggers that start runs on a schedule or on file changes' },
  { id: 'memory', label: 'Memory', icon: Brain, hint: 'AGENTS.md, wiki, and accumulated knowledge' },
  { id: 'workflows', label: 'Workflows', icon: Workflow, hint: 'Dynamic orchestration scripts' },
  { id: 'dev', label: 'Dev', icon: TerminalSquare, hint: 'Scripts, ports, terminals, open with' },
];
