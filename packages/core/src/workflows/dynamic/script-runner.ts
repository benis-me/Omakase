import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type {
  DynamicWorkflowHostApi,
  DynamicWorkflowReportInput,
  DynamicWorkflowWikiInput,
  WorkflowScriptRunner,
  WorkflowScriptRunnerInput,
} from './types.js';

export class MemoryWorkflowScriptRunner implements WorkflowScriptRunner {
  constructor(
    private readonly script: (workflow: DynamicWorkflowHostApi) => Promise<void> | void,
  ) {}

  async run(input: WorkflowScriptRunnerInput): Promise<void> {
    await this.script(input.api);
  }
}

type RunnerFrame =
  | { id: string; type: 'phase-start'; input: { name: string } }
  | { id: string; type: 'phase-finish'; input: { phaseId: string; status: 'succeeded' | 'failed' | 'cancelled'; error?: string } }
  | { id: string; type: 'agent'; input: unknown }
  | { id: string; type: 'report'; input: DynamicWorkflowReportInput }
  | { id: string; type: 'wiki'; input: DynamicWorkflowWikiInput }
  | { id: string; type: 'checkpoint'; input: unknown }
  | { id: string; type: 'log'; input: { message: string } }
  | { id: string; type: 'budget'; input: undefined }
  | { id: string; type: 'finish'; input: { status: 'succeeded' | 'failed'; summary?: string } };

export interface BunWorkflowScriptRunnerOptions {
  bunPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class BunWorkflowScriptRunner implements WorkflowScriptRunner {
  private readonly bunPath: string;
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(options: BunWorkflowScriptRunnerOptions = {}) {
    this.bunPath = options.bunPath ?? 'bun';
    this.cwd = options.cwd;
    this.env = options.env;
  }

  async run(input: WorkflowScriptRunnerInput): Promise<void> {
    const runnerPath = await this.writeRunner();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.bunPath, [runnerPath, input.script.path], {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      input.signal?.addEventListener(
        'abort',
        () => {
          child.kill('SIGTERM');
          fail(new Error('Workflow script cancelled'));
        },
        { once: true },
      );

      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', fail);
      child.on('close', (code) => {
        if (settled) return;
        if (code && code !== 0) {
          fail(new Error(stderr.trim() || `Workflow script exited with code ${code}`));
        } else {
          done();
        }
      });

      const rl = createInterface({ input: child.stdout! });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let frame: RunnerFrame;
        try {
          frame = JSON.parse(line) as RunnerFrame;
        } catch (err) {
          child.stdin?.write(`${JSON.stringify({ id: 'unknown', error: String(err) })}\n`);
          return;
        }
        void this.handleFrame(frame, input.api)
          .then((result) => {
            child.stdin?.write(`${JSON.stringify({ id: frame.id, result })}\n`);
          })
          .catch((err) => {
            child.stdin?.write(
              `${JSON.stringify({ id: frame.id, error: err instanceof Error ? err.message : String(err) })}\n`,
            );
          });
      });
    });
  }

  private async handleFrame(frame: RunnerFrame, api: DynamicWorkflowHostApi): Promise<unknown> {
    switch (frame.type) {
      case 'phase-start':
        return await api.beginPhase(frame.input.name);
      case 'phase-finish':
        await api.finishPhase(frame.input.phaseId, frame.input.status, frame.input.error);
        return null;
      case 'agent':
        return await api.agent(frame.input as never);
      case 'report':
        await api.requestReport(frame.input);
        return null;
      case 'wiki':
        await api.updateWiki(frame.input);
        return null;
      case 'checkpoint':
        return await api.checkpoint(frame.input as never);
      case 'log':
        return await api.log(frame.input.message);
      case 'budget':
        return api.budget();
      case 'finish':
        await api.finish(frame.input.status, frame.input.summary);
        return null;
    }
  }

  private async writeRunner(): Promise<string> {
    const dir = await mkdir(path.join(os.tmpdir(), 'omakase-workflow-runner'), { recursive: true }).then(
      () => path.join(os.tmpdir(), 'omakase-workflow-runner'),
    );
    const runnerPath = path.join(dir, 'runner.mjs');
    await writeFile(runnerPath, BUN_RUNNER_SOURCE, 'utf8');
    return runnerPath;
  }
}

const BUN_RUNNER_SOURCE = `
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const hostProcess = process;
const scriptPath = hostProcess.argv[2];
if (!scriptPath) throw new Error("workflow script path is required");

const pending = new Map();
let seq = 0;
const rl = createInterface({ input: hostProcess.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.error) waiter.reject(new Error(msg.error));
  else waiter.resolve(msg.result);
});

globalThis.console = {
  ...console,
  log: (...args) => hostProcess.stderr.write(args.map(String).join(" ") + "\\n"),
};

function send(type, input) {
  const id = "wf-" + (++seq);
  hostProcess.stdout.write(JSON.stringify({ id, type, input }) + "\\n");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

let currentPhase = null;
const workflow = {
  async phase(name, fn) {
    const phase = await send("phase-start", { name });
    const prior = currentPhase;
    currentPhase = phase;
    try {
      const result = await fn(workflow);
      await send("phase-finish", { phaseId: phase.id, status: "succeeded" });
      return result;
    } catch (err) {
      await send("phase-finish", {
        phaseId: phase.id,
        status: "failed",
        error: err && err.message ? err.message : String(err),
      }).catch(() => undefined);
      throw err;
    } finally {
      currentPhase = prior;
    }
  },
  parallel(items) {
    return Promise.all(items.map((item) => typeof item === "function" ? item() : item));
  },
  pipeline(items, ...stages) {
    return Promise.all(items.map(async (item, index) => {
      let value = item;
      for (const stage of stages) value = await stage(value, item, index);
      return value;
    }));
  },
  async loopUntil(fn, options) {
    const opts = options || {};
    const maxRounds = Math.max(1, opts.maxRounds || 10);
    const dry = (v) => !v || (Array.isArray(v) && v.length === 0) || v === 0;
    const results = [];
    for (let round = 0; round < maxRounds; round++) {
      const result = await fn(round);
      results.push(result);
      const stop = opts.until ? await opts.until(result, round) : dry(result);
      if (stop) break;
    }
    return results;
  },
  budget() {
    return send("budget");
  },
  agent(input) {
    return send("agent", input);
  },
  requestReport(input) {
    return send("report", input);
  },
  updateWiki(input) {
    return send("wiki", input);
  },
  checkpoint(input) {
    return send("checkpoint", typeof input === "string" ? { label: input } : input);
  },
  log(message) {
    return send("log", { message: String(message) });
  },
};

try {
  const mod = await import(pathToFileURL(scriptPath).href + "?omakase=" + Date.now());
  if (typeof mod.default !== "function") throw new Error("Workflow script must export a default function");
  for (const name of ["Bun", "require", "Deno"]) {
    try {
      Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true });
    } catch {
      // Some runtime globals are read-only; validation remains the hard gate.
    }
  }
  await mod.default(workflow);
  await send("finish", { status: "succeeded" });
  rl.close();
  hostProcess.exit(0);
} catch (err) {
  const message = err && err.stack ? err.stack : err && err.message ? err.message : String(err);
  await send("finish", { status: "failed", summary: message }).catch(() => undefined);
  hostProcess.stderr.write(message + "\\n");
  rl.close();
  hostProcess.exitCode = 1;
  hostProcess.exit(1);
}
`;
