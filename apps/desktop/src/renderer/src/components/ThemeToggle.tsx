import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '@shared/types';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';

const ORDER: ThemeMode[] = ['system', 'light', 'dark'];
const ICON: Record<ThemeMode, typeof Monitor> = { system: Monitor, light: Sun, dark: Moon };

export function ThemeToggle() {
  const theme = useAppStore((s) => s.settings?.theme ?? 'system');
  const setTheme = useAppStore((s) => s.setTheme);
  const Icon = ICON[theme];
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];

  return (
    <Tooltip content={`Theme: ${theme} → ${next}`}>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground"
        onClick={() => void setTheme(next)}
        aria-label="Toggle theme"
      >
        <Icon className="size-4" />
      </Button>
    </Tooltip>
  );
}
