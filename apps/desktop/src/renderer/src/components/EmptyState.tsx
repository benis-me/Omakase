import { FolderOpen, Sparkles } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { Button } from './ui/button';

export function EmptyState() {
  const browseAndAdd = useAppStore((s) => s.browseAndAdd);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
      <div className="grid size-14 place-items-center rounded-2xl bg-omk/12 text-omk">
        <Sparkles className="size-7" />
      </div>
      <div className="space-y-1.5">
        <h1 className="text-[18px] font-semibold tracking-tight">Welcome to Omakase</h1>
        <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">
          Hand a spec to autonomous, long-running multi-agent loops — and let them finish the work.
          Open a folder to begin; it becomes a workspace.
        </p>
      </div>
      <Button variant="omk" size="md" onClick={() => void browseAndAdd()}>
        <FolderOpen className="size-4" />
        Open a folder
      </Button>
    </div>
  );
}
