import { GitBranch } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { Badge } from '../ui/badge';
import { Tooltip } from '../ui/tooltip';

export function GitBadge() {
  const git = useAppStore((s) => s.gitInfo);
  if (!git || !git.branch) return null;

  const parts = [`${git.changes} change${git.changes === 1 ? '' : 's'}`];
  if (git.ahead) parts.push(`↑${git.ahead}`);
  if (git.behind) parts.push(`↓${git.behind}`);

  return (
    <Tooltip content={parts.join(' · ')}>
      <span className="inline-flex">
        <Badge variant={git.dirty ? 'warn' : 'outline'} className="gap-1 normal-case">
          <GitBranch className="size-3" />
          <span className="max-w-[140px] truncate font-mono">{git.branch}</span>
          {git.dirty && <span className="size-1.5 rounded-full bg-warn" />}
        </Badge>
      </span>
    </Tooltip>
  );
}
