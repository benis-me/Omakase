import { Asterisk, Command, Settings } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { ThemeToggle } from './ThemeToggle';

const IS_MAC = navigator.userAgent.includes('Mac');

export function TitleBar() {
  const active = useAppStore((s) => s.active);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  return (
    <header
      className="drag relative z-20 flex h-11 shrink-0 items-center gap-2 border-b bg-card/40"
      style={{ paddingLeft: IS_MAC ? 82 : 12, paddingRight: 8 }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="grid size-5 shrink-0 place-items-center rounded-md bg-omk/15 text-omk">
          <Asterisk className="size-3.5" strokeWidth={2.75} />
        </div>
        <span className="text-[13px] font-semibold tracking-tight">Omakase</span>
        {active && (
          <>
            <span className="text-border">/</span>
            <span className="truncate text-[13px] text-muted-foreground">{active.manifest.name}</span>
          </>
        )}
      </div>

      <div className="no-drag ml-auto flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => setPaletteOpen(true)}
        >
          <Command className="size-3.5" />
          <kbd className="font-mono text-[11px] tracking-tight">⌘K</kbd>
        </Button>
        <ThemeToggle />
        <Tooltip content="Settings">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
          >
            <Settings className="size-4" />
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}
