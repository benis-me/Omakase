import { useEffect, useMemo, useState } from 'react';
import { FileCog, Save } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';

interface EnvFileRef {
  label: string;
  absPath: string;
}

export function EnvEditor({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[480px] w-[700px] max-w-none flex-col gap-0 overflow-hidden p-0">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b pl-4 pr-12">
          <FileCog className="size-4 text-muted-foreground" />
          <DialogTitle className="text-[13px] font-medium">{t('Environment files')}</DialogTitle>
          <Button
            variant={dirty ? 'omk' : 'outline'}
            size="sm"
            className="ml-auto gap-1.5"
            disabled={!selected || !dirty}
            onClick={() => void save()}
          >
            <Save className="size-3.5" />
            {t('Save')}
          </Button>
        </div>
        {files.length === 0 ? (
          <div className="grid flex-1 place-items-center p-8 text-center text-[12px] text-muted-foreground">
            {t('No .env files in this workspace.')}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="w-52 shrink-0 overflow-y-auto border-r p-2">
              <div className="flex flex-col gap-0.5">
                {files.map((f) => (
                  <button
                    key={f.absPath}
                    onClick={() => setSelected(f.absPath)}
                    className={cn(
                      'block w-full truncate rounded-md px-2.5 py-1.5 text-left font-mono text-[12px] transition-colors',
                      selected === f.absPath ? 'bg-accent' : 'hover:bg-accent/50',
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <Textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-3 font-mono text-[12px] leading-relaxed shadow-none focus-visible:ring-0"
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
