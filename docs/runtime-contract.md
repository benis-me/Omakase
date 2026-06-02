# Runtime contract

This is the field-by-field reference for teaching Omakase about an agent CLI,
plus the event model adapters map into. Everything here lives in
`@omakase/daemon`.

## `AgentEvent` — the unified event model

Every adapter, regardless of its native protocol, emits this discriminated
union. Consumers (orchestrator, CLI/TUI, tests) only ever see `AgentEvent`.

```ts
type AgentEvent =
  | { type: 'status'; label: AgentStatusLabel; model?: string | null; ttftMs?: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end' }
  | { type: 'tool_use'; id: string | null; name: string | null; input: unknown }
  | { type: 'tool_result'; toolUseId: string | null; content: string; isError: boolean }
  | { type: 'usage'; usage: TokenUsage; costUsd?: number | null; durationMs?: number }
  | { type: 'error'; message: string; raw?: unknown }
  | { type: 'done'; reason: 'completed' | 'cancelled' | 'error' };
```

`createResultAccumulator()` / `collectAgentResult(stream)` fold an event stream
into an `AgentRunResult` (`text`, `thinking`, `toolCalls`, `usage`, `costUsd`,
`status`, `error`, `model`).

## `RuntimeAgentDef` — describing an adapter

```ts
interface RuntimeAgentDef {
  id: string;                  // stable id, e.g. "claude"
  name: string;                // display name
  bin: string;                 // executable searched on PATH
  fallbackBins?: string[];     // alternate names (forks) tried in order
  binEnvVar?: string;          // env var holding an absolute override path, e.g. CLAUDE_BIN
  versionArgs: string[];       // e.g. ["--version"]
  versionProbeTimeoutMs?: number;
  helpArgs?: string[];         // probed once to detect optional flags
  capabilityFlags?: Record<string, string>; // "flag in --help" -> capability key
  capabilities?: RuntimeCapabilityMap;       // static capability hints
  fallbackModels: RuntimeModelOption[];      // shown when live listing fails
  listModels?: { args: string[]; timeoutMs?: number; parse(stdout): RuntimeModelOption[] | null };
  fetchModels?(bin, env, run): Promise<RuntimeModelOption[] | null>; // custom discovery
  reasoningOptions?: RuntimeReasoningOption[];
  buildArgs(prompt, imagePaths, extraAllowedDirs?, options?, context?): string[];
  streamFormat: 'pi-rpc' | 'claude-stream-json' | 'codex-json' | 'plain-text' | string;
  promptViaStdin?: boolean;    // deliver the prompt on stdin (avoids argv limits)
  promptInputFormat?: 'text' | 'stream-json';
  env?: Record<string, string>;
  supportsImagePaths?: boolean;
  maxPromptArgBytes?: number;
  externalMcpInjection?: 'claude-mcp-json' | 'acp-merge' | 'opencode-env-content';
  supportsCustomModel?: boolean;
  auth?: { envVars?: string[]; homeFiles?: string[] }; // heuristic auth signal
  installUrl?: string;
  docsUrl?: string;
}
```

### `buildArgs`
Returns the argv (excluding the binary). The user prompt is delivered
separately on stdin when `promptViaStdin` is set, so most adapters ignore the
`prompt` parameter. `context.capabilities` carries flags discovered during
detection so `buildArgs` can gate options that older CLIs reject (e.g. Claude's
`--include-partial-messages`).

### `streamFormat` and parsing
- `claude-stream-json` / `codex-json` → JSON mappers in `runtime/parsers.ts`.
- `pi-rpc` → the interactive session driver in `runtime/executors/pi-rpc.ts`.
- `plain-text` → each stdout chunk becomes a `text_delta`.

### Auth
`auth.envVars` / `auth.homeFiles` are a lightweight heuristic: if any named env
var is set, or any home-relative file exists, the agent is reported `ok`;
otherwise `missing`. This is intentionally shallow — see the roadmap.

## Detection → `DetectedAgent`

`detectAgents(registry, options)` probes every def concurrently and
**fault-isolated** (one adapter throwing never collapses the list). Each result:

```ts
interface DetectedAgent {
  id; name; bin; streamFormat; promptViaStdin; supportsImagePaths;
  supportsCustomModel; reasoningOptions; externalMcpInjection; installUrl; docsUrl;
  available: boolean;            // resolved + invocable
  path: string | undefined;      // absolute path that will be spawned
  version: string | null;
  models: RuntimeModelOption[];
  modelsSource: 'live' | 'fallback';
  capabilities: RuntimeCapabilityMap;
  authStatus: 'ok' | 'missing' | 'unknown';
  authMessage: string | undefined;
}
```

Resolution order for the binary: `binEnvVar` override → `bin`/`fallbackBins` on
PATH (plus well-known toolchain dirs). The version probe classifies a `126`/`127`
exit or `ENOENT`/`EACCES`/`ENOTDIR` as *not invocable* (so a broken shim is
reported absent), versus *spawned but no version string* (still available).

## Registering a custom adapter

```ts
import { createRegistry, createAgentRuntime, type RuntimeAgentDef } from '@omakase/daemon';

const myAgent: RuntimeAgentDef = {
  id: 'myagent',
  name: 'My Agent',
  bin: 'myagent',
  binEnvVar: 'MYAGENT_BIN',
  versionArgs: ['--version'],
  fallbackModels: [{ id: 'default', label: 'Default (CLI config)' }],
  buildArgs: (_p, _img, _dirs, opts = {}) => (opts.model ? ['--model', opts.model] : []),
  promptViaStdin: true,
  streamFormat: 'plain-text',
  auth: { envVars: ['MYAGENT_API_KEY'] },
};

const registry = createRegistry([myAgent]);          // built-ins + yours
const runtime = createAgentRuntime({ registry });
await runtime.detect();
```

To run a fully in-process agent (no subprocess) — useful for custom roles or
offline behaviour — register an executor instead:

```ts
import { createScriptedAgent } from '@omakase/daemon';
runtime.registerExecutor('myagent', createScriptedAgent((input) => [
  { type: 'text_delta', delta: doWork(input.prompt) },
]));
```

## Running an agent

```ts
// Collected result
const result = await runtime.runAgent({ agentId: 'claude', prompt: 'hello', cwd });

// Or stream events
for await (const event of runtime.streamAgentEvents({ agentId: 'claude', prompt: 'hi' })) {
  // ...
}
```

`AgentRunInput` supports `cwd`, `env`, `model`, `reasoning`, `extraAllowedDirs`,
`imagePaths`, `signal` (AbortSignal), `timeoutMs`, and `metadata`.
