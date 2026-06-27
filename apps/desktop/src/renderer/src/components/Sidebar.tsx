import { useState } from 'react';
import { FolderGit2, FolderOpen, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';

/**
 * The left rail: a persistent list of workspaces (DevDock-style). Picking one makes
 * it active; the project's sections live in the horizontal {@link TabBar} on the right.
 */
export function Sidebar() {
  const active = useAppStore((s) => s.active);
  const workspaces = useAppStore((s) => s.workspaces);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const browseAndAdd = useAppStore((s) => s.browseAndAdd);
  const [dialogOpen, setDialogOpen] = useState(false);
  const t = useT();

  return (
    <aside className="flex h-full min-h-0 flex-col bg-sidebar/50">
      <header className="no-drag flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-[13px] font-medium">{t('Workspaces')}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground">
              <Plus className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void browseAndAdd()}>
              <FolderOpen />
              {t('Open folder…')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialogOpen(true)}>
              <Plus />
              {t('New project…')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {workspaces.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12px] leading-relaxed text-muted-foreground">
            {t('No workspaces yet — add one with the + above.')}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {workspaces.map((w) => {
              const isActive = active?.path === w.path;
              return (
                <button
                  key={w.path}
                  onClick={() => void openWorkspace(w.path)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40',
                    isActive
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  <div
                    className={cn(
                      'grid size-6 shrink-0 place-items-center rounded',
                      isActive ? 'bg-omk/15 text-omk' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    <FolderGit2 className="size-3.5" />
                  </div>
                  <span className="flex-1 truncate">{w.name}</span>
                  {w.missing && <span className="text-[11px] text-destructive">{t('missing')}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <NewWorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </aside>
  );
}
