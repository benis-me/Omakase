import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '@shared/types';
import { useAppStore } from '@/store/useAppStore';
import { Button } from './ui/button';

const ORDER: ThemeMode[] = ['system', 'light', 'dark'];
const ICON: Record<ThemeMode, typeof Monitor> = { system: Monitor, light: Sun, dark: Moon };

export function ThemeToggle() {
  const theme = useAppStore((s) => s.settings?.theme ?? 'system');
  const setTheme = useAppStore((s) => s.setTheme);
  const Icon = ICON[theme];
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];

  return (
    <Button
      variant="ghost"
      size="icon"
      className="no-drag text-muted-foreground hover:text-foreground"
      title={`Theme: ${theme} — click for ${next}`}
      onClick={() => void setTheme(next)}
    >
      <Icon className="size-4" />
    </Button>
  );
}
