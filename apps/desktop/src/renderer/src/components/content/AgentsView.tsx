import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { AgentDoc, DetectedAgentDto } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Tooltip } from '../ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { StatusDot } from '../StatusDot';
import { ContentLayout, EmptyDetail } from './ContentLayout';

const ROLES = ['custom', 'router', 'planner', 'worker', 'reviewer', 'reporter', 'wiki-curator'];

export function AgentsView() {
  const activePath = useAppStore((s) => s.active?.path);
  const [agents, setAgents] = useState<AgentDoc[]>([]);
  const [detected, setDetected] = useState<DetectedAgentDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDoc | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void window.omakase.agents.list().then((list) => {
      setAgents(list);
      setSelectedId((cur) => (cur && list.some((a) => a.id === cur) ? cur : (list[0]?.id ?? null)));
    });
    void window.omakase.agents.detect().then(setDetected);
  }, [activePath]);

  useEffect(() => {
    const agent = agents.find((a) => a.id === selectedId) ?? null;
    setDraft(agent ? { ...agent } : null);
    setDirty(false);
  }, [selectedId, agents]);

  const create = async (): Promise<void> => {
    const doc = await window.omakase.agents.create('New agent');
    if (doc) {
      setAgents((p) => [...p, doc]);
      setSelectedId(doc.id);
    }
  };
  const save = async (): Promise<void> => {
    if (!draft) return;
    await window.omakase.agents.save(draft);
    setDirty(false);
    setAgents((p) => p.map((a) => (a.id === draft.id ? draft : a)));
  };
  const remove = async (id: string): Promise<void> => {
    await window.omakase.agents.delete(id);
    setAgents((p) => p.filter((a) => a.id !== id));
    if (selectedId === id) setSelectedId(null);
  };
  const update = (patch: Partial<AgentDoc>): void => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  };

  const agentIds = ['builtin', ...detected.map((d) => d.id)];

  return (
    <ContentLayout title="Agents" onNew={() => void create()} newLabel="New agent">
      <div className="w-60 shrink-0 overflow-y-auto border-r p-2">
        <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Detected
        </div>
        {detected.length === 0 && (
          <p className="px-2 pb-2 text-[11px] text-muted-foreground">No agent CLIs found.</p>
        )}
        {detected.map((d) => (
          <div key={d.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
            <StatusDot status={d.available ? 'run' : 'idle'} />
            <span className="flex-1 truncate">{d.name}</span>
            {d.version && <span className="font-mono text-[10px] text-muted-foreground">{d.version}</span>}
          </div>
        ))}
        <div className="mt-3 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Custom
        </div>
        {agents.length === 0 && (
          <p className="px-2 py-2 text-[11px] text-muted-foreground">No custom agents.</p>
        )}
        <div className="flex flex-col gap-0.5">
          {agents.map((a) => (
            <button
              key={a.id}
              onClick={() => setSelectedId(a.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors',
                selectedId === a.id ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              <span className="flex-1 truncate">{a.name}</span>
              <Badge variant="outline">{a.role}</Badge>
            </button>
          ))}
        </div>
      </div>
      {draft ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid grid-cols-2 gap-x-3 gap-y-3 border-b p-4">
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label htmlFor="agent-name">Name</Label>
              <Input
                id="agent-name"
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-role">Role</Label>
              <Select value={draft.role} onValueChange={(v) => update({ role: v })}>
                <SelectTrigger id="agent-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-cli">Agent CLI</Label>
              <Select value={draft.agentId} onValueChange={(v) => update({ agentId: v })}>
                <SelectTrigger id="agent-cli" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[...new Set([draft.agentId, ...agentIds])].map((id) => (
                    <SelectItem key={id} value={id}>
                      {id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-model">Model</Label>
              <Input
                id="agent-model"
                value={draft.model ?? ''}
                onChange={(e) => update({ model: e.target.value || null })}
                placeholder="(default)"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-reasoning">Reasoning</Label>
              <Input
                id="agent-reasoning"
                value={draft.reasoning ?? ''}
                onChange={(e) => update({ reasoning: e.target.value || null })}
                placeholder="(default)"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 px-4 py-2.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              System prompt
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
            <Tooltip content="Delete agent">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => void remove(draft.id)}
              >
                <Trash2 />
              </Button>
            </Tooltip>
          </div>
          <Textarea
            value={draft.body}
            onChange={(e) => update({ body: e.target.value })}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-4 pb-4 font-mono text-[13px] leading-relaxed shadow-none focus-visible:ring-0"
          />
        </div>
      ) : (
        <EmptyDetail message="Select an agent definition, or create one to customize its role, model, and system prompt." />
      )}
    </ContentLayout>
  );
}
