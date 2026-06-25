import { useState } from 'react';
import { ChevronsUpDown, FolderGit2, FolderOpen, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NAV_SECTIONS } from './nav';
import { StatusDot } from './StatusDot';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';

function WorkspacePicker({ onNew }: { onNew: () => void }) {
  const active = useAppStore((s) => s.active);
  const workspaces = useAppStore((s) => s.workspaces);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const browseAndAdd = useAppStore((s) => s.browseAndAdd);

  return (
    <div className="no-drag p-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left outline-none transition-colors hover:border-border hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40">
            <div className="grid size-6 shrink-0 place-items-center rounded bg-omk/15 text-omk">
              <FolderGit2 className="size-3.5" />
            </div>
            <span className="flex-1 truncate text-[13px] font-medium">
              {active ? active.manifest.name : 'Select workspace'}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-60">
          {workspaces.length > 0 && <DropdownMenuLabel>Workspaces</DropdownMenuLabel>}
          {workspaces.map((w) => (
            <DropdownMenuItem key={w.path} onSelect={() => void openWorkspace(w.path)}>
              <StatusDot status={active?.path === w.path ? 'omk' : 'idle'} />
              <span className="flex-1 truncate">{w.name}</span>
              {w.missing && <span className="text-[11px] text-destructive">missing</span>}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void browseAndAdd()}>
            <FolderOpen />
            Open folder…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNew}>
            <Plus />
            New project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function NavList() {
  const nav = useAppStore((s) => s.nav);
  const setNav = useAppStore((s) => s.setNav);

  return (
    <nav className="space-y-0.5 px-2">
      {NAV_SECTIONS.map((item) => {
        const Icon = item.icon;
        const isActive = nav === item.id;
        return (
          <button
            key={item.id}
            onClick={() => setNav(item.id)}
            title={item.hint}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40',
              isActive
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className={cn('size-4 shrink-0', isActive && 'text-omk')} />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  const active = useAppStore((s) => s.active);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <aside className="flex h-full flex-col bg-sidebar/50">
      <WorkspacePicker onNew={() => setDialogOpen(true)} />
      <div className="h-px bg-border" />
      <div className="flex-1 overflow-y-auto py-2">
        {active ? (
          <NavList />
        ) : (
          <p className="px-4 py-8 text-center text-[12px] leading-relaxed text-muted-foreground">
            No workspace open. Pick one above to begin.
          </p>
        )}
      </div>
      <NewWorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </aside>
  );
}
