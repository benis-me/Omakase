import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunDetail } from './api.ts';
import { buildBlocks, type AgentBlock, type Block } from './events.ts';
import { Markdown } from './markdown.tsx';
import { fmtCost, fmtTokens, fmtDuration, RUNNING } from './format.ts';

export function RunView({ detail, onCancel }: { detail: RunDetail; onCancel: () => void }) {
  const { run, events } = detail;
  const running = RUNNING.has(run.status);
  const blocks = useMemo(() => buildBlocks(events), [events]);

  // A live run ticks the elapsed clock; a finished one shows its total span.
  const [, force] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  const elapsed = fmtDuration((running ? Date.now() : run.updatedAt) - run.createdAt);

  // A live run sticks to the newest event (unless the reader scrolled up); a
  // finished run opens at the top, where its story begins.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(running);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && running && pinned.current) el.scrollTop = el.scrollHeight;
  }, [blocks.length, running]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const agentCount = blocks.filter((b) => b.kind === 'agent').length;

  return (
    <div className="runview">
      <div className="runhead">
        <div className="rh-top">
          <h2>{run.goal.text}</h2>
          <span className={`badge ${run.status}`}>
            <span className="bd" />
            {run.status}
          </span>
          {running && (
            <button className="cancel" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
        <div className="metrics">
          <Metric v={String(run.spentAgents)} l="agents" />
          <Metric v={fmtTokens(run.spentTokens)} l="tokens" />
          <Metric v={fmtCost(run.spentCostUsd)} l="cost" />
          <Metric v={elapsed} l={running ? 'elapsed' : 'took'} />
          <Metric v={run.workflow} l="workflow" mono />
        </div>
      </div>

      <div className="stream" ref={scrollRef} onScroll={onScroll}>
        {blocks.map((b) => (
          <BlockView key={b.key} block={b} soloish={agentCount <= 2} />
        ))}
        {running && <div className="loose log"><span className="lg" /><span className="caret-live" /></div>}
      </div>
    </div>
  );
}

function Metric({ v, l, mono }: { v: string; l: string; mono?: boolean }) {
  return (
    <div className="metric">
      <div className={`mv ${mono ? 'mono' : 'tnum'}`}>{v}</div>
      <div className="ml">{l}</div>
    </div>
  );
}

function BlockView({ block, soloish }: { block: Block; soloish: boolean }) {
  if (block.kind === 'phase') {
    return (
      <div className="phase">
        <span className="pn">{block.name}</span>
        <span className="pl" />
      </div>
    );
  }
  if (block.kind === 'loose') {
    if (block.cls.startsWith('ended')) {
      const [, status] = block.cls.split(' ');
      return (
        <div className={`ended ${status}`}>
          <span>{block.glyph}</span>
          <span>{status}</span>
          <span className="es">· {block.text}</span>
        </div>
      );
    }
    return (
      <div className={`loose ${block.cls}`}>
        <span className="lg">{block.glyph}</span>
        <span>{block.text}</span>
      </div>
    );
  }
  return <AgentCard block={block} soloish={soloish} />;
}

function AgentCard({ block, soloish }: { block: AgentBlock; soloish: boolean }) {
  // Live and failed agents open themselves; a mostly-successful run stays
  // scannable with completed cards folded — unless there are only a couple.
  const [open, setOpen] = useState(block.status !== 'ok' || soloish);
  const glyph = block.status === 'ok' ? '✓' : block.status === 'error' ? '✗' : '●';
  const gcls = block.status === 'ok' ? 'status-succeeded' : block.status === 'error' ? 'status-failed' : 'status-running';
  const hasBody = block.activities.length > 0 || block.result;

  return (
    <div className={`card ${open ? 'open' : ''} ${block.status === 'live' ? 'live' : ''} ${block.status === 'error' ? 'err' : ''}`}>
      <div className="card-head" onClick={() => hasBody && setOpen((o) => !o)}>
        <span className="caret">{hasBody ? '▸' : ' '}</span>
        <span className={`glyph ${gcls}`}>{glyph}</span>
        <span className="ct">{block.title}</span>
        <span className="prov">{block.provider}</span>
        {block.costUsd > 0 && <span className="cost tnum">{fmtCost(block.costUsd)}</span>}
      </div>
      {open && hasBody && (
        <div className="card-body">
          {block.activities.map((a, i) => (
            <div key={i} className={`act ${a.kind}`}>
              <span className="ag">{a.kind === 'tool' ? '⚙' : a.kind === 'reasoning' ? '✱' : a.kind === 'retry' ? '↻' : '·'}</span>
              <span className="as">{a.summary}</span>
            </div>
          ))}
          {block.result && (
            <div className="output">
              {block.status === 'error' ? block.result : <Markdown text={block.result} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
