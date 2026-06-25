import { FolderOpen } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { NAV_SECTIONS } from './nav';
import { DevWorkbench } from './dev/DevWorkbench';
import { SpecsView } from './content/SpecsView';
import { AgentsView } from './content/AgentsView';
import { MemoryView } from './content/MemoryView';
import { WorkflowsView } from './content/WorkflowsView';

export function DetailPane() {
  const nav = useAppStore((s) => s.nav);
  const active = useAppStore((s) => s.active);
  const item = NAV_SECTIONS.find((n) => n.id === nav) ?? NAV_SECTIONS[0];
  const Icon = item.icon;

  if (nav === 'dev') return <DevWorkbench />;
  if (nav === 'specs') return <SpecsView />;
  if (nav === 'agents') return <AgentsView />;
  if (nav === 'memory') return <MemoryView />;
  if (nav === 'workflows') return <WorkflowsView />;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <Icon className="size-4 text-muted-foreground" />
        <h2 className="text-[13px] font-medium">{item.label}</h2>
        {active && (
          <button
            onClick={() => void window.omakase.shell.openPath(active.path)}
            title="Reveal workspace folder"
            className="ml-auto flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <FolderOpen className="size-3" />
            <span className="max-w-[280px] truncate">{active.path}</span>
          </button>
        )}
      </header>

      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-3 grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground">
            <Icon className="size-6" />
          </div>
          <p className="text-[13px] font-medium">{item.label}</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{item.hint}</p>
          <p className="mt-3 text-[11px] text-muted-foreground/60">Lands in a later build phase.</p>
        </div>
      </div>
    </div>
  );
}
