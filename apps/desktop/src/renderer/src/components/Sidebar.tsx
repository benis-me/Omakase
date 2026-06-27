import { useState } from 'react';
import {
  Asterisk,
  Command,
  FolderOpen,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import type { WorkspaceInfo } from '@shared/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { ThemeToggle } from './ThemeToggle';
import { WorkspaceStackIcon } from './WorkspaceStackIcon';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';

/** Pinned workspaces float to the top (stable within each group). */
function sortWorkspaces(list: WorkspaceInfo[]): WorkspaceInfo[] {
  return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

const IS_MAC = navigator.userAgent.includes('Mac');

/**
 * The full-height left rail (DevDock-style): the window's primary left-right split.
 * Lists workspaces (pick / add / search); window utilities live in the footer.
 */
export function Sidebar() {
  const active = useAppStore((s) => s.active);
  const workspaces = useAppStore((s) => s.workspaces);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const browseAndAdd = useAppStore((s) => s.browseAndAdd);
  const setPinned = useAppStore((s) => s.setPinned);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const reorderWorkspaces = useAppStore((s) => s.reorderWorkspaces);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [dragPath, setDragPath] = useState<string | null>(null);
  const t = useT();

  const q = query.trim().toLowerCase();
  const ordered = sortWorkspaces(workspaces);
  const filtered = q ? ordered.filter((w) => w.name.toLowerCase().includes(q)) : ordered;

  // Native drag-to-reorder. Disabled while searching (reordering a filtered subset
  // is ambiguous). Drop moves the dragged workspace to the target's position.
  const onDrop = (targetPath: string): void => {
    if (!dragPath || dragPath === targetPath) return setDragPath(null);
    const paths = ordered.map((w) => w.path);
    const from = paths.indexOf(dragPath);
    const to = paths.indexOf(targetPath);
    if (from < 0 || to < 0) return setDragPath(null);
    paths.splice(to, 0, paths.splice(from, 1)[0]);
    void reorderWorkspaces(paths);
    setDragPath(null);
  };
  const reveal = (path: string): void => void window.omakase.shell.openPath(path);

  return (
    <aside className="flex h-full min-h-0 flex-col bg-sidebar/50">
      {/* Top strip — clears the macOS traffic lights and drags the window. */}
      <div
        className="drag flex h-11 shrink-0 items-center gap-2"
        style={{ paddingLeft: IS_MAC ? 80 : 12, paddingRight: 10 }}
      >
        <div className="grid size-5 shrink-0 place-items-center rounded-md bg-omk/15 text-omk">
          <Asterisk className="size-3.5" strokeWidth={2.75} />
        </div>
        <span className="text-[13px] font-semibold tracking-tight">Omakase</span>
      </div>

      <div className="flex items-center justify-between px-3 pb-1.5 pt-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('Workspaces')}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
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
      </div>

      {workspaces.length > 0 && (
        <div className="px-2 pb-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('Search workspaces')}
              className="h-7 w-full rounded-md border bg-transparent pl-7 pr-6 text-xs outline-none transition placeholder:text-muted-foreground/60 focus:border-ring"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label={t('Clear')}
                className="absolute right-1.5 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 transition hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {workspaces.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12px] leading-relaxed text-muted-foreground">
            {t('No workspaces yet — add one with the + above.')}
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            {t('No matching workspaces.')}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((w) => {
              const isActive = active?.path === w.path;
              return (
                <div
                  key={w.path}
                  draggable={!q}
                  onDragStart={() => setDragPath(w.path)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(w.path)}
                  onClick={() => void openWorkspace(w.path)}
                  className={cn(
                    'group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors',
                    isActive
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    dragPath === w.path && 'opacity-50',
                  )}
                >
                  <div
                    className={cn(
                      'grid size-6 shrink-0 place-items-center rounded',
                      isActive ? 'bg-omk/15 text-omk' : 'bg-muted text-muted-foreground',
                    )}
                    title={w.stack}
                  >
                    <WorkspaceStackIcon stack={w.stack} className="size-3.5" />
                  </div>
                  <span className="flex-1 truncate">{w.name}</span>
                  {w.pinned && <Pin className="size-3 shrink-0 text-muted-foreground/60" />}
                  {w.missing && <span className="text-[11px] text-destructive">{t('missing')}</span>}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        aria-label={t('Workspace actions')}
                        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 outline-none transition hover:bg-accent hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
                      >
                        <MoreHorizontal className="size-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem onSelect={() => void setPinned(w.path, !w.pinned)}>
                        {w.pinned ? <PinOff /> : <Pin />}
                        {w.pinned ? t('Unpin') : t('Pin')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => reveal(w.path)}>
                        <FolderOpen />
                        {t('Reveal in Finder')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => void removeWorkspace(w.path)}
                      >
                        <Trash2 />
                        {t('Remove from list')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Window utilities, moved here from the old top-right title bar. */}
      <div className="flex items-center gap-0.5 border-t p-2">
        <Tooltip content="⌘K">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setPaletteOpen(true)}
            aria-label={t('Command palette')}
          >
            <Command className="size-4" />
          </Button>
        </Tooltip>
        <ThemeToggle />
        <Tooltip content={t('Settings')}>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setSettingsOpen(true)}
            aria-label={t('Settings')}
          >
            <Settings className="size-4" />
          </Button>
        </Tooltip>
      </div>

      <NewWorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </aside>
  );
}
