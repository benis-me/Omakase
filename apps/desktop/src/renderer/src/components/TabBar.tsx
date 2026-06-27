import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { NAV_SECTIONS } from './nav';

/** The active project's sections, as a horizontal tab strip across the top. */
export function TabBar() {
  const nav = useAppStore((s) => s.nav);
  const setNav = useAppStore((s) => s.setNav);
  const t = useT();

  return (
    <div className="no-drag flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2">
      {NAV_SECTIONS.map((item) => {
        const Icon = item.icon;
        const isActive = nav === item.id;
        return (
          <button
            key={item.id}
            onClick={() => setNav(item.id)}
            title={t(item.hint)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40',
              isActive
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className={cn('size-4 shrink-0', isActive && 'text-omk')} />
            {t(item.label)}
          </button>
        );
      })}
    </div>
  );
}
