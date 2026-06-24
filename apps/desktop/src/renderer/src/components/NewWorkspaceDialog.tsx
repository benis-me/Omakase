import { useState } from 'react';
import { Dialog } from 'radix-ui';
import { FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { Button } from './ui/button';

export function NewWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createWorkspace = useAppStore((s) => s.createWorkspace);
  const [parent, setParent] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const canSubmit = Boolean(parent) && name.trim().length > 0 && !busy;

  const pick = async () => {
    const folder = await window.omakase.workspaces.pickFolder();
    if (folder) setParent(folder);
  };

  const submit = async () => {
    if (!parent || !name.trim()) return;
    setBusy(true);
    try {
      await createWorkspace(parent, name.trim());
      onOpenChange(false);
      setParent(null);
      setName('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-popover p-5 text-popover-foreground shadow-2xl">
          <Dialog.Title className="text-[15px] font-semibold tracking-tight">
            New project workspace
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            Creates a new folder with an <span className="font-mono">.omks</span> workspace inside.
          </Dialog.Description>

          <div className="mt-4 space-y-3">
            <div>
              <span className="mb-1 block text-[12px] text-muted-foreground">Location</span>
              <button
                onClick={() => void pick()}
                className="flex w-full items-center gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-accent"
              >
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                <span className={cn('flex-1 truncate text-[13px]', !parent && 'text-muted-foreground')}>
                  {parent ?? 'Choose a parent folder…'}
                </span>
              </button>
            </div>

            <div>
              <span className="mb-1 block text-[12px] text-muted-foreground">Project name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                placeholder="my-project"
                className="w-full rounded-md border bg-background px-3 py-2 text-[13px] outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSubmit) void submit();
                }}
              />
            </div>

            {parent && name.trim() && (
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {parent}/{name.trim()}
              </p>
            )}
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm">
                Cancel
              </Button>
            </Dialog.Close>
            <Button variant="omk" size="sm" disabled={!canSubmit} onClick={() => void submit()}>
              Create workspace
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
