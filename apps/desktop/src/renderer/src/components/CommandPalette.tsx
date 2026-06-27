import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Dialog } from 'radix-ui';
import { CornerDownLeft, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { NAV_SECTIONS } from './nav';

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const workspaces = useAppStore((s) => s.workspaces);
  const active = useAppStore((s) => s.active);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const browseAndAdd = useAppStore((s) => s.browseAndAdd);
  const setNav = useAppStore((s) => s.setNav);
  const setTheme = useAppStore((s) => s.setTheme);
  const t = useT();

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const close = (): void => setPaletteOpen(false);
    const wrap =
      (fn: () => void | Promise<void>): (() => void) =>
      () => {
        close();
        void fn();
      };
    const list: Command[] = [];
    for (const w of workspaces) {
      if (w.path !== active?.path) {
        list.push({ id: `ws:${w.path}`, label: `${t('Switch to')} ${w.name}`, hint: w.path, run: wrap(() => openWorkspace(w.path)) });
      }
    }
    list.push({ id: 'open', label: t('Open folder…'), run: wrap(browseAndAdd) });
    list.push({ id: 'settings', label: t('Open settings'), run: wrap(() => setSettingsOpen(true)) });
    if (active) {
      for (const n of NAV_SECTIONS) {
        list.push({ id: `nav:${n.id}`, label: `${t('Go to')} ${t(n.label)}`, hint: t(n.hint), run: wrap(() => setNav(n.id)) });
      }
    }
    for (const th of ['system', 'light', 'dark'] as const) {
      list.push({ id: `theme:${th}`, label: `${t('Theme:')} ${th}`, run: wrap(() => setTheme(th)) });
    }
    return list;
  }, [workspaces, active, openWorkspace, browseAndAdd, setNav, setTheme, setSettingsOpen, setPaletteOpen, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.hint?.toLowerCase().includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    setIndex(0);
  }, [query, paletteOpen]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      filtered[index]?.run();
    }
  };

  return (
    <Dialog.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[16%] z-50 w-[540px] -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t('Type a command or search…')}
              className="w-full bg-transparent py-3.5 text-[14px] outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-[340px] overflow-y-auto p-1.5">
            {filtered.length === 0 ? (
              <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">{t('No matches')}</p>
            ) : (
              filtered.map((c, i) => (
                <button
                  key={c.id}
                  onMouseMove={() => setIndex(i)}
                  onClick={c.run}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13px] outline-none transition-colors',
                    i === index ? 'bg-accent text-accent-foreground' : 'text-foreground',
                  )}
                >
                  <span className="flex-1 truncate">{c.label}</span>
                  {c.hint && (
                    <span className="max-w-[220px] truncate font-mono text-[11px] text-muted-foreground">
                      {c.hint}
                    </span>
                  )}
                  {i === index && <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />}
                </button>
              ))
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
