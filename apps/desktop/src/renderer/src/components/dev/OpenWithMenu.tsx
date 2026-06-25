import { DropdownMenu } from 'radix-ui';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';

const menuItem =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground';

export function OpenWithMenu() {
  const apps = useAppStore((s) => s.apps);
  if (apps.length === 0) return null;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground hover:text-foreground">
          <ExternalLink className="size-3.5" />
          Open with
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 max-h-[60vh] min-w-[190px] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {apps.map((app) => (
            <DropdownMenu.Item
              key={app.id}
              onSelect={() => void window.omakase.apps.openWith(app.id)}
              className={menuItem}
            >
              {app.icon ? (
                <img src={app.icon} alt="" className="size-4 rounded-sm" />
              ) : (
                <span className="size-4" />
              )}
              <span className="flex-1 truncate">{app.name}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
