import { useState } from 'react';
import { Asterisk, Command, FolderGit2, FolderOpen, Plus, Search, Settings, X } from 'lucide-react';
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
import { Tooltip } from '@/components/ui/tooltip';
import { ThemeToggle } from './ThemeToggle';
import { NewWorkspaceDialog } from './NewWorkspaceDialog';

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
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState('');
  const t = useT();

  const q = query.trim().toLowerCase();
  const filtered = q ? workspaces.filter((w) => w.name.toLowerCase().includes(q)) : workspaces;

  return (
    <aside className="flex h-full min-h-0 flex-col border-r bg-sidebar/50">
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
