import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { CommandDocDto } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';
import { CodeEditor } from '../ui/code-editor';
import { Tooltip } from '../ui/tooltip';
import { ContentLayout, EmptyDetail } from './ContentLayout';

export function CommandsView() {
  const activePath = useAppStore((s) => s.active?.path);
  const [commands, setCommands] = useState<CommandDocDto[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void window.omakase.commands.list().then((list) => {
      setCommands(list);
      setSelectedName((cur) =>
        cur && list.some((c) => c.name === cur) ? cur : (list[0]?.name ?? null),
      );
    });
  }, [activePath]);

  useEffect(() => {
    setBody(commands.find((c) => c.name === selectedName)?.body ?? '');
    setDirty(false);
  }, [selectedName, commands]);

  const create = async (): Promise<void> => {
    // Electron's renderer has no window.prompt(); create with a unique default
    // name (the file name = the /command), like Memory rules.
    let name = 'new-command';
    for (let i = 2; commands.some((c) => c.name === name); i += 1) name = `new-command-${i}`;
    const doc = await window.omakase.commands.create(name);
    if (doc) {
      setCommands((p) => [...p, doc].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedName(doc.name);
    }
  };
  const save = async (): Promise<void> => {
    if (!selectedName) return;
    await window.omakase.commands.save(selectedName, body);
    setDirty(false);
    setCommands((p) => p.map((c) => (c.name === selectedName ? { ...c, body } : c)));
  };
  const remove = async (name: string): Promise<void> => {
    await window.omakase.commands.delete(name);
    setCommands((p) => p.filter((c) => c.name !== name));
    if (selectedName === name) setSelectedName(null);
  };

  const selected = commands.find((c) => c.name === selectedName);

  return (
    <ContentLayout title="Commands" onNew={() => void create()}>
      <div className="w-60 shrink-0 overflow-y-auto border-r p-2">
        {commands.length === 0 ? (
          <p className="px-2 py-8 text-center text-[12px] leading-relaxed text-muted-foreground">
            No commands yet. Create one with “New” to save a reusable prompt.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {commands.map((c) => (
              <button
                key={c.name}
                onClick={() => setSelectedName(c.name)}
                className={cn(
                  'block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors',
                  selectedName === c.name ? 'bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <span className="font-mono text-muted-foreground">/</span>
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {selected ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-11 items-center gap-2 border-b px-4">
            <span className="font-mono text-[12px] text-muted-foreground">
              commands/{selected.name}.md
            </span>
            <Button
              variant={dirty ? 'omk' : 'outline'}
              size="sm"
              className="ml-auto"
              disabled={!dirty}
              onClick={() => void save()}
            >
              Save
            </Button>
            <Tooltip content="Delete command">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => void remove(selected.name)}
              >
                <Trash2 />
              </Button>
            </Tooltip>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/30 px-3 py-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Recipe
            </span>
            <Tooltip content="Interpolated with the text passed after the command when it runs.">
              <code className="cursor-default rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80 hover:text-foreground">
                $ARGUMENTS
              </code>
            </Tooltip>
            <span className="text-[11px] leading-snug text-muted-foreground">
              Markdown prompt that agents and loops can invoke as <code>/{selected.name}</code>.
            </span>
          </div>
          <CodeEditor
            language="markdown"
            value={body}
            onChange={(v) => {
              setBody(v);
              setDirty(true);
            }}
            className="min-h-0 flex-1 px-2 py-1"
          />
        </div>
      ) : (
        <EmptyDetail message="Commands are reusable prompt recipes — “skills” you write once as markdown and the agents or loops invoke as /name. Create one to capture a prompt you run often." />
      )}
    </ContentLayout>
  );
}
