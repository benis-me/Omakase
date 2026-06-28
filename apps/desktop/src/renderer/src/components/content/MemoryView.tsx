import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { KnowledgeEventDto, RuleDoc } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { CodeEditor } from '../ui/code-editor';
import { MarkdownPreview } from '../ui/markdown-preview';
import { Tooltip } from '../ui/tooltip';
import { Card, CardContent, CardHeader } from '../ui/card';
import { ContentLayout } from './ContentLayout';

type Sel = { kind: 'agents' } | { kind: 'rule'; name: string } | { kind: 'wiki' } | { kind: 'knowledge' };

export function MemoryView() {
  const t = useT();
  const activePath = useAppStore((s) => s.active?.path);
  const contentTick = useAppStore((s) => s.contentTick);
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
  }, [activePath, contentTick]);

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
    cn(
      'block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors',
      active ? 'bg-accent' : 'hover:bg-accent/50',
    );
  const editable = sel.kind === 'agents' || sel.kind === 'rule';

  return (
    <ContentLayout title="Memory">
      <div className="w-56 shrink-0 overflow-y-auto border-r p-2">
        <div className="flex flex-col gap-0.5">
          <button className={navBtn(sel.kind === 'agents')} onClick={() => setSel({ kind: 'agents' })}>
            AGENTS.md
          </button>
          <button className={navBtn(sel.kind === 'wiki')} onClick={() => setSel({ kind: 'wiki' })}>
            {t('Wiki')}
          </button>
          <button className={navBtn(sel.kind === 'knowledge')} onClick={() => setSel({ kind: 'knowledge' })}>
            <span className="flex items-center gap-1.5">
              {t('Knowledge')}
              <Badge variant="outline">{events.length}</Badge>
            </span>
          </button>
        </div>
        <div className="mt-3 flex items-center px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('Rules')}
          <Tooltip content={t('Add rule')}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto size-5 text-muted-foreground hover:text-foreground"
              onClick={() => void addRule()}
            >
              <Plus />
            </Button>
          </Tooltip>
        </div>
        <div className="flex flex-col gap-0.5">
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
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {editable ? (
          <>
            <div className="flex h-11 items-center gap-2 border-b px-4">
              <span className="font-mono text-[12px] text-muted-foreground">
                {sel.kind === 'agents' ? 'memory/AGENTS.md' : `memory/rules/${sel.name}.md`}
              </span>
              <Button
                variant={dirty ? 'omk' : 'outline'}
                size="sm"
                className="ml-auto"
                disabled={!dirty}
                onClick={() => void save()}
              >
                {t('Save')}
              </Button>
              {sel.kind === 'rule' && (
                <Tooltip content={t('Delete rule')}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => void removeRule(sel.name)}
                  >
                    <Trash2 />
                  </Button>
                </Tooltip>
              )}
            </div>
            <CodeEditor
              language="markdown"
              value={text}
              onChange={(v) => {
                setText(v);
                setDirty(true);
              }}
              className="min-h-0 flex-1 px-2 py-1"
            />
          </>
        ) : sel.kind === 'wiki' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {wiki.trim() ? (
              <>
                <div className="mb-4 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                  {t(
                    'Durable knowledge agents accumulate across runs. Decisions & risks are the always-in-context core; the rest is retrieved by relevance or read on demand — agents are never force-fed the whole wiki.',
                  )}
                </div>
                <MarkdownPreview source={wiki} />
              </>
            ) : (
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {t('The project wiki is empty. Agents accumulate knowledge here as they run.')}
              </p>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {events.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="max-w-xs text-center text-[12px] leading-relaxed text-muted-foreground">
                  {t('No knowledge events yet. Agents record what they learn here as runs progress.')}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {events.map((e) => (
                  <Card key={e.id}>
                    <CardHeader className="flex-row items-center gap-2 p-3">
                      <Badge variant="outline">{e.kind}</Badge>
                      <span className="truncate text-[13px] font-medium">{e.title}</span>
                    </CardHeader>
                    {e.body && (
                      <CardContent className="px-3 pb-3 pt-0">
                        <p className="text-[12px] leading-relaxed text-muted-foreground">{e.body}</p>
                      </CardContent>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </ContentLayout>
  );
}
