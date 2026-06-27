import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function NewWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createWorkspace = useAppStore((s) => s.createWorkspace);
  const t = useT();
  const [parent, setParent] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const canSubmit = Boolean(parent) && name.trim().length > 0 && !busy;

  const pick = async (): Promise<void> => {
    const folder = await window.omakase.workspaces.pickFolder();
    if (folder) setParent(folder);
  };
  const submit = async (): Promise<void> => {
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-4">
        <DialogHeader>
          <DialogTitle>{t('New project workspace')}</DialogTitle>
          <DialogDescription>
            {t('Creates a new folder with an')} <span className="font-mono">.omks</span>{' '}
            {t('workspace inside.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label>{t('Location')}</Label>
            <Button
              variant="outline"
              className="w-full justify-start gap-2 font-normal"
              onClick={() => void pick()}
            >
              <FolderOpen className="text-muted-foreground" />
              <span className={cn('truncate', !parent && 'text-muted-foreground')}>
                {parent ?? t('Choose a parent folder…')}
              </span>
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-name">{t('Project name')}</Label>
            <Input
              id="ws-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
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

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              {t('Cancel')}
            </Button>
          </DialogClose>
          <Button variant="omk" size="sm" disabled={!canSubmit} onClick={() => void submit()}>
            {t('Create workspace')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
