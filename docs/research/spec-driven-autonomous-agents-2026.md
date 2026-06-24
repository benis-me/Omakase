# Spec-Driven, Long-Running Autonomous Multi-Agent Systems — Research Report (2025–2026)

> Intellectual foundation for an orchestration engine driving long-running, autonomous, spec-driven multi-agent coding/task systems in a desktop app. Every load-bearing claim is grounded in a primary source (original blog, official docs, or canonical repo), with URLs inline. Section 6 synthesizes the implementable primitives.

**A one-paragraph thesis up front.** Across every credible 2025–2026 source, the same skeleton recurs. A long-running coding agent is a **loop** (gather context → act → verify → repeat) bounded by **caps**, fed by a **spec** that is the source of truth, kept productive by **context discipline** (the context window is the scarce resource; you manage it by isolating sub-work into fresh contexts and summarizing the main thread), made durable by **checkpoint/resume** over external state (files + git + a session log), gated on **ground-truth verification** (tests/build/lint, not "looks done"), and — when work is genuinely parallelizable — fanned out **orchestrator-worker** with isolated worker contexts that return only summaries. The genuine open disagreement in the field is *how much* to parallelize: Anthropic's research system embraces fan-out (eyes-open to a ~15× token cost), while Cognition argues for a single-threaded linear agent and reserves parallelism for read-only retrieval.

---

## 1. The Ralph Loop / "Ralph Wiggum" Technique

### Core idea
Created by **Geoffrey Huntley**, named after the simple, persistent, forgetful Simpsons character as a metaphor for how LLM agents behave. The canonical definition, verbatim from `ghuntley.com/ralph/`:

> "Ralph is a technique. In its purest form, Ralph is a Bash loop."

The load-bearing philosophical claim:

> "That's the beauty of Ralph — the technique is deterministically bad in an undeterministic world."

The interpretation, consistent across sources: it is better to **fail predictably than to succeed unpredictably**. Because each failure is deterministic and observable, you fix it by tuning the prompt/spec ("tuned — like a guitar") rather than babysitting the agent. The human's job is to **"sit on the loop, not in it."**

### Concrete mechanics

