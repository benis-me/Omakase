import { ChevronDown, ExternalLink } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

export function OpenWithMenu() {
  const apps = useAppStore((s) => s.apps);
  const t = useT();
  if (apps.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground hover:text-foreground">
          <ExternalLink className="size-3.5" />
          {t('Open with')}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[60vh] min-w-[190px]">
        <DropdownMenuLabel className="uppercase tracking-wide">{t('Open workspace in')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {apps.map((app) => (
          <DropdownMenuItem key={app.id} onSelect={() => void window.omakase.apps.openWith(app.id)}>
            {app.icon ? (
              <img src={app.icon} alt="" className="size-4 rounded-sm" />
            ) : (
              <span className="size-4" />
            )}
            <span className="flex-1 truncate">{app.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
