import { claudeAgentDef } from './claude.js';
import { codexAgentDef } from './codex.js';
import { copilotAgentDef } from './copilot.js';
import { cursorAgentDef } from './cursor-agent.js';
import { geminiAgentDef } from './gemini.js';
import { opencodeAgentDef } from './opencode.js';
import { piAgentDef } from './pi.js';
import { qwenAgentDef } from './qwen.js';
import type { RuntimeAgentDef } from '../types.js';

export {
  claudeAgentDef,
  codexAgentDef,
  copilotAgentDef,
  cursorAgentDef,
  geminiAgentDef,
  opencodeAgentDef,
  piAgentDef,
  qwenAgentDef,
};

/** The built-in adapter definitions, in display order. */
export const BUILTIN_AGENT_DEFS: readonly RuntimeAgentDef[] = Object.freeze([
  claudeAgentDef,
  codexAgentDef,
  piAgentDef,
  geminiAgentDef,
  opencodeAgentDef,
  cursorAgentDef,
  qwenAgentDef,
  copilotAgentDef,
]);
