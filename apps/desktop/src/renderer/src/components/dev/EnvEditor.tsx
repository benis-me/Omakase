import { useEffect, useMemo, useState } from 'react';
import { Dialog } from 'radix-ui';
import { FileCog, Save } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';

interface EnvFileRef {
  label: string;
  absPath: string;
}

export function EnvEditor({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const projects = useAppStore((s) => s.projects);
  const files = useMemo<EnvFileRef[]>(
    () =>
      projects.flatMap((p) =>
        p.envFiles.map((f) => ({
          label: p.rel === '.' ? f : `${p.rel}/${f}`,
          absPath: `${p.path}/${f}`,
        })),
      ),
    [projects],
  );

  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (open && files.length && (!selected || !files.some((f) => f.absPath === selected))) {
      setSelected(files[0].absPath);
    }
  }, [open, files, selected]);

  useEffect(() => {
    if (!selected) return;
    void window.omakase.env.read(selected).then((c) => {
      setContent(c);
      setDirty(false);
    });
  }, [selected]);

  const save = async (): Promise<void> => {
    if (!selected) return;
    await window.omakase.env.write(selected, content);
    setDirty(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[480px] w-[700px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
            <FileCog className="size-4 text-muted-foreground" />
            <Dialog.Title className="text-[13px] font-medium">Environment files</Dialog.Title>
            <Button
              variant={dirty ? 'omk' : 'ghost'}
              size="sm"
              className="ml-auto gap-1.5"
              disabled={!selected || !dirty}
              onClick={() => void save()}
            >
              <Save className="size-3.5" />
              Save
            </Button>
          </div>
          {files.length === 0 ? (
            <div className="grid flex-1 place-items-center text-[12px] text-muted-foreground">
              No .env files in this workspace.
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="w-52 shrink-0 overflow-y-auto border-r p-1.5">
                {files.map((f) => (
                  <button
                    key={f.absPath}
                    onClick={() => setSelected(f.absPath)}
                    className={cn(
                      'block w-full truncate rounded px-2 py-1.5 text-left font-mono text-[12px]',
                      selected === f.absPath ? 'bg-accent' : 'hover:bg-accent/50',
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <textarea
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setDirty(true);
                }}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[12px] leading-relaxed outline-none"
              />
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
