import { useEffect, useRef } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  Brain,
  CheckCircle2,
  Circle,
  Flag,
  FileText,
  GitBranch,
  ListTree,
  RotateCw,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { CockpitEvent, CockpitEventKind, CockpitLevel } from '@shared/types';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n';

const ICON: Record<CockpitEventKind, LucideIcon> = {
  status: Activity,
  route: GitBranch,
  plan: ListTree,
  task: Circle,
  agent: Bot,
  tool: Wrench,
  review: CheckCircle2,
  report: FileText,
  knowledge: Brain,
  gate: AlertTriangle,
  'gate-answered': CheckCircle2,
  iteration: RotateCw,
  error: XCircle,
  finished: Flag,
  note: Circle,
};

const LEVEL_COLOR: Record<CockpitLevel, string> = {
  info: 'text-muted-foreground',
  warn: 'text-warn',
  error: 'text-destructive',
  success: 'text-run',
};

function FeedRow({ event }: { event: CockpitEvent }) {
  const Icon = ICON[event.kind];
  // Tool calls read best on one line: "Read · src/foo.ts" — the title is the tool,
  // the detail is its target rendered inline in mono. Other kinds keep a wrapped
  // detail block (reports, errors, knowledge…).
  const inlineDetail = event.kind === 'tool';
  return (
    <div className="flex gap-2.5 rounded-md px-2 py-1 transition-colors hover:bg-accent/30">
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', LEVEL_COLOR[event.level])} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn('shrink-0 text-[13px] leading-snug', inlineDetail && 'font-medium')}>
            {event.title}
          </span>
          {inlineDetail && event.detail && (
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground/90">
              {event.detail}
            </span>
          )}
          {event.role && (
            <span className="ml-auto shrink-0 font-mono text-[10px] uppercase text-muted-foreground/70">
              {event.role}
            </span>
          )}
        </div>
        {!inlineDetail && event.detail && (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted-foreground">
            {event.detail.length > 600 ? `${event.detail.slice(0, 600)}…` : event.detail}
          </p>
        )}
      </div>
    </div>
  );
}

export function CockpitFeed({ feed }: { feed: CockpitEvent[] }) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  // 'agent' events feed the live roster (Agents view), not the activity log.
  const items = feed.filter((e) => e.kind !== 'agent');
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  if (items.length === 0) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-muted-foreground">
        {t('Waiting for the first event…')}
      </div>
    );
  }

  // h-full (not flex-1) because the tab content host is a block, not a flex column —
  // matching the sibling panels. flex-1 there is ignored, so the feed would grow and
  // overrun the steering input instead of scrolling.
  return (
    <div ref={ref} className="h-full space-y-2 overflow-y-auto p-4">
      {items.map((e) => (
        <FeedRow key={e.seq} event={e} />
      ))}
    </div>
  );
}
