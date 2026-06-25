import { useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Toaster } from 'sonner';
import { useAppStore } from '@/store/useAppStore';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { DetailPane } from './components/DetailPane';
import { EmptyState } from './components/EmptyState';
import { CommandPalette } from './components/CommandPalette';

/**
 * Toggle the `.dark` class from the OS/Electron effective color scheme. The main
 * process drives `nativeTheme.themeSource` from the saved setting, so
 * `prefers-color-scheme` always reflects the chosen theme (system/light/dark).
 */
function useThemeClass(): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      document.documentElement.classList.toggle('dark', mq.matches);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
}

export default function App() {
  const ready = useAppStore((s) => s.ready);
  const active = useAppStore((s) => s.active);
  const init = useAppStore((s) => s.init);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);

  useThemeClass();

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPaletteOpen]);

  if (!ready) {
    return (
      <div className="grid h-full place-items-center text-[13px] text-muted-foreground">Loading…</div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <PanelGroup direction="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize={20} minSize={14} maxSize={32} className="min-w-0">
          <Sidebar />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel minSize={40} className="min-w-0">
          <main className="h-full min-w-0 bg-background">
            {active ? <DetailPane /> : <EmptyState />}
          </main>
        </Panel>
      </PanelGroup>
      <CommandPalette />
      <Toaster theme="system" position="bottom-right" richColors closeButton />
    </div>
  );
}
