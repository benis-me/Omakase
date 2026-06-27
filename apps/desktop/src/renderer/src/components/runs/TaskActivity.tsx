import type { CockpitEvent } from '@shared/types';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

const LEVEL_TEXT: Record<string, string> = {
  error: 'text-destructive',
  warn: 'text-warn',
  success: 'text-run',
};

/**
 * The recorded activity for one task (or its agent): the tool calls it made and any
 * errors, drawn straight from the cockpit feed by `taskId`. Used by the expandable
 * Tasks panel and the Agents roster so a row can be opened to see what it actually did.
 */
export function TaskActivity({ feed, taskId }: { feed: CockpitEvent[]; taskId?: string }) {
  const t = useT();
  const items = taskId
    ? feed.filter((e) => e.taskId === taskId && (e.kind === 'tool' || e.kind === 'error' || e.kind === 'review'))
    : [];

  if (items.length === 0)
    return (
      <p className="px-2 py-1.5 text-[12px] text-muted-foreground">{t('No recorded activity yet.')}</p>
    );

  return (
    <div className="ml-1.5 flex flex-col gap-1 border-l-2 border-border/60 py-1 pl-3">
      {items.map((e) => (
        <div key={e.seq} className="flex items-baseline gap-2 text-[12px] leading-snug">
          <span className={cn('shrink-0 font-medium', LEVEL_TEXT[e.level])}>{e.title}</span>
          {e.detail && (
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80">
              {e.detail}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
