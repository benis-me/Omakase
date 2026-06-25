import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { KnowledgeEventDto, RuleDoc } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';
import { ContentLayout } from './ContentLayout';

type Sel = { kind: 'agents' } | { kind: 'rule'; name: string } | { kind: 'wiki' } | { kind: 'knowledge' };

export function MemoryView() {
  const activePath = useAppStore((s) => s.active?.path);
  const [agentsMd, setAgentsMd] = useState('');
  const [rules, setRules] = useState<RuleDoc[]>([]);
  const [wiki, setWiki] = useState('');
  const [events, setEvents] = useState<KnowledgeEventDto[]>([]);
  const [sel, setSel] = useState<Sel>({ kind: 'agents' });
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void window.omakase.memory.readAgentsMd().then(setAgentsMd);
    void window.omakase.memory.listRules().then(setRules);
    void window.omakase.memory.readWiki().then(setWiki);
    void window.omakase.memory.knowledgeEvents().then(setEvents);
  }, [activePath]);

  useEffect(() => {
    if (sel.kind === 'agents') setText(agentsMd);
    else if (sel.kind === 'rule') setText(rules.find((r) => r.name === sel.name)?.body ?? '');
    setDirty(false);
  }, [sel, agentsMd, rules]);

  const save = async (): Promise<void> => {
    if (sel.kind === 'agents') {
      await window.omakase.memory.writeAgentsMd(text);
      setAgentsMd(text);
    } else if (sel.kind === 'rule') {
      await window.omakase.memory.writeRule(sel.name, text);
      setRules((p) => p.map((r) => (r.name === sel.name ? { ...r, body: text } : r)));
    }
    setDirty(false);
  };

  const addRule = async (): Promise<void> => {
    let name = 'new-rule';
    for (let i = 2; rules.some((r) => r.name === name); i += 1) name = `new-rule-${i}`;
    await window.omakase.memory.writeRule(name, '# New rule\n');
    setRules((p) => [...p, { name, body: '# New rule\n' }]);
    setSel({ kind: 'rule', name });
  };
  const removeRule = async (name: string): Promise<void> => {
    await window.omakase.memory.deleteRule(name);
    setRules((p) => p.filter((r) => r.name !== name));
    setSel({ kind: 'agents' });
  };

  const navBtn = (active: boolean): string =>
    cn('block w-full truncate rounded-md px-2 py-1.5 text-left text-[13px]', active ? 'bg-accent' : 'hover:bg-accent/50');
  const editable = sel.kind === 'agents' || sel.kind === 'rule';

  return (
    <ContentLayout title="Memory">
      <div className="w-56 shrink-0 overflow-y-auto border-r p-1.5">
        <button className={navBtn(sel.kind === 'agents')} onClick={() => setSel({ kind: 'agents' })}>
          AGENTS.md
        </button>
        <button className={navBtn(sel.kind === 'wiki')} onClick={() => setSel({ kind: 'wiki' })}>
          Wiki
        </button>
        <button className={navBtn(sel.kind === 'knowledge')} onClick={() => setSel({ kind: 'knowledge' })}>
          Knowledge ({events.length})
        </button>
        <div className="mt-2 flex items-center px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Rules
          <button onClick={() => void addRule()} className="ml-auto hover:text-foreground" title="Add rule">
            <Plus className="size-3.5" />
          </button>
        </div>
        {rules.map((r) => (
          <button
            key={r.name}
            className={navBtn(sel.kind === 'rule' && sel.name === r.name)}
            onClick={() => setSel({ kind: 'rule', name: r.name })}
          >
            <span className="font-mono text-[12px]">{r.name}</span>
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {editable ? (
          <>
            <div className="flex items-center gap-2 border-b px-4 py-2">
              <span className="font-mono text-[12px] text-muted-foreground">
                {sel.kind === 'agents' ? 'memory/AGENTS.md' : `memory/rules/${sel.name}.md`}
              </span>
              <Button
                variant={dirty ? 'omk' : 'ghost'}
                size="sm"
                className="ml-auto"
                disabled={!dirty}
                onClick={() => void save()}
              >
                Save
              </Button>
              {sel.kind === 'rule' && (
                <button
                  onClick={() => void removeRule(sel.name)}
                  className="text-muted-foreground hover:text-destructive"
                  title="Delete rule"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setDirty(true);
              }}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed outline-none"
            />
          </>
        ) : sel.kind === 'wiki' ? (
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 font-mono text-[12px] leading-relaxed text-foreground">
            {wiki || 'The project wiki is empty. Agents accumulate knowledge here as they run.'}
          </pre>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {events.length === 0 && (
              <p className="p-4 text-center text-[12px] text-muted-foreground">
                No knowledge events yet.
              </p>
            )}
            {events.map((e) => (
              <div key={e.id} className="mb-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                    {e.kind}
                  </span>
                  <span className="truncate text-[13px] font-medium">{e.title}</span>
                </div>
                {e.body && <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{e.body}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </ContentLayout>
  );
}
