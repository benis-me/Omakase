import { GitBranch } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { Badge } from '../ui/badge';
import { Tooltip } from '../ui/tooltip';

export function GitBadge() {
  const git = useAppStore((s) => s.gitInfo);
  const t = useT();
  if (!git || !git.branch) return null;

  const parts = [`${git.changes} ${git.changes === 1 ? t('change') : t('changes')}`];
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
