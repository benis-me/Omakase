import { useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { ChevronsUpDown, FolderGit2, FolderOpen, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { NAV_SECTIONS } from './nav';
import { StatusDot } from './StatusDot';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';

const menuItem =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground';

function WorkspacePicker({ onNew }: { onNew: () => void }) {
  const active = useAppStore((s) => s.active);
  const workspaces = useAppStore((s) => s.workspaces);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const browseAndAdd = useAppStore((s) => s.browseAndAdd);

  return (
    <div className="no-drag border-b px-2 py-2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent">
            <div className="grid size-6 shrink-0 place-items-center rounded bg-omk/15 text-omk">
              <FolderGit2 className="size-3.5" />
            </div>
            <span className="flex-1 truncate text-[13px] font-medium">
              {active ? active.manifest.name : 'Select workspace'}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            className="z-50 min-w-[230px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {workspaces.length > 0 && (
              <DropdownMenu.Label className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                Workspaces
              </DropdownMenu.Label>
            )}
            {workspaces.map((w) => (
              <DropdownMenu.Item
                key={w.path}
                onSelect={() => void openWorkspace(w.path)}
                className={menuItem}
              >
                <StatusDot status={active?.path === w.path ? 'omk' : 'idle'} />
                <span className="flex-1 truncate">{w.name}</span>
                {w.missing && <span className="text-[11px] text-destructive">missing</span>}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item onSelect={() => void browseAndAdd()} className={menuItem}>
              <FolderOpen className="size-3.5 text-muted-foreground" />
              Open folder…
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={onNew} className={menuItem}>
              <Plus className="size-3.5 text-muted-foreground" />
              New project…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function NavList() {
  const nav = useAppStore((s) => s.nav);
  const setNav = useAppStore((s) => s.setNav);

  return (
    <div className="space-y-0.5">
      {NAV_SECTIONS.map((item) => {
        const Icon = item.icon;
        const isActive = nav === item.id;
        return (
          <button
            key={item.id}
            onClick={() => setNav(item.id)}
            title={item.hint}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors',
              isActive
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function Sidebar() {
  const active = useAppStore((s) => s.active);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <aside className="flex h-full flex-col bg-sidebar/50">
      <WorkspacePicker onNew={() => setDialogOpen(true)} />
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {active ? (
          <NavList />
        ) : (
          <p className="px-2 py-8 text-center text-[12px] leading-relaxed text-muted-foreground">
            No workspace open.
            <br />
            Pick one above to begin.
          </p>
        )}
      </nav>
      <NewWorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </aside>
  );
}
