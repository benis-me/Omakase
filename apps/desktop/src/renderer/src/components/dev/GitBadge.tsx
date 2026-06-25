import { GitBranch } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

export function GitBadge() {
  const git = useAppStore((s) => s.gitInfo);
  if (!git || !git.branch) return null;

  const parts = [`${git.changes} change${git.changes === 1 ? '' : 's'}`];
  if (git.ahead) parts.push(`↑${git.ahead}`);
  if (git.behind) parts.push(`↓${git.behind}`);

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title={parts.join(', ')}>
      <GitBranch className="size-3" />
      <span className="max-w-[140px] truncate font-mono">{git.branch}</span>
      {git.dirty && <span className="size-1.5 rounded-full bg-warn" />}
    </div>
  );
}
