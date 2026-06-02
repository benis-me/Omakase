/**
 * End-to-end Omakase demo. It shows the full arc a downstream project gets for
 * free by importing @omakase/daemon and @omakase/core:
 *
 *   1. detect local agent CLIs,
 *   2. scan the project into a codegraph,
 *   3. orchestrate a task through the Ralph loop (router → planner → workers →
 *      reviewer → finish), streaming events,
 *   4. inspect the resulting wiki + codegraph knowledge.
 *
 * The orchestration uses an in-process scripted agent so the demo is fully
 * deterministic and runs offline — no real model calls, no installed CLIs
 * required. Detection still reports whatever real agents you happen to have.
 *
 * Run it with:  pnpm --filter @omakase/example-local-project start
 */
import {
  CodeGraph,
  MemoryRunStore,
  Orchestrator,
  createModelPolicy,
  type OrchestratorEvent,
} from '@omakase/core';
import {
  createAgentRuntime,
  createScriptedAgent,
  type DetectionOptions,
} from '@omakase/daemon';

export interface DemoResult {
  agents: number;
  available: number;
  codegraphFiles: number;
  codegraphSymbols: number;
  runStatus: string;
  taskCount: number;
  succeededTasks: number;
  wikiEntries: number;
}

export interface DemoOptions {
  cwd?: string;
  write?: (line: string) => void;
  detection?: DetectionOptions;
}

function describeEvent(event: OrchestratorEvent): string | null {
  switch (event.type) {
    case 'routed':
      return `  routed → ${event.decision.kind}`;
    case 'planned':
      return `  planned ${event.snapshot.tasks.length} tasks`;
    case 'task-finished':
      return `  ${event.success ? '✓' : '✗'} ${event.title}`;
    case 'review':
      return `  review: ${event.approved ? 'approved' : 'rejected'}`;
    case 'run-finished':
      return `  ▣ ${event.status}: ${event.summary}`;
    default:
      return null;
  }
}

export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const write = options.write ?? ((line: string) => console.log(line));
  const cwd = options.cwd ?? process.cwd();

  // A deterministic in-process agent so the demo never needs a real model.
  const demoAgent = createScriptedAgent((input) =>
    String(input.metadata?.role) === 'reviewer'
      ? [{ type: 'text_delta', delta: 'APPROVE — looks complete.' }]
      : [{ type: 'text_delta', delta: `Worked on: ${input.prompt.split('\n')[0]?.slice(0, 60)}` }],
  );
  const runtime = createAgentRuntime({
    executors: { demo: demoAgent },
    fallbackToBuiltin: true,
    ...(options.detection ? { detection: options.detection } : {}),
  });

  // 1. Detect agents.
  write('1. Detecting local agents…');
  const agents = await runtime.detect(options.detection);
  for (const a of agents) {
    write(`   ${a.available ? '●' : '○'} ${a.id}${a.version ? ` (${a.version.split(' ')[0]})` : ''}`);
  }

  // 2. Scan the project codegraph.
  write('2. Scanning codegraph…');
  const codegraph = await CodeGraph.scan({ root: cwd });
  const stats = codegraph.stats();
  write(`   ${stats.files} files, ${stats.symbols} symbols, ${stats.internalEdges} internal edges`);

  // 3. Orchestrate a task (offline via the scripted agent).
  write('3. Orchestrating a task…');
  const orchestrator = new Orchestrator({
    runtime,
    policy: createModelPolicy('custom', { custom: { default: { agentId: 'demo' } } }),
    store: new MemoryRunStore(),
    codegraph,
    ...(options.detection ? { detectionOptions: options.detection } : {}),
  });
  const handle = orchestrator.start({
    prompt: [
      'Improve the parser module:',
      '- add input validation',
      '- write unit tests',
      '- document the public API',
    ].join('\n'),
    cwd,
  });
  for await (const event of handle.events) {
    const line = describeEvent(event);
    if (line) write(line);
  }
  const result = await handle.result;

  // 4. Inspect knowledge.
  write('4. Knowledge:');
  write(`   wiki entries: ${result.wiki.entries.length}`);
  write(`   codegraph files: ${codegraph.size}`);

  return {
    agents: agents.length,
    available: agents.filter((a) => a.available).length,
    codegraphFiles: codegraph.size,
    codegraphSymbols: stats.symbols,
    runStatus: result.status,
    taskCount: result.plan.tasks.length,
    succeededTasks: result.plan.tasks.filter((t) => t.status === 'succeeded').length,
    wikiEntries: result.wiki.entries.length,
  };
}

// Executed directly (pnpm start) rather than imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  runDemo().then(
    (result) => {
      console.log('\nDemo result:', JSON.stringify(result, null, 2));
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
