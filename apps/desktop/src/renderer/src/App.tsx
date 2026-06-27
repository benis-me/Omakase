import { useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAppStore } from '@/store/useAppStore';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { DetailPane } from './components/DetailPane';
import { EmptyState } from './components/EmptyState';
import { CommandPalette } from './components/CommandPalette';
import { SettingsDialog } from './components/SettingsDialog';

/**
 * Resolve and apply the active theme straight from the saved setting — not via
 * `nativeTheme` propagation, which is why the toggle previously looked inert.
 * 'system' follows the OS; 'light'/'dark' force it.
 */
function useResolvedTheme(): 'light' | 'dark' {
  const theme = useAppStore((s) => s.settings?.theme ?? 'system');
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  return dark ? 'dark' : 'light';
}

export default function App() {
  const ready = useAppStore((s) => s.ready);
  const active = useAppStore((s) => s.active);
  const init = useAppStore((s) => s.init);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const resolvedTheme = useResolvedTheme();

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
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        <TitleBar />
        <PanelGroup direction="horizontal" className="min-h-0 flex-1">
          <Panel defaultSize={20} minSize={15} maxSize={32} className="min-w-0">
            <Sidebar />
          </Panel>
          <PanelResizeHandle className="relative w-px shrink-0 bg-border outline-none transition-colors data-[resize-handle-state=hover]:bg-omk/60 data-[resize-handle-state=drag]:bg-omk after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-['']" />
          <Panel minSize={40} className="min-w-0">
            <main className="flex h-full min-w-0 flex-col bg-background">
              {active ? (
                <>
                  <TabBar />
                  {/* min-h-0 lets the active view own its own scrolling instead of
                      overflowing the pane (the cockpit feed, long lists, etc.). */}
                  <div className="min-h-0 flex-1">
                    <DetailPane />
                  </div>
                </>
              ) : (
                <EmptyState />
              )}
            </main>
          </Panel>
        </PanelGroup>
        <CommandPalette />
        <SettingsDialog />
        <Toaster theme={resolvedTheme} position="bottom-right" richColors closeButton />
      </div>
    </TooltipProvider>
  );
}