**The loop is literally a shell loop.** The canonical one-liner (verbatim, `ghuntley.com/ralph/`):
```bash
while :; do cat PROMPT.md | claude-code ; done
```
The agent is interchangeable (Huntley's own variant pointed at Amp: `... | npx --yes @sourcegraph/amp`). An elaborated orchestration script in `github.com/ghuntley/how-to-ralph-wiggum` adds plan/build modes, an iteration cap, and an auto-push:
```bash
ITERATION=0
while true; do
    if [ $MAX_ITERATIONS -gt 0 ] && [ $ITERATION -ge $MAX_ITERATIONS ]; then break; fi
    cat "$PROMPT_FILE" | claude -p \
        --dangerously-skip-permissions \
        --output-format=stream-json --model opus --verbose
    git push origin "$CURRENT_BRANCH"
    ITERATION=$((ITERATION + 1))
done
```
Note `--dangerously-skip-permissions`: Ralph runs fully autonomously (auto-approves every tool call), so **the sandbox is the only security boundary**.

**Files are the memory, not the context window.** This is the central insight. Each iteration starts with a **fresh context window**, reads current repo state from disk, and continues. Persistent state lives in files:
- `PROMPT.md` — the instruction fed every iteration (stable input).
- `@fix_plan.md` / `IMPLEMENTATION_PLAN.md` — a prioritized to-do list, updated each loop; **disposable** — delete and regenerate when it accumulates cruft.
- `@AGENT.md` / `AGENTS.md` — short operational guide (build/test/run, conventions; Huntley keeps it ~60 lines).
- `specs/*.md` — one topic per file; the declarative spec the repo converges toward. Huntley: *"My institutional knowledge is in the specifications file."*

**Context discipline.** Huntley works against a tight budget — *"only have approximately 170k of context window to work with"* — so *"it's essential to use as little of it as possible."* The most-repeated rule, verbatim:

> "one item per loop. I need to repeat myself here—one item per loop."

This keeps each fresh context lean and keeps a single task in the model's "smart zone." Third-party measurement (ZeroSync) reports quality degrading around **147k–152k tokens** ("context clipping"), and that prompt bloat hurts (a 1,500-word prompt was "slower and dumber" than a ~103-word one).

**Stopping conditions.** In the pure bash form **there is no automatic completion signal** — the loop is infinite. It stops by: manual `Ctrl+C` (Huntley: "I checked in after 6 hours and it claimed to be finished, so I stopped it"); an iteration cap (`MAX_ITERATIONS`); or plan exhaustion. Productized harnesses add an explicit done-signal: the agent emits a sentinel (e.g. `<promise>COMPLETE</promise>`) **only when objective external verification passes** (tests / PRD checks). The principle: stop on *objective criteria*, not the LLM's self-assessment.

**Parallelism.** Huntley's primary loop is deliberately **monolithic** — `ghuntley.com/loop/`: *"Ralph is monolithic. Ralph works autonomously in a single repository as a single process,"* with an explicit warning against multi-agent complexity. Parallelism is pushed *down into subagents within one iteration*, not out into many top-level agents:
- **Fan out read-only work** (search, file reads, spec study) across many cheaper (e.g. Sonnet) subagents to keep the primary context lean — prompts say things like "study specs/* with up to 250/500 parallel Sonnet subagents."
- **Backpressure rule:** "only 1 subagent for build/tests" — serialize the expensive, side-effecting step so parallel builds don't thrash.
- "Running multiple Ralphs" in practice = one Ralph **per repo/branch**, merging small iterations over time, *not* many agents sharing state. HumanLayer's guidance for existing codebases: run Ralph "ONCE on a cron overnight, and merge small iterations over time," because "the easier alternative to 'merge/rebase' is just to re-run the ralph loop on the fresh code with the same prompt."

### Known failure modes & mitigations
| Failure mode | Mitigation |
|---|---|
| Context rot / clipping (~147–152k tokens) | Fresh context every iteration; one task per loop; offload reads to subagents |
| False "not implemented" assumption (rebuilds existing code) | Prompt: *"Before making changes search codebase (don't assume not implemented) using subagents"* |
| Placeholder/stub implementations (chases the reward signal) | Prompt: *"DO NOT IMPLEMENT PLACEHOLDER OR SIMPLE IMPLEMENTATIONS. WE WANT FULL IMPLEMENTATIONS."* |
| Cruft accumulation / spinning | Delete & regenerate `fix_plan.md` ("Plan is disposable"); rely on git history as ground truth; add test backpressure |
| Self-termination when stuck (an agent ran `pkill` on itself) | Sandbox isolation; iteration caps |
| No automatic drift detection (impl silently diverges from specs) | Active human monitoring — "sit on the loop, not in it" (no automated detector exists yet) |
| Bad specs → bad output | Invest in spec quality up front; one spec per file |
| Wrong tool for the job | *"if you are iterating/exploring, you probably don't want ralph in the first place"* — use Ralph only when end state and test method are known |

### The "ralph-loop" Claude Code plugin (exact mechanics)
Two copies of the **same official Anthropic plugin** exist: the installable **`ralph-loop`** (author Anthropic, in the official marketplace, ~184k installs reported) and a readable development copy named **`ralph-wiggum`** in `anthropics/claude-code/plugins/ralph-wiggum/`. Marketplace description, verbatim:

> "Interactive self-referential AI loops for iterative development, implementing the Ralph Wiggum technique. Claude works on the same task repeatedly, seeing its previous work, until completion."

**Commands:** `/ralph-loop PROMPT [--max-iterations N] [--completion-promise TEXT]`, `/cancel-ralph`, `/help`.

**The key technical difference from Huntley's version: it runs in ONE session via a Stop hook, not an external loop.** Mechanism:
1. `/ralph-loop` writes state to `.claude/ralph-loop.local.md` (YAML frontmatter: `active`, `iteration`, `max_iterations`, `completion_promise`, `started_at` + the prompt body).
2. Claude works, then tries to end its turn. The **Stop hook intercepts the exit**.
3. The hook checks the iteration counter; if `max_iterations` reached → delete state, allow stop. Else look for the completion sentinel in the last message (`<promise>...</promise>`); if it *exactly equals* `completion_promise` → allow stop. Otherwise increment and **block the stop**, emitting `{"decision":"block","reason":"<the original prompt re-injected>"}` — so Claude resumes the same task, now seeing its prior work in files + git.

**Safety:** completion uses **exact string matching**; `--max-iterations` is the recommended primary cap (default unlimited — the setup script warns *"This loop cannot be stopped manually! It will run infinitely unless you set --max-iterations or --completion-promise."*); `/cancel-ralph` is the manual escape hatch (deletes the state file). Anti-cheat is baked into the prompt: *"you may ONLY output it when the statement is completely and unequivocally TRUE. Do not output false promises to escape the loop, even if you think you're stuck."*

> **Important architectural distinction:** Huntley's `while`-loop restart gives a **clean context every iteration** (the load-bearing idea — the filesystem is the memory). The Anthropic plugin inverts this: it stays **in-session** with a Stop hook, trading clean-context restart for continuity (and the context accumulation that comes with it). Michael Arnaldi (quoted by ZeroSync): *"If you're implementing Ralph as part of the agent harness via skill/command/etc you are missing the point of Ralph which is to use always a fresh context."*

### Real-project data
- **CURSED** (Huntley's flagship proof): an esoteric programming language not in any LLM's training data, authored + programmed by Ralph running unattended for **~3 months** (`ghuntley.com/cursed/`).
- **ZeroSync** (YC hackathon, most concrete data): 6 repos overnight, **~1,100 commits, ~$800 total (~$10.50/hr per Sonnet agent)**, ~90% automated / ~10% human cleanup (`zerosync.co/blog/ralph-loop-technical-deep-dive`).
- **snarktank/ralph**: the clearest PRD-driven harness — runs *until all PRD items complete*, tracked in `prd.json` (each story has a `passes` boolean), memory = git history + `progress.txt` + `prd.json`, emits `<promise>COMPLETE</promise>` when all pass.

### Sources
- https://ghuntley.com/ralph/ · https://ghuntley.com/loop/ · https://ghuntley.com/cursed/
- https://github.com/ghuntley/how-to-ralph-wiggum
- https://github.com/anthropics/claude-code/blob/main/plugins/ralph-wiggum/README.md (+ `scripts/setup-ralph-loop.sh`, `hooks/stop-hook.sh`, `commands/{ralph-loop,cancel-ralph,help}.md`)
- https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json · https://claude.com/plugins/ralph-loop
- https://www.humanlayer.dev/blog/brief-history-of-ralph · https://www.zerosync.co/blog/ralph-loop-technical-deep-dive · https://github.com/snarktank/ralph · https://blog.codacy.com/what-everyone-gets-wrong-about-the-ralph-loop

### Design takeaways
1. **Make "fresh context per iteration" a first-class run mode.** The most robust long-horizon behavior in the wild comes from *reloading the spec from disk each loop* rather than accumulating a giant conversation. Your engine should support both a clean-restart loop (Huntley) and an in-session continuation loop (the plugin) — and default risky/long runs to clean-restart.
2. **Externalize all durable state to files the agent reads back: `PROMPT.md` (spec), a disposable prioritized plan, a progress log, and git history.** Treat the plan as regenerable, not sacred.
3. **A loop with no objective stop condition is a footgun.** Always require *at least one* of {iteration cap, completion-promise tied to a passing external check, wall-clock cap}. Verify completion against tests/PRD state, never the model's "I'm done."

---

## 2. Anthropic / Claude Agent-Orchestration Primitives (2024–2026)

### "Building Effective Agents" (Dec 2024) — the canonical taxonomy
Source: https://www.anthropic.com/engineering/building-effective-agents

The foundational distinction: **Workflows** are *"systems where LLMs and tools are orchestrated through predefined code paths"*; **Agents** are *"systems where LLMs dynamically direct their own processes and tool usage."* The basic unit is the **Augmented LLM** (LLM + retrieval + tools + memory).

The five workflow patterns (verbatim definitions):
1. **Prompt chaining** — *"Decomposes a task into a sequence of steps, where each LLM call processes the output of the previous one,"* with optional programmatic "gate" checks. Use when the task cleanly decomposes into fixed subtasks.
2. **Routing** — *"classifies an input and directs it to a specialized followup task."*
3. **Parallelization** — two variants: **Sectioning** (*"Breaking a task into independent subtasks run in parallel"*) and **Voting** (*"Running the same task multiple times to get diverse outputs"*).
4. **Orchestrator-workers** — *"a central LLM dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes their results."* Key difference from parallelization: *"subtasks aren't pre-defined, but determined by the orchestrator."* (Coding is the canonical dynamic case.)
5. **Evaluator-optimizer** — *"one LLM call generates a response while another provides evaluation and feedback in a loop."*

The **autonomous agent loop**: agents *"gain 'ground truth' from the environment at each step (such as tool call results or code execution) to assess its progress,"* with *"stopping conditions (such as a maximum number of iterations)."* Three implementation principles: **simplicity**, **transparency** (show the planning steps), and a well-crafted **agent-computer interface (ACI)** (*"invest just as much effort in creating good agent-computer interfaces"* as human interfaces).

### The Claude Agent SDK (renamed from "Claude Code SDK", Sept 29 2025)
Sources: https://claude.com/blog/building-agents-with-the-claude-agent-sdk · https://code.claude.com/docs/en/agent-sdk/overview

*"The Agent SDK gives you the same tools, agent loop, and context management that power Claude Code, programmable in Python and TypeScript."* Entry point: `query()` with `prompt` + `options`. Unlike the lower-level Client SDK ("you implement the tool loop"), here *"Claude handles tools autonomously."*

**The agent loop: `gather context → take action → verify work → repeat`.** Under each phase:
- **Gather context:** agentic search (grep/tail; *"the folder and file structure of an agent becomes a form of context engineering"*), semantic search/RAG (recommended *after* agentic search), **subagents** (parallelization + context isolation), **compaction** (*"automatically summarizes previous messages when the context limit approaches"*).
- **Take action:** tools (the *"primary building blocks of execution"*), bash/scripts, code generation (*"precise, composable, and infinitely reusable"*), **MCP** (standardized external integrations).
- **Verify work:** rules-based feedback (*"The best form of feedback is providing clearly defined rules for an output"*), visual feedback (screenshots), **LLM as judge** (*"have another language model 'judge' the output of your agent based on fuzzy rules"*).

**Named primitives** (docs): built-in tools (Read, Write, Edit, Bash, **Monitor**, Glob, Grep, WebSearch, WebFetch, AskUserQuestion); **hooks** (`PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`); **subagents** via the `agents` param (`AgentDefinition`); **MCP** servers; **permissions** (`allowedTools`/`disallowedTools`, `canUseTool` callback, `permission_mode`); **sessions** (capture `session_id`, `resume`, `fork`); Claude Code filesystem features (**Skills**, **Commands**, **Memory** = `CLAUDE.md`, **Plugins**). It also distinguishes the **Agent SDK** (runs in your process, JSONL session state on your filesystem) from **Managed Agents** (hosted REST API; Anthropic runs the agent + a sandbox per session; *"Best for ... long-running and asynchronous sessions"*).

### Subagents in Claude Code
Source: https://code.claude.com/docs/en/sub-agents

*"Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions."* A non-fork subagent *"starts with a fresh, isolated context window. It does not see your conversation history."* Defined as **YAML frontmatter + Markdown body** (body = system prompt); required fields only `name` + `description`; optional `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `memory`, `background`, `isolation`, etc. Delegation is automatic by description match; *"include phrases like 'use proactively'"* to encourage it. Built-ins: **Explore** (Haiku, read-only), **Plan** (read-only), **general-purpose**. Notable runtime details: the Task tool was **renamed `Agent`** (v2.1.63); subagents can **nest** (depth capped at 5); **forks** inherit the full conversation + prompt cache; subagent transcripts persist separately (`.../subagents/agent-{id}.jsonl`) and **survive main-conversation compaction**; per-subagent **persistent memory** (`memory: user|project|local` → `MEMORY.md` injected). The handoff channel is narrow: *"The only channel from parent to subagent is the Agent tool's prompt string."*

### "How we built our multi-agent research system" (June 2025)
Source: https://www.anthropic.com/engineering/multi-agent-research-system

**Architecture — orchestrator-worker:** a **LeadResearcher** *"analyzes the query, develops a strategy, and saves its plan to Memory to persist the context"* (context can exceed **200,000 tokens**; truncation would lose the plan), spawns parallel **subagents** (each with *"an objective, an output format, guidance on the tools and sources to use, and clear task boundaries"*), then synthesizes. A separate **CitationAgent** attributes claims.

**Concrete numbers (verbatim):** *"agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats"*; *"Token usage by itself explains 80% of the variance"* (three factors — tokens, tool calls, model — explain **95%**); the multi-agent system *"outperformed single-agent Claude Opus 4 by 90.2%"*; *"the lead agent spins up 3-5 subagents in parallel"* and *"subagents use 3+ tools in parallel,"* cutting research time *"by up to 90%."* Effort scaling: simple = 1 agent/3-10 calls; comparison = 2-4 subagents; complex = 10+. The critical coding caveat: *"most coding tasks involve fewer truly parallelizable tasks than research."* Evaluation: start with ~20 representative queries, use an **LLM-as-judge** rubric (factual accuracy, citation accuracy, completeness, source quality, tool efficiency) scored 0.0–1.0, and *"evaluate whether it achieved the correct final state"* (end-state, not every step).

### "Effective context engineering for AI agents" (Sept 2025)
Source: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

Definition: *"the set of strategies for curating and maintaining the optimal set of tokens (information) during LLM inference."* Guiding principle: *"finding the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome."* Two scarcity facts: **context rot** (*"As the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases"*) and an **attention budget** (*"Every new token introduced depletes this budget"*).

The three long-horizon techniques:
1. **Compaction** — *"taking a conversation nearing the context window limit, summarizing its contents, and reinitiating a new context window with the summary."*
2. **Structured note-taking (agentic memory)** — *"the agent regularly writes notes persisted to memory outside of the context window [that] get pulled back into the context window at later times."*
3. **Sub-agent architectures** — *"specialized sub-agents can handle focused tasks with clean context windows,"* each returning *"a condensed, distilled summary of its work (often 1,000-2,000 tokens)."*

Plus **just-in-time retrieval** (agents *"maintain lightweight identifiers (file paths, stored queries, web links)"* and load data at runtime) and the **"right altitude"** principle for system prompts (*"specific enough to guide behavior effectively, yet flexible enough to provide ... strong heuristics"*).

### Agent Skills, Checkpoints, and Dynamic Workflows (late 2025 / 2026)
**Agent Skills** (Oct 16 2025; open standard Dec 18 2025) — *"organized folders of instructions, scripts, and resources that agents can discover and load dynamically."* Core file `SKILL.md` (YAML `name` + `description`). **Progressive disclosure**: metadata → SKILL.md body → bundled files, loaded only as needed. Skills can include executable code Claude runs *"as tools at its discretion."* Sources: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills · https://claude.com/blog/skills

**Checkpoints + autonomy** (Sept 29 2025) — *"automatically saves your code state before each change"*; rewind via *"Esc twice or ... the /rewind command"* (restore *"the code, the conversation, or both"*; tracks Claude's edits only, *not a replacement for git*). Plus subagents, hooks (*"running your test suite after code changes"*), and **background tasks** (*"keep long-running processes like dev servers active without blocking"*). Source: https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously

**Dynamic Workflows** (the headline 2026 feature, May 2026) — *"a JavaScript script that orchestrates subagents at scale. Claude writes the script for the task you describe, and a runtime executes it in the background while your session stays responsive."* The architectural move: *the plan moves into code.* With subagents, *"every result lands in a context window,"* whereas *"A workflow script holds the loop, the branching, and the intermediate results itself, so Claude's context holds only the final answer"* (intermediate results live in script variables). **Limits (verbatim):** *"Up to 16 concurrent agents"*, *"1,000 agents total per run"* (*"Prevents runaway loops"*), no mid-run user input. Invoked via the `Workflow` tool / `ultracode` keyword / `/effort ultracode`; requires Claude Code v2.1.154+. A bundled `/deep-research` workflow ships in-box (*"fans out web searches ... votes on each claim ... returns a cited report with claims that didn't survive cross-checking filtered out"*). Headline result: Jarred Sumner ported Bun's *"750,000 lines of Rust"* in *"eleven days"* with *"hundreds of agents working in parallel with two reviewers on each file."* The docs distinguish four scaling primitives: **Subagents** (a few tasks/turn, Claude orchestrates), **Skills** (instructions), **Agent teams** (a lead supervising peer sessions via a shared task list), **Workflows** (a script the runtime executes, dozens–hundreds of agents). Sources: https://code.claude.com/docs/en/workflows · https://claude.com/blog/introducing-dynamic-workflows-in-claude-code

### Long-running / durable execution
Source: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (Nov 2025)

The framing: *"Imagine a software project staffed by engineers working in shifts, where each new engineer arrives with no memory of what happened on the previous shift."* Compaction alone is insufficient. **State persistence across long runs uses three mechanisms:** a `claude-progress.txt` activity log; **git history** with descriptive commits (also the recovery path — agents use git *"to revert bad code changes and recover working states"*); and a structured `feature_list.json` for task status. The **two-agent harness**: an **initializer** runs once (creates `init.sh`, the progress file, an initial commit); subsequent **coding-agent** sessions run `pwd`, read git logs + progress, pick the next incomplete feature, work on **one feature at a time**, and self-verify (*"Only mark features as 'passing' after careful testing"*) using browser automation. A noted failure mode: *"Claude tended to mark a feature as complete without proper testing"* until forced to use test automation. Other durable mechanisms: SDK **sessions/resume** (`resume: sessionId`, JSONL on disk), **subagent resume** (survives compaction), **Managed Agents** (hosted, for async/long-running).

### Design takeaways
1. **Steal the agent loop and the four scaling tiers wholesale.** `gather → act → verify → repeat` is the run-step contract; expose all four orchestration tiers (single agent, a few subagents, agent-team-with-shared-task-list, and a workflow-as-script) and let the spec's complexity pick the tier — but default coding to the lower tiers.
2. **Context engineering is your real budget management.** Build in compaction (summarize-and-restart at a threshold), structured note-taking to external files, and sub-agent context isolation that returns only ~1–2k-token summaries. Surface the live token/attention budget in the UI.
3. **For multi-hour runs, copy the long-running-harness pattern verbatim:** an initializer that scaffolds `progress.txt` + an initial commit, then stateless coding sessions that reconstruct state from git + progress, do one feature at a time, and only mark "passing" after a real test runs.

---

## 3. Loop Engineering & Named Long-Running Systems

The organizing fact (Claude Code docs): *"The context window is the most important resource to manage ... performance degrades as it fills."* Every technique below spends a finite token budget well over a long horizon.

### General techniques

**Context compaction / summarization** — *"taking a conversation nearing the context window limit, summarizing its contents, and reinitiating a new context window with the summary"* (Anthropic). Claude Code continues *"with this compressed context plus the five most recently accessed files"*; API edit type `compact_20260112` (default trigger 150K input tokens). Implementations: Claude Code `/compact`; **OpenHands Condenser** (drops events, replaces with summaries, stored as a `CondensationEvent`; default `LLMSummarizingCondenser` *"reduce[s] API costs by up to 2× with no degradation"*); **Cline Auto Compact** (+ rule-based truncation at `maxAllowedSize = max(contextWindow - 40_000, contextWindow * 0.8)`); **Roo Intelligent Context Condensing**; **Amp** thread compaction. Risk: *"Overly aggressive compaction can result in the loss of subtle but critical context."*

**Memory files / external memory** — *"the agent regularly writes notes persisted to memory outside of the context window"* (Anthropic). Three flavors: (a) the **Claude memory tool** (`memory_20250818`, client-side, `/memories` dir, system prompt *"ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any progress that is not recorded in your memory directory"*); (b) **project guidance files** (`AGENTS.md` — *"a README for agents,"* now a cross-vendor standard; `CLAUDE.md` — *"Bloated CLAUDE.md files cause Claude to ignore your actual instructions!"*); (c) system-specific: **Cline Memory Bank** (six mandatory files: `projectbrief.md`, `productContext.md`, `activeContext.md`, `systemPatterns.md`, `techContext.md`, `progress.md` — *"After every memory reset, I begin completely fresh. The Memory Bank is my only link to previous work"*), **Devin Knowledge + DeepWiki** (auto-indexed repo wikis), **OpenHands microagents → Skills**.

**Todo / task tracking** — an explicit checklist re-anchored in recent context to fight goal drift. Claude Code: originally **TodoWrite** (`{content, status, activeForm}`); now structured **Task tools** (`TaskCreate/Update/Get/List`) with **dependency tracking** (`addBlockedBy`, `addBlocks`, `owner`) and filesystem persistence.

**Verification loops & self-correction** — *"gather context → take action → verify work → repeat."* Claude Code: *"Give Claude a check it can run: tests, a build, a screenshot to compare. It's the difference between a session you watch and one you walk away from ... Give Claude something that produces a pass or fail, and the loop closes on its own."* And: *"Have Claude show evidence rather than asserting success."* The purest built-in example is **SWE-agent's edit linter**: *"Invalid edits are discarded, and the agent is asked to try editing the file again"* (verification fused into the tool; removing it drops SWE-bench Lite 18.0% → 15.0%). Aider does the same via **reflection** on non-applying edits.

**Adversarial verification / critic / LLM-as-judge** — a *different* model in a *fresh* context grades the work. Claude Code's *"adversarial review step"*: *"A reviewer running in a fresh subagent context sees only the diff and the criteria ... not the reasoning that produced the change."* Calibration caveat: *"A reviewer prompted to find gaps will usually report some, even when the work is sound ... Tell the reviewer to flag only gaps that affect correctness."* **Amp's oracle** is the strongest productized version: a deliberately more powerful read-only model (GPT-5 family) in its own context for *"reviewing, ... debugging, ... figuring out what to do next."*

**Sub-agent delegation (orchestrator-worker)** — *"a lead agent coordinates the process while delegating to specialized subagents that operate in parallel,"* each returning *"a condensed, distilled summary (often 1,000-2,000 tokens)."* The same shape recurs everywhere: **OpenHands** `AgentDelegateAction`, **Roo** Boomerang/Orchestrator (`new_task`; *"Each subtask operates in complete isolation ... The parent task resumes with only the summary"*), **Amp** subagents, **Cline** `/newtask`, **Claude Code** agent teams, **Factory** orchestrator + Custom Droids, **Goose** subrecipes. The dissenting primary source — **Cognition's "Don't Build Multi-Agents"**: *"Share context, and share full agent traces, not just individual messages"* and *"Actions carry implicit decisions, and conflicting decisions carry bad results"* → default to *"a single-threaded linear agent"* (since softened to allow parallel *read* subagents, writes single-threaded).

**Checkpointing / resume** — two architectures: (a) **shadow-git** (Cline & Roo: *"a shadow Git repository separate from your project's actual Git history"*, commit after each tool use / before edits, restore files/task/both; *"capture everything, including files not tracked by Git"*); (b) **session-log resume** (Claude Code `--continue`/`--resume`, `/rewind`; the managed-agents pattern decouples *"the 'brain' ... from both the 'hands' ... and the 'session'"* so a dead container can `wake(sessionId)` and *"resume from the last event"*). Plus **VM snapshots** (Devin: *"Every Devin session starts by booting a fresh copy of a snapshot"*) and **persistent threads** (Amp; forkable).

**Budget / iteration caps** — Agent SDK `maxTurns`; the SWE-bench loop bounded by *"200k context length"*; the Stop-hook cap (*"ends the turn after 8 consecutive blocks"*); permission scoping as an action budget; Codex Auto/Read-only/Full-Access modes; Devin **ACUs** (*"reflects the amount of agent effort"* — note: the "~15 min/ACU" mapping is **not** in current docs; treat as legacy).

### Named systems (one line of architecture each)
- **SWE-agent** (Princeton, arXiv:2405.15793) — software competence as *interface design*: the **Agent-Computer Interface (ACI)** with tuned search (filenames only), a 100-line file viewer, and an edit linter that discards invalid edits. 12.47% SWE-bench full, 18.00% Lite.
- **OpenHands** (formerly OpenDevin, arXiv:2407.16741) — the agent as a pure function over an **append-only event stream** (Stateless, Event-Driven, Interruptible; deterministic replay). Action space = **CodeAct** (executable Python/bash/browser instead of bespoke JSON tools, *"up to 20% higher success rate"*). Docker-sandboxed runtime; **Condenser** for context; `AgentDelegateAction` for delegation.
- **Devin** (Cognition) — a single autonomous engineer in its own cloud VM, plan-first (**Interactive Planning**; default *"wait thirty seconds for feedback ... before automatically proceeding"*), **machine snapshots**, **DeepWiki** + **Knowledge** + **Playbooks**, **ACU** metering, explicitly **single-threaded**.
- **Aider** — terminal pair-programmer with a tree-sitter **repo map** ranked **PageRank-style** and token-budgeted (`--map-tokens`, default 1k), edits applied as **search/replace blocks** auto-committed to git, **reflection** on failed edits. **Architect mode**: *"An Architect model ... describe[s] how to solve the coding problem. An Editor model ... produce[s] specific code editing instructions"* (o1-preview architect + editor = 85.0%).
- **Cline / Roo** — **Plan vs Act** modes (Cline; *"Plan mode lets you explore ... without changing files. Act mode executes"*); Roo's **Modes** (Code/Ask/Architect/Debug/Orchestrator) + Boomerang subtask isolation; both with **shadow-git checkpoints** and context condensing.
- **Amp** (Sourcegraph) — three context-isolation primitives: **subagents** (return only a final summary), the **oracle** (read-only second-opinion model), persistent forkable **threads**. *"Use one thread per task."*
- **Others:** **Claude Code** (the reference implementation for most of the above), **OpenAI Codex CLI** (Auto/Read-only/Full-Access + 32KiB AGENTS.md), **Goose** (Rust, MCP "extensions", "recipes"/subrecipes), **Factory.ai Droids** (*"Missions over multi-day horizons,"* orchestrator/worker droids).

### Sources
Anthropic: /engineering/{effective-context-engineering-for-ai-agents, multi-agent-research-system, effective-harnesses-for-long-running-agents, writing-tools-for-agents, swe-bench-sonnet} · code.claude.com/docs/en/{best-practices, sub-agents, agent-sdk/todo-tracking} · platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool. SWE-agent: arxiv.org/abs/2405.15793 · swe-agent.com/latest/background/aci/. OpenHands: arxiv.org/pdf/2407.16741 · docs.openhands.dev/sdk/arch/{agent,events,condenser} · arxiv.org/abs/2402.01030 (CodeAct). Devin: cognition.com/blog/dont-build-multi-agents · docs.devin.ai/work-with-devin/{interactive-planning,deepwiki} · docs.devin.ai/product-guides/{knowledge,creating-playbooks,snapshots}. Aider: aider.chat/2024/09/26/architect.html · aider.chat/2023/10/22/repomap.html · aider.chat/docs/usage/modes.html. Cline: docs.cline.bot/features/{plan-and-act,auto-compact} · docs.cline.bot/core-workflows/checkpoints · docs.cline.bot/prompting/cline-memory-bank. Roo: roocodeinc.github.io/Roo-Code/features/{boomerang-tasks,intelligent-context-condensing}. Amp: ampcode.com/manual · ampcode.com/news/oracle. Others: github.com/openai/codex · agents.md · docs.factory.ai.

### Design takeaways
1. **The two universal moves are: (a) isolate sub-work in a fresh context, return only a summary; (b) summarize-or-truncate the main thread when the window fills.** Build both as core engine services, available to any run.
2. **Verification is the line between an attended demo and an unattended product.** Make a runnable check (tests/build/lint/screenshot-diff) a *required field* of a run, route failures back as actionable text, and offer an escalating ladder of gate strictness (in-prompt → goal-recheck-each-turn → Stop-hook block-until-pass → fresh-context critic).
3. **Adopt the AGENTS.md/CLAUDE.md + progress-file + shadow-git triad as your persistence substrate** — it's the de-facto cross-vendor standard, and it doubles as the resume mechanism. Keep these files lean (bloat actively degrades behavior).

---

## 4. Spec-Driven Development with AI Agents

### Core idea
SDD inverts the prompt-and-patch loop: you author a precise, versioned spec that becomes the source of truth, and the agent generates/tests/validates code *from* it. GitHub's framing: *"in spec-driven development, you start with a ... spec. This is a contract for how your code should behave and becomes the source of truth your tools and AI agents use to generate, test, and validate code,"* and the thesis: *"We're moving from 'code is the source of truth' to 'intent is the source of truth.'"* The canonical methodology doc is blunter: *"Specifications don't serve code—code serves specifications ... The specification becomes the primary artifact. Code becomes its expression in a particular language and framework."*

### GitHub Spec Kit (the open, agent-agnostic toolkit)
Sources: https://github.com/github/spec-kit · https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/ · https://raw.githubusercontent.com/github/spec-kit/main/spec-driven.md

**Slash commands** (current `speckit.` namespace; each maps to an "agent skill"):
| Command | Produces / does |
|---|---|
| `/speckit.constitution` | `.specify/memory/constitution.md` — non-negotiable governing principles |
| `/speckit.specify` | `specs/NNN-feature/spec.md` (auto feature numbering + git branch); the *what/why*, no stack |
| `/speckit.clarify` | structured questioning to resolve ambiguities (run before `/plan`) |
| `/speckit.plan` | `plan.md` + `research.md`, `data-model.md`, `quickstart.md`, `contracts/` (the *how* + stack) |
| `/speckit.tasks` | `tasks.md` — ordered, dependency-aware list with `[P]` parallel markers |
| `/speckit.analyze` | cross-artifact consistency & coverage analysis |
| `/speckit.implement` | the agent executes the tasks |
| `/speckit.taskstoissues` | exports tasks as GitHub issues |

(The original Sept-2025 blog named only bare `/specify`, `/plan`, `/tasks`; the prefixed set + `/constitution`/`/clarify`/`/analyze`/`/implement` is the current README.)

**Scaffolded structure:** `.specify/{memory/constitution.md, scripts/bash/*, templates/*}` + `specs/NNN-feature/{spec.md, plan.md, tasks.md, research.md, data-model.md, quickstart.md, contracts/}`. The **constitution** defines *"the architectural DNA of the system"* via nine articles (e.g. Article I library-first, Article III test-first: *"No implementation code shall be written before ... Tests are confirmed to FAIL"*), enforced by *"Phase -1 Gates."* Ambiguity discipline: the `[NEEDS CLARIFICATION: specific question]` marker *"prevents the LLM from guessing architectural details and forces stakeholders to resolve ambiguities before implementation."* Installs into **30+ agents** (Claude Code, Copilot, Gemini CLI, Cursor, Codex, opencode, Kiro CLI, ...).

### AWS Kiro (the spec-driven IDE)
Sources: https://kiro.dev/docs/specs/ · https://kiro.dev/docs/specs/feature-specs/ · https://kiro.dev/docs/steering/ · https://kiro.dev/docs/hooks/ · https://kiro.dev/blog/introducing-kiro/

Kiro combines *"the flow of vibe coding"* with *"the clarity of specs."* A spec produces **three files** in `.kiro/specs/{feature}/`:
1. **`requirements.md`** — *"uses EARS (Easy Approach to Requirements Syntax) notation to provide structured, testable requirements."*
2. **`design.md`** — *"technical architecture, sequence diagrams ... data flow diagrams, TypeScript interfaces, database schemas, and API endpoints."*
3. **`tasks.md`** — *"a detailed implementation plan with discrete, trackable tasks ... sequenced ... based on dependencies."*

**EARS notation** (the load-bearing format), documented verbatim as **"WHEN [condition/event] THE SYSTEM SHALL [expected behavior]"** with example *"WHEN a user submits a form with invalid data THE SYSTEM SHALL display validation errors next to the relevant fields."* EARS (Alistair Mavin / Rolls-Royce, RE'09; https://alistairmavin.com/ears/) has five patterns: **Ubiquitous** ("The X shall …"), **State-driven** (`WHILE`), **Event-driven** (`WHEN`), **Optional** (`WHERE`), **Unwanted** (`IF … THEN`), plus **Complex** (combined). **Steering files** (`.kiro/steering/`: `product.md`, `tech.md`, `structure.md`) give *"persistent knowledge about your workspace"* with inclusion modes `always` / `fileMatch` / `manual`. **Agent hooks** are *"automated triggers that execute predefined agent prompts ... when specific events occur"* (file save/create/delete, agent turn completion, before/after tool, before/after spec task). Specs are **living documents** — *"Kiro's specs stay synced with your evolving codebase."*

### General mechanics & tracer-bullet slicing
Both leading systems store specs as **plain Markdown in the repo, versioned with git** (diffable/reviewable like code), with a consistent separation: *requirements (what/why)* → *design (how)* → *tasks (the executable checklist)*. The **task line format** in Spec Kit's `tasks.md` is the most precise primitive for turning a spec into agent work:
```
- [ ] [TaskID] [P?] [Story?] Description with file path
```
- `[P]` marks a task *"parallelizable (different files, no dependencies on incomplete tasks)"* — i.e. a worker can pick it up concurrently. Tasks are **not** `[P]` if they touch the same file or depend on incomplete prerequisites.
- **Phase ordering:** Phase 1 Setup → Phase 2 Foundational (blocking prerequisites) → Phase 3+ one phase per user story in priority order (within a story: Tests → Models → Services → Endpoints → Integration, TDD-first) → Final Polish. Independent user-story phases *"may execute in parallel if independent."*

The slicing technique is the **tracer bullet / vertical slice**: *"the thinnest possible end-to-end path through your system that proves every integration boundary works ... one complete path from entry point to persistence and back,"* producing *"production-quality skeleton code rather than a prototype"* — vertical (through all layers) vs horizontal (one layer at a time). Sources: https://www.aihero.dev/tracer-bullets · https://github.com/haveard/spec-kit-tracer · the `to-issues` pattern (splits a spec into independently-grabbable issues as tracer-bullet vertical slices, each tagged HITL vs AFK).

**Other frameworks:** **OpenSpec** (`/opsx:` commands; `proposal.md`/`specs/`/`design.md`/`tasks.md`; https://github.com/Fission-AI/OpenSpec), **BMAD-METHOD** (multi-agent SDLC with named personas + YAML workflow blueprints; https://github.com/bmad-code-org/BMAD-METHOD), **Tessl** (the most aggressive spec-as-source: generated code marked `// GENERATED FROM SPEC - DO NOT EDIT`).

### Design takeaways
1. **Model the spec as a first-class, versioned, multi-file artifact in the repo, not a prompt.** Adopt the three-bucket split (requirements/design/tasks) and store under a conventional path so specs travel with code and diff in PRs. Consider supporting EARS for acceptance criteria (testable, unambiguous) and a "constitution"/steering file for always-loaded project rules.
2. **Make `tasks.md` your literal task queue.** Parse the `[ ] [TaskID] [P] [Story] … file path` format into your DAG: foundational phase serializes the shared substrate, `[P]` tasks and independent stories fan out to parallel workers, and each task names the file(s) it touches (which is also your write-conflict detector).
3. **Enforce ambiguity discipline before implementation.** Bake in a `[NEEDS CLARIFICATION]`-style marker + a clarify gate so a run *blocks on a human* rather than letting the agent guess architecture — the single highest-leverage quality lever in SDD.

---

## 5. Building the Orchestration Engine — Implementable Primitives

The recurring architectural insight: an orchestration engine is the composition of **(1) a durable state spine, (2) a graph/queue of work, (3) control-flow with gates + human checkpoints, (4) parallel fan-out + aggregation, (5) a streaming/observability spine, (6) budget caps.** These are orthogonal; the best systems consolidate several onto one mechanism.

### Durable execution / checkpoint-resume (the spine)
Two families, and the distinction matters for your design:

**Family A — event-sourcing / deterministic replay** (Temporal, Vercel WDK, Inngest, Restate, DBOS). State is *not* snapshotted; the engine journals each completed step's result and, on crash, **re-executes the function from the start, feeding recorded results back** until it catches up. Temporal: *"It starts the Workflow code from the beginning, replays the Event History step by step."* The cost is a **determinism requirement** between steps (Temporal globally; Inngest/Vercel only outside `step.run()`/`'use step'`). The canonical statement (Restate): *"A durable execution engine records each step ... so when something fails, the function resumes from the last completed step instead of restarting from scratch."* Vercel WDK adds zero-compute hibernation (`sleep('7 days')`) and external-event hooks. DBOS does it as a Postgres library (*"one database write per step"*).

**Family B — explicit state snapshot** (LangGraph). A **checkpointer** snapshots full graph state after each super-step, keyed by `(thread_id, checkpoint_id)`. Node contract: `State -> Partial<State>`, merged by per-key **reducers** `(Value, Value) -> Value`. `BaseCheckpointSaver` (`get_tuple`/`list`/`put`/`put_writes`); implementations InMemory/Sqlite/Postgres. **Pending writes** preserve successful nodes when siblings fail. **Resume** = re-invoke with the same `thread_id` and `None` input. **Time travel**: `get_state_history()` → replay (`invoke(None, checkpoint.config)`, nodes before are not re-run) or fork (`update_state(...)` then invoke). Durability modes: `"exit"` < `"async"` < `"sync"`.

> **The real A-vs-B tradeoff:** both re-execute and skip done work; the differences are *what's stored* (event/command journal vs keyed step-output rows / full state) and *determinism granularity*. **Snapshot-style (LangGraph) imposes no determinism constraint on node bodies** (nothing is replayed, only reloaded) — simplest for messy imperative coding logic — at the cost of serializing full state each step. **The step/Activity boundary is the exactly-once boundary**: every irreversible coding action (apply patch, run destructive command, push commit) must sit inside one, because surrounding orchestration is re-executed at-least-once.

### Human-in-the-loop checkpoints
LangGraph is the reference: a node calls `interrupt(payload)` to **pause the whole graph, persist state, surface the payload**; the client resumes via `Command(resume=value)` (which becomes `interrupt()`'s return). *"The first invocation ... raises a `GraphInterrupt` exception, halting execution ... The graph resumes from the start of the node, re-executing all logic"* → **make pre-interrupt side effects idempotent.** Static variants: `interrupt_before`/`interrupt_after`. Durable engines expose HITL as a first-class durable wait surviving crashes at zero compute: Temporal **Signals** + `wait_condition`, Vercel `hook.create/resume`, Inngest `step.waitForEvent(id, {event, timeout, match})`. The most important pattern for a coding agent: **approval-before-tool-call** (`interrupt({"action":"send_email","message":"Approve?"})` then branch).

### Parallel fan-out + aggregation
Two regimes. **Static/known** (sectioning): LangGraph `Send(node, arg)` returned as a list → map-reduce, all branches in one super-step, fan-in via a reducer (`Annotated[list, operator.add]`). **Dynamic/unknown** (orchestrator-workers): the LLM decides worker count at runtime — the right frame for coding (Anthropic: *"subtasks aren't pre-defined, but determined by the orchestrator"*). The uniform merge contract across systems: **workers run in isolated contexts and only their final summary returns.** Aggregation has a cost (summaries *"can consume significant context"*) and an ordering hazard (*"updates from a parallel superstep may not be ordered consistently"*) → the reduce step needs an order-independent merge. And know when *not* to: tightly-coupled, write-conflicting edits stay sequential.

### Verification / quality gates
Five composable gate types, increasing strictness/cost: (1) **programmatic deterministic gate** (tests/build/lint via exit-code-2 or `{"decision":"block","reason":"..."}` — Claude Code hooks: PreToolUse exit 2 *"Blocks the tool call,"* Stop exit 2 *"Prevents Claude from stopping"*); (2) **failure routing** — the failing signal must return as *actionable text*, not a boolean (*"stderr text is fed back to Claude as an error message"*); (3) **loop-back control flow** (LangGraph `should_continue` → `END` or `"reflect"`; CrewAI `guardrail` *"retried up to `guardrail_max_retries` times"*); (4) **LLM-as-judge / second-opinion in a fresh context** (the grader isn't the author); (5) **stop conditions** (every loop needs a cap — *"8 consecutive blocks"*, `recursion_limit`, `guardrail_max_retries`). Academic blueprints: **SWE-bench** binary gate (FAIL_TO_PASS forward-progress + PASS_TO_PASS regression-guard); **Reflexion** (Actor / Evaluator / Self-Reflection converting pass/fail into a verbal lesson re-injected next trial). The mandate (Claude Code): *"If you can't verify it, don't ship it."*

### Live event streaming + observability
Adopt the **OpenTelemetry GenAI span model** internally: an agent run = a tree of spans (`invoke_agent` parents `execute_tool` + `chat`) carrying `gen_ai.*` attributes (`gen_ai.usage.input_tokens`/`output_tokens`, `gen_ai.conversation.id`, `gen_ai.tool.name`, `error.type`) — instant interop with LangSmith/AgentOps/Datadog/Phoenix. **LangSmith** is the reference tree shape: a **run** is a span, a **trace** a collection, a **thread** a sequence; the Run schema (`id`, `trace_id`, `parent_run_id`, `run_type`, `start/end_time`, **`dotted_order`** for tree reconstruction + ordering, `inputs`/`outputs`/`error`, token+cost) is posted at start / patched at end so dashboards fill in live. Transport over **SSE** (`text/event-stream`; `event`/`data`/`id`/`retry`; auto-reconnect via `Last-Event-ID` — critical for a desktop client that drops). Use a **typed envelope** (à la Vercel AI SDK "parts": `text-delta`, `tool-input-delta`, `tool-output-available`, `start-step`/`finish-step`, reconciled by stable `id`) so the UI renders tool cards/reasoning/state, not raw text. Map model stream events 1:1 to UI: Anthropic `message_start` (initial input tokens) → `content_block_delta` (`text_delta`/`input_json_delta`/`thinking_delta`) → cumulative `message_delta` (output tokens, `stop_reason`) → `message_stop`; *"your code should handle unknown event types gracefully."*

### Budget / cost control
Four orthogonal axes; expose all: **iteration/turn caps** (OpenAI `max_turns` → `MaxTurnsExceeded`; LangGraph `recursion_limit` counting super-steps, *"1,000 ... instead of 25"*; CrewAI `max_iter`/`max_rpm`/`max_execution_time`; AutoGen's three distinct counters), **wall-clock timeout**, **rate limit** (distinguish *throttle* = enqueue overflow from *rate-limit* = drop), **token/cost ledger** (Anthropic `usage`: `input_tokens`, `output_tokens`, `cache_creation/read_input_tokens`; pre-flight `count_tokens` is an estimate, *not portable across model generations*). Prefer **graceful finalization** over a hard throw (OpenAI `error_handlers`, LangGraph `RemainingSteps`, CrewAI "best answer"). The cap's main job: bounding runaway-loop blast radius and the ~15× multi-agent token cost.

### Task queue / scheduling
A *run* = a queue of tasks over a dependency DAG. Vocabulary to map onto: sequential-with-data → `chain` / Prefect future-arg; sequential-without-data → Prefect `wait_for` / Airflow `>>`; parallel-independent → Celery `group` / Inngest fan-out / `.map()`; **fan-in / map-reduce → Celery `chord` / LangGraph `Send`-list** (needs durable result collection); worker pool + backpressure → **Temporal pull-based polling** (*"A Worker ... polls for a message only when it has spare capacity"*; **Task Routing/Worker Sessions** pin a task to the worker holding the right checkout — the direct analogue of "run this sub-task in the same workspace as its parent"); concurrency caps with fairness → Inngest `concurrency` + `key` virtual queues (per-repo/per-user).

### Sources
LangGraph: reference.langchain.com/python/langgraph/{checkpoints, types/interrupt, types/Send, graph/state/StateGraph} · docs.langchain.com/oss/python/langgraph/{persistence, durable-execution, interrupts, use-time-travel, streaming, errors/GRAPH_RECURSION_LIMIT}. OpenAI Agents SDK: openai.github.io/openai-agents-python/{running_agents, handoffs, sessions} · github.com/openai/swarm. CrewAI: docs.crewai.com/en/concepts/{agents, tasks, processes, flows, collaboration}. AutoGen/AG2: microsoft.github.io/autogen/0.2/ · docs.ag2.ai/.../handoffs/. Durable execution: docs.temporal.io/{workflows, workflow-definition, task-queue, task-routing} · temporal.io/blog/a-mental-model-for-agentic-ai-applications · vercel.com/docs/workflows/concepts · inngest.com/docs/learn/how-functions-are-executed · docs.dbos.dev/architecture · restate.dev/what-is-durable-execution. Anthropic: /engineering/{multi-agent-research-system, building-effective-agents} · code.claude.com/docs/en/{sub-agents, best-practices, hooks} · platform.claude.com/docs/en/build-with-claude/{streaming, token-counting}. Observability: github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/ · docs.langchain.com/langsmith/{observability-concepts, run-data-format} · docs.agentops.ai/v2/concepts/spans · ai-sdk.dev/docs/ai-sdk-ui/stream-protocol · developer.mozilla.org/.../Server-sent_events. Scheduling: docs.celeryq.dev/.../canvas.html · docs.prefect.io/v3/concepts/task-runners · swebench.com · arxiv.org/abs/2303.11366 (Reflexion).

---

## 6. Synthesis — What Your Orchestration Engine Should Implement

Mapping the research onto concrete primitives for a desktop app driving spec-driven, long-running, multi-agent coding work:

**Core domain objects**
- **Spec** — first-class, versioned, multi-file repo artifact (requirements / design / tasks), with optional EARS acceptance criteria, a `[NEEDS CLARIFICATION]` marker, and a project "constitution"/steering file of always-loaded rules. The source of truth; code is its expression.
- **Task DAG** — parsed from `tasks.md` (`[ ] TaskID [P] [Story] … file path`): a phased dependency graph (Setup → Foundational → per-story → Polish), where `[P]` and independent stories are the parallelism signal and the per-task file path is the write-conflict detector.
- **Run** — a loop instance over a spec/task-DAG, with a step contract of `gather context → act → verify → repeat`, bounded by caps. Support two loop modes: **clean-restart** (Ralph: fresh context each iteration, state reloaded from disk) and **in-session continuation** (Stop-hook style).
- **Agent definition** — a declarative config (system prompt + tool allow/deny + model + permission mode + `maxTurns` + optional persistent memory), à la Claude Code subagents / `AgentDefinition`.

**The six engine subsystems**
1. **Durable state spine** — checkpoint/resume keyed by `(run_id, checkpoint_id)`. Prefer **snapshot-style** for constraint-free imperative logic (full state per step) *plus* event-sourced step boundaries for irreversible actions (the **exactly-once boundary** for apply-patch / destructive-command / git-push). Externalize durable state to **files + git + a `progress.txt`/session-log** (the cross-vendor de-facto standard, which doubles as the resume mechanism and the agent's memory). Offer **time-travel** (replay + fork from any checkpoint) for "rewind and try differently."
2. **Context management** — built-in **compaction** (summarize-and-restart at a token threshold, keeping recent files), **structured note-taking** to external memory files, and **sub-agent context isolation** returning only ~1–2k-token summaries. Surface live token/attention budget in the UI. This *is* your long-horizon productivity lever.
3. **Control flow + gates + HITL** — verification as a *required field* of a run (a runnable check producing pass/fail), an escalating strictness ladder (in-prompt → goal-recheck-each-turn → block-until-pass → fresh-context critic), failure routed back as actionable text, and **HITL approval gates** as a durable pause/persist/resume primitive (idempotent pre-gate side effects; approve-this-diff before risky tool calls).
4. **Parallel fan-out** — orchestrator-worker with isolated worker contexts; static map-reduce (Send-style + order-independent reduce) for known work, dynamic LLM-decided fan-out for discovered work; effort scaled to spec complexity; spawn caps. **Default coding to sequential** (write-conflicting edits don't parallelize cleanly); reserve fan-out for read/research and genuinely independent vertical slices.
5. **Streaming + observability spine** — an internal **OTel-GenAI-shaped span tree** (`invoke_agent` → `execute_tool`/`chat`, with token/cost/error attributes and `parent_run_id` + a `dotted_order`-style key) streamed to the desktop UI over **SSE** with a **typed event envelope** (resumable via `Last-Event-ID`) so the UI renders a live tree of tool cards, reasoning, diffs, and state transitions — and so any run is replayable.
6. **Budget control** — cap every loop on **four axes** (iterations/super-steps, wall-clock, rate, token-cost ledger), prefer graceful finalization over hard throws, and treat the cap primarily as runaway-loop blast-radius containment.

**The one strategic decision to make explicitly: how much to parallelize.** The field genuinely disagrees. Anthropic's research system embraces orchestrator-worker fan-out (worth it when *"the value of the task is high enough to pay for"* ~15× tokens, and when work is truly parallelizable); Cognition argues a single-threaded linear agent is more reliable because *"Actions carry implicit decisions, and conflicting decisions carry bad results,"* reserving parallelism for read-only retrieval. For *coding specifically*, both camps converge: **most coding tasks involve fewer truly parallelizable tasks than research, and writes should stay single-threaded.** Design for sequential-by-default with opt-in fan-out at clean vertical-slice boundaries, full-trace sharing where agents must coordinate, and a hard cap on concurrent agents (Anthropic's own dynamic-workflows ceiling is 16 concurrent / 1,000 total).

---

### Source-reliability caveats carried forward
- A few Ralph-ecosystem pages carry future-dated 2026 timestamps and viral/marketing framing (a "$RALPH memecoin," shorting-Atlassian claims). Treated as non-load-bearing color; every Ralph definition/loop/mechanism here is grounded in Huntley's actual posts and the actual plugin source.
- "1 ACU ≈ 15 minutes" is **not** in current Devin docs (they define ACUs by effort/inference). Legacy/marketing.
- OpenHands **microagents** are being superseded by **Skills** (`.openhands/microagents/` flagged deprecated); the always-on-repo vs keyword-triggered concept carries over.
- The Spec Kit command set evolved: the Sept-2025 blog named only `/specify`/`/plan`/`/tasks`; the `speckit.`-prefixed set is current.
- LangGraph `recursion_limit` default is version-dependent (1000 in ≥1.0.6, 25 in older docs) — read it from config, don't assume.
