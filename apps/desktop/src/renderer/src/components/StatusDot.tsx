import { cn } from '@/lib/utils';

export type DotStatus = 'run' | 'warn' | 'idle' | 'fail' | 'omk';

const COLOR: Record<DotStatus, string> = {
  run: 'bg-run',
  warn: 'bg-warn',
  idle: 'bg-idle',
  fail: 'bg-destructive',
  omk: 'bg-omk',
};

export function StatusDot({
  status,
  pulse = false,
  glow = false,
  className,
}: {
  status: DotStatus;
  pulse?: boolean;
  glow?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        COLOR[status],
        pulse && 'breathe',
        glow && status === 'run' && 'glow-run',
        glow && status === 'omk' && 'glow-omk',
        className,
      )}
    />
  );
}
