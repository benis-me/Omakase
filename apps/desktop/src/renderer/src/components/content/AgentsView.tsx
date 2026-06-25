import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { AgentDoc, DetectedAgentDto } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';
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
      <div className="w-60 shrink-0 overflow-y-auto border-r p-1.5">
        <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Detected
        </div>
        {detected.length === 0 && (
          <p className="px-2 pb-2 text-[11px] text-muted-foreground">No agent CLIs found.</p>
        )}
        {detected.map((d) => (
          <div key={d.id} className="flex items-center gap-2 px-2 py-1 text-[12px]">
            <StatusDot status={d.available ? 'run' : 'idle'} />
            <span className="flex-1 truncate">{d.name}</span>
            {d.version && <span className="font-mono text-[10px] text-muted-foreground">{d.version}</span>}
          </div>
        ))}
        <div className="mt-2 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Custom
        </div>
        {agents.length === 0 && (
          <p className="px-2 py-2 text-[11px] text-muted-foreground">No custom agents.</p>
        )}
        {agents.map((a) => (
          <button
            key={a.id}
            onClick={() => setSelectedId(a.id)}
            className={cn(
              'block w-full truncate rounded-md px-2 py-1.5 text-left text-[13px]',
              selectedId === a.id ? 'bg-accent' : 'hover:bg-accent/50',
            )}
          >
            {a.name}
            <span className="ml-1.5 text-[10px] text-muted-foreground">{a.role}</span>
          </button>
        ))}
      </div>
      {draft ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid grid-cols-2 gap-3 border-b p-3">
            <label className="col-span-2 block">
              <span className="mb-1 block text-[11px] text-muted-foreground">Name</span>
              <input
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
                className="w-full rounded border bg-background px-2 py-1.5 text-[13px] outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted-foreground">Role</span>
              <select
                value={draft.role}
                onChange={(e) => update({ role: e.target.value })}
                className="w-full rounded border bg-background px-2 py-1.5 text-[12px]"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted-foreground">Agent CLI</span>
              <select
                value={draft.agentId}
                onChange={(e) => update({ agentId: e.target.value })}
                className="w-full rounded border bg-background px-2 py-1.5 text-[12px]"
              >
                {[...new Set([draft.agentId, ...agentIds])].map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted-foreground">Model</span>
              <input
                value={draft.model ?? ''}
                onChange={(e) => update({ model: e.target.value || null })}
                placeholder="(default)"
                className="w-full rounded border bg-background px-2 py-1.5 text-[12px] outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted-foreground">Reasoning</span>
              <input
                value={draft.reasoning ?? ''}
                onChange={(e) => update({ reasoning: e.target.value || null })}
                placeholder="(default)"
                className="w-full rounded border bg-background px-2 py-1.5 text-[12px] outline-none"
              />
            </label>
          </div>
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="text-[11px] text-muted-foreground">System prompt</span>
            <Button
              variant={dirty ? 'omk' : 'ghost'}
              size="sm"
              className="ml-auto"
              disabled={!dirty}
              onClick={() => void save()}
            >
              Save
            </Button>
            <button
              onClick={() => void remove(draft.id)}
              className="text-muted-foreground hover:text-destructive"
              title="Delete agent"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
          <textarea
            value={draft.body}
            onChange={(e) => update({ body: e.target.value })}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-transparent px-4 pb-4 font-mono text-[13px] leading-relaxed outline-none"
          />
        </div>
      ) : (
        <EmptyDetail message="Select or create an agent definition." />
      )}
    </ContentLayout>
  );
}
