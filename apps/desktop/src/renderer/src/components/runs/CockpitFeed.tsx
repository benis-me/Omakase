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
  return (
    <div className="flex gap-2.5">
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', LEVEL_COLOR[event.level])} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] leading-snug">{event.title}</span>
          {event.role && (
            <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground/70">
              {event.role}
            </span>
          )}
        </div>
        {event.detail && (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted-foreground">
            {event.detail.length > 600 ? `${event.detail.slice(0, 600)}…` : event.detail}
          </p>
        )}
      </div>
    </div>
  );
}

export function CockpitFeed({ feed }: { feed: CockpitEvent[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed.length]);

  if (feed.length === 0) {
    return (
      <div className="grid flex-1 place-items-center text-[12px] text-muted-foreground">
        Waiting for the first event…
      </div>
    );
  }

  return (
    <div ref={ref} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
      {feed.map((e) => (
        <FeedRow key={e.seq} event={e} />
      ))}
    </div>
  );
}
