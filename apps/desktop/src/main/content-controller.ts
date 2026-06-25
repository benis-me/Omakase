/**
 * CRUD over the active workspace's authored content — specs, agents, memory, and
 * workflows — by delegating to @omakase/storage, plus local agent-CLI detection
 * via @omakase/daemon. All operations are scoped to `host.activeWorkspace`.
 */
import {
  createAgent,
  createSpec,
  createWorkflow,
  deleteAgent,
  deleteRule,
  deleteSpec,
  deleteWorkflow,
  listAgents,
  listRules,
  listSpecs,
  listWorkflows,
  readAgent,
  readAgentsMd,
  readSpec,
  readWikiMarkdown,
  readWorkflow,
  writeAgent,
  writeAgentsMd,
  writeRule,
  writeSpec,
  writeWorkflow,
  type AgentDoc,
  type SpecDoc,
  type WorkflowDoc,
} from '@omakase/storage';
import { createAgentRuntime, type AgentRuntime } from '@omakase/daemon';
import type { DetectedAgentDto, KnowledgeEventDto, RuleDoc } from '@shared/types';
import type { WorkspaceHost } from './workspace-host.js';

export class ContentController {
  private runtime: AgentRuntime | null = null;

  constructor(private readonly host: WorkspaceHost) {}

  private root(): string | null {
    return this.host.activeWorkspace?.root ?? null;
  }

  // ── Specs ───────────────────────────────────────────────────────────────
  listSpecs(): SpecDoc[] {
    const root = this.root();
    return root ? listSpecs(root) : [];
  }
  getSpec(id: string): SpecDoc | null {
    const root = this.root();
    return root ? readSpec(root, id) : null;
  }
  createSpec(title: string): SpecDoc | null {
    const root = this.root();
    return root ? createSpec(root, { title }) : null;
  }
  saveSpec(doc: SpecDoc): void {
    const root = this.root();
    if (root) writeSpec(root, { ...doc, updatedAt: Date.now() });
  }
  deleteSpec(id: string): void {
    const root = this.root();
    if (root) deleteSpec(root, id);
  }

  // ── Agents ──────────────────────────────────────────────────────────────
  listAgents(): AgentDoc[] {
    const root = this.root();
    return root ? listAgents(root) : [];
  }
  getAgent(id: string): AgentDoc | null {
    const root = this.root();
    return root ? readAgent(root, id) : null;
  }
  createAgent(name: string): AgentDoc | null {
    const root = this.root();
    return root ? createAgent(root, { name }) : null;
  }
  saveAgent(doc: AgentDoc): void {
    const root = this.root();
    if (root) writeAgent(root, { ...doc, updatedAt: Date.now() });
  }
  deleteAgent(id: string): void {
    const root = this.root();
    if (root) deleteAgent(root, id);
  }

  async detectAgents(): Promise<DetectedAgentDto[]> {
    this.runtime ??= createAgentRuntime({ fallbackToBuiltin: true, detectionCacheTtlMs: 10_000 });
    const agents = await this.runtime.detect();
    return agents.map((a) => ({
      id: a.id,
      name: a.name,
      available: a.available,
      version: a.version,
      models: a.models.map((m) => m.id),
    }));
  }

  // ── Memory ──────────────────────────────────────────────────────────────
  readAgentsMd(): string {
    const root = this.root();
    return root ? readAgentsMd(root) : '';
  }
  writeAgentsMd(text: string): void {
    const root = this.root();
    if (root) writeAgentsMd(root, text);
  }
  readWiki(): string {
    const root = this.root();
    return root ? readWikiMarkdown(root) : '';
  }
  listRules(): RuleDoc[] {
    const root = this.root();
    return root ? listRules(root) : [];
  }
  writeRule(name: string, body: string): void {
    const root = this.root();
    if (root) writeRule(root, name, body);
  }
  deleteRule(name: string): void {
    const root = this.root();
    if (root) deleteRule(root, name);
  }
  async knowledgeEvents(): Promise<KnowledgeEventDto[]> {
    const ws = this.host.activeWorkspace;
    if (!ws) return [];
    const events = await ws.knowledgeStore.loadKnowledgeEvents();
    return events
      .map((e) => ({ id: e.id, runId: e.runId, kind: e.kind, title: e.title, body: e.body, createdAt: e.createdAt }))
      .reverse();
  }

  // ── Workflows ─────────────────────────────────────────────────────────────
  listWorkflows(): WorkflowDoc[] {
    const root = this.root();
    return root ? listWorkflows(root) : [];
  }
  getWorkflow(id: string): WorkflowDoc | null {
    const root = this.root();
    return root ? readWorkflow(root, id) : null;
  }
  createWorkflow(name: string): WorkflowDoc | null {
    const root = this.root();
    return root ? createWorkflow(root, name) : null;
  }
  saveWorkflow(id: string, source: string): void {
    const root = this.root();
    if (root) writeWorkflow(root, id, source);
  }
  deleteWorkflow(id: string): void {
    const root = this.root();
    if (root) deleteWorkflow(root, id);
  }
}
