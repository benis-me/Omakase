import { FolderOpen, Sparkles } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/button';

export function EmptyState() {
  const browseAndAdd = useAppStore((s) => s.browseAndAdd);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="grid size-16 place-items-center rounded-2xl bg-omk/12 text-omk ring-1 ring-omk/20">
        <Sparkles className="size-8" />
      </div>
      <div className="space-y-2">
        <h1 className="text-[19px] font-semibold tracking-tight">Welcome to Omakase</h1>
        <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">
          Hand a spec to autonomous, long-running multi-agent loops — and let them finish the work,
          while you watch and steer. Open a folder to begin; it becomes a workspace.
        </p>
      </div>
      <Button variant="omk" size="lg" onClick={() => void browseAndAdd()}>
        <FolderOpen />
        Open a folder
      </Button>
    </div>
  );
}
