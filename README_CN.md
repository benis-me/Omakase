# Omakase（`omks`）

> 用**动态工作流（Dynamic Workflow）**和**目标循环（Goal‑loop）**，编排你电脑上已经装好的各种 AI Agent CLI —— 直到目标被“可验证地”完成为止。

Omakase 是一个本地优先、可开源的 CLI + TUI，把 `claude`、`codex`、`gemini`、`cursor-agent` 等已安装的 Agent CLI 变成一支可编排的舰队。你给它一个**目标（Goal）**，它就会规划、并行派发多个 Agent、按成功标准**验证**结果，并循环直到达成 —— 同时具备可持久化的**续跑（Resume）**、**重试（Retry）**，以及对全过程的事件溯源记录。

技术栈：**Bun**、**TypeScript**、**React 19**、**OpenTUI**。除终端与浏览器渲染器外，零运行时依赖。

---

## 为什么

每个 Agent CLI 都是一座孤岛。Omakase 是它们之上的编排层：

- **用你已有的工具。** 自动探测已安装的 Agent CLI 并以无头（headless）方式驱动，无需重新配置密钥、不锁定厂商。
- **动态工作流。** 编排即代码 —— 用一套极小的 `w` API（`phase`、`agent`、`parallel`、`pipeline`、`loopUntil`）编写 Bun/TypeScript 文件。它们**可复用、可版本管理、像 Skills 一样被使用**：写得越多，Omakase 越强。
- **目标循环。** 定义成功标准（某命令必须退出码为 0、某文件必须存在、或由 Agent 依据评审准则判定的自然语言标准）。Omakase 会循环——规划 → 构建 → **验证** → 修补——直到达成或触及预算上限。验证器让自主运行保持诚实，而不是自说自话地宣布成功。
- **可持久化。** 每次运行都是 SQLite 中的追加式事件日志。被中断了？`omks resume <id>` 会从缓存重放已完成的工作并续跑。厂商偶发失败？带退避的“Foundation 重试”。
- **多 Harness。** 引擎面向 `Harness` 接口；默认驱动子进程 CLI，未来的 ACP / 进程内 Harness 可无缝接入同一处缝隙。

---

## 安装

需要 **[Bun](https://bun.sh) ≥ 1.3**，以及 `PATH` 中至少一个 Agent CLI（`claude`、`codex`、`gemini` 或 `cursor-agent`）。

```bash
git clone https://github.com/benis-me/Omakase
cd Omakase
bun install
bun link            # 全局暴露 `omks`
```

## 快速开始

```bash
cd my-project
omks init                       # 创建 .omks 工作区
omks doctor                     # 检查 provider 与工作流

# 无头运行一个目标，实时流式输出：
omks run "增加一个 /healthz 接口并补测试" --check "bun test"

# …或直接进入 TUI：
omks
```

`omks "帮我做 X"` 是 `omks run "帮我做 X"` 的简写。

---

## 真实运行示例

这是一次**真实、未剪辑**的运行(不是 mock)。在空目录里:

```bash
omks run "用 Bun 实现一个 TypeScript 令牌桶限流器项目:package.json、
  src/rate-limiter.ts(RateLimiter 类,含 capacity + refillPerSecond、
  tryRemove(n=1)、基于时间的补充、可注入时钟)、以及 src/rate-limiter.test.ts
  (bun:test)覆盖突发、拒绝、补充三种情况。确保 'bun test' 通过。" \
  --workflow goal --provider claude --check "bun test" --max-agents 12
```

Omakase 做了什么:

1. **自动规划出 4 步**(package.json → 限流器 → 测试 → 跑测试)。
2. 用 pipeline 逐步构建 + 同行评审。
3. **Goal-loop 把真实的 `bun test` 当作成功标准**,循环直到测试全绿——绝不自说自话地宣布完成。
4. `✓ succeeded` —— **9 次 agent 调用,约 $2.46**。

产物是一个能用的库(`bun test` → **4 pass, 0 fail, 18 assertions**),还带了一个可注入时钟,让基于时间的测试是确定性的:

```ts
// src/rate-limiter.ts (生成)
export class RateLimiter {
  constructor({ capacity, refillPerSecond, now = Date.now }: RateLimiterOptions) { … }
  tryRemove(n = 1): boolean { this.refill(); if (this.tokens >= n) { this.tokens -= n; return true; } return false; }
  available(): number { this.refill(); return this.tokens; }
}
```

重点不是"agent 写了代码",而是 Omakase **替你规划、并行执行、并且在 `bun test` 真正通过之前拒绝收工**。

---

## 内置指令

```
omks                            启动交互式 TUI
omks "<目标>"                   用默认工作流运行一个目标

核心
  init [name]                   在此创建 .omks 工作区
  run "<目标>" [选项]           无头驱动目标直至完成
  resume <runId>                续跑被中断的运行
  runs [show <id>]              列出 / 查看历史运行
  logs <runId> [-f]             打印 / 跟随一次运行的事件流

工作流（可复用、可版本化、像 Skills）
  workflow list                 列出可用工作流
  workflow show <name>          查看某工作流文档
  workflow new <name> [--flat]  脚手架生成新工作流
  workflow run <name> "<目标>"  运行指定工作流
  workflow test <name>          用 mock harness 空跑（不花钱）
  workflow lint [name]          检查会破坏 resume 的写法（--strict）
  workflow edit <name>          打印入口文件路径（$(omks workflow edit x)）
  workflow version <name>       查看 / --bump patch|minor|major

Agent 与配置
  agent list                    显示已安装的 Agent CLI
  agent scan                    重新探测 provider 与模型
  agent check                   实际发一次微调用，验证各 provider 已登录
  config [get|set|list]         工作区设置
  session [list|show]           分组运行
  doctor                        环境诊断
  web [--port n] [--open]       浏览器控制台（默认 :4517）
  mcp                           以 MCP 服务（stdio）供其它 Agent 调用

run 选项
  --workflow, -w <name>         选择工作流（默认：goal）
  --provider, -p <id>           指定 claude|codex|gemini|cursor-agent
  --model, -m <model>           指定模型
  --check "<cmd>"               成功校验：命令退出码须为 0（可重复）
  --criteria "<text>"           自然语言标准，由 Agent 判定（可重复）
  --max-agents <n>              限制 agent 调用数   --concurrency <n>  并发数
  --max-usd <n>                 限制总花费         --max-time <sec>   墙钟时间上限
  --max-rounds <n>              限制目标循环轮数（规划 → 构建 → 验证 → 修补）
  --param k=v                   工作流参数（可重复）
  --session, -s <id>            延续一个会话       --cwd <dir>  工作目录
  --save-as <name>              把这次运行固化成可复用的工作流
  --json                        每行输出一个 JSON 事件（JSONL）
```

所有上限都必须是正数 —— `--max-agents 0` 会直接报错，而不是被悄悄忽略。可重复的
参数若漏了值（例如 `--check` 后面直接跟了另一个参数）同样是用法错误，避免一个缺失
的校验被静默地变成"永远通过"。

---

## 编写一个动态工作流

工作流就是一个接收编排句柄 `w` 的 Bun/TypeScript 函数（`import type` 在运行时会被擦除，因此工作流零运行时依赖）：

```ts
// .omks/workflows/ship.ts
// name: ship
// description: 规划、并行构建每一步、再对照目标验证。
// version: 0.1.0
import type { WorkflowContext } from '@omakase/engine';

export default async function ship(w: WorkflowContext): Promise<void> {
  const steps = await w.phase('Plan', async () => {
    const res = await w.agent({ role: 'planner', title: '规划', prompt: `拆解：${w.goal.text}` });
    return res.text.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean);
  });
  await w.phase('Build', async () => {
    await w.pipeline(
      steps,
      (_v, s) => w.agent({ role: 'worker',   title: `构建 ${s}`, prompt: `实现：${s}` }),
      (b, s)  => w.agent({ role: 'reviewer', title: `评审 ${s}`, prompt: `评审：${s}\n${(b as any).text}` }),
    );
  });
  await w.phase('Validate', async () => {
    await w.loopUntil(async () => {
      const { met, gaps } = await w.goalMet();
      if (met) return [];
      await w.parallel(gaps.map((g) => () => w.agent({ role: 'worker', title: '修补', prompt: `修复：${g}` })));
      return gaps;
    }, { maxRounds: 3 });
  });
  w.requestReport({ kind: 'final', title: '完成', summary: `交付 ${steps.length} 步。` });
}
```

**把一次运行留下来。** `omks run "…" --workflow auto --save-as api-audit` 会把刚跑完的
东西写进 `.omks/workflows/api-audit/`，是真正的源码：跑过的阶段、并行跑的那几个 agent、
以及它们的 prompt（其中原来的目标被替换成 `${w.goal.text}`）。这就是"越用积累越多"的那个
闭环——一次不错的临时编排，变成可以再跑、也可以改的东西。它对任何工作流都有效，因为引擎是
**看着执行发生的**，不需要再让模型去复原。

内置工作流：**goal**（默认）、**auto**（提示词自编排 —— 由模型自己设计 DAG）、**mission**、**tdd**、**review**、**research**、**parallel**、**solo**。工作区里的同名工作流会覆盖内置版本。用 `omks workflow test <name>` 可以不花钱地验证一个工作流的形状。

`w` API：

| 方法 | 用途 |
| --- | --- |
| `w.phase(name, fn)` | 把一段工作归入一个命名的、会被记录的阶段 |
| `w.agent({role,title,prompt,provider?,model?,systemPrompt?,cwd?})` | 跑一次 agent → `{text,status,sessionId,provider,tokens,costUsd}` |
| `w.parallel([...])` | 并发跑一组 thunk（有上限），全部等待 |
| `w.pipeline(items, ...stages)` | 每个条目各自穿过所有阶段 —— 没有屏障 |
| `w.loopUntil(fn, {maxRounds})` | 循环直到 `fn` 返回 `[]` |
| `w.goalMet()` | 立刻按成功标准评估目标 |
| `w.ask(question, {options?,default?})` | 问人 —— 会被记录，续跑时直接重放 |
| `w.spawn(provider, prompt, title?)` | 在指定 provider 上跑一次性调用 |
| `w.budget()` · `w.log()` · `w.requestReport()` · `w.updateWiki()` | 计量、日志、报告、知识沉淀 |
| `w.subdir(name)` · `w.isolate(label, fn)` | 隔离并行 agent（子目录；或用完即合并的 git worktree） |
| `w.recall(limit)` · `w.providers` | 沉淀下来的知识；可用的 agent（用于路由） |
| `w.goal` · `w.params` · `w.cwd` · `w.signal` | 目标、`--param` 值、工作目录、取消信号 |

工作流可以是一个扁平的 `<name>.ts`，也可以是**像 Skills 那样的文件夹**：`WORKFLOW.md`
（frontmatter 里带 SEMVER `version`）+ `workflow.ts` + 可选的 `references/`。
`omks workflow version <name> --bump minor` 会先存快照再升版本。

**隔离并行的 agent。** `parallel`/`pipeline` 里的 agent 默认共用同一个工作目录。
当各分支互不相干时，用 `w.subdir(name)` + `agent({ cwd })` 给每个分支一个自己的目录，
它们就不会改到同一批文件 —— 内置的 **parallel** 工作流正是这么做的。

**工作流必须可重放。** `agent()` 的结果是按调用的**结构位置**缓存的——这正是 resume 能跨
`parallel`/`pipeline` 工作的原因，也意味着一个按 `Math.random()` 或时钟分支的工作流在
resume 时会**静默地错**：第二次跑走了另一条分支，缓存却把答案喂给了一个它从没问过的问题。
`omks workflow lint` 会把这类调用判为错误（exit 1）；时间戳和随机性请通过 `--param` 传进来，
那样它们会跟着运行一起被记录。像"工作流从不派发 agent"这种只是建议，不加 `--strict` 不会失败。

### 目标循环、验证、续跑与重试

- **成功标准**分四种：`command`（退出码 0）、`file`（存在 / 匹配）、`rule`（对文件树做正则）、
  `judge`（由 Agent 按评审准则打分）。只有全部通过才算*完成*；预算耗尽、致命错误、
  被取消，或**连续两轮没有进展**都会提前停下。
- **续跑：** 每次 `agent()` 调用都由一条确定性的结构化路径作为 key，结果会被记录。
  `omks resume <id>` 从缓存重放已完成的调用、只重跑剩下的 —— 即使跨 `parallel`/`pipeline` 也成立。
- **Foundation 重试：** provider 调用会以指数退避 + 抖动重试，被取消时绝不重试；
  **限流 / 过载**类错误会退避得更狠，并记下 `rateLimitedUntil`。
- **Provider 回退：** 某个 agent 的 provider 一直失败时，Omakase 会换到下一个可用的
  provider（并发出 `harness:switched`）—— 于是 claude 挂掉不会卡死整个运行。
- **预算：** 可以按 agent 调用数、**美元花费**或**墙钟时间**给一次运行封顶
  （`--max-agents` / `--max-usd` / `--max-time`），停下时会说明确切原因。

### Provider 与 Harness

通过在增强过的 `PATH` 上执行 `<cmd> --version` 来探测，结果缓存在 `.omks/agents.json`。
每个适配器负责拼出确切的无头调用命令，并把该 CLI 的流规整成「活动 + 结果」。

> **鉴权：** 探测只能确认 CLI 装了 —— 每个 provider 还必须**能在无头模式下通过鉴权**：
> `claude` 需要已登录（`claude` → `/login`），`gemini` 需要 `GEMINI_API_KEY`，
> `codex` 需要 `OPENAI_API_KEY`，`cursor-agent` 需要 `CURSOR_API_KEY`。
> 没鉴权时 Omakase 会把它真实的报错（例如 "Not logged in"）呈现出来，然后继续。

---

## 终端界面（TUI）

不带参数运行 `omks` 就会进入 TUI：左边是运行列表，右边是实时事件日志，底部是输入区。
它与 CLI 读写同一个存储 —— 你在无头模式下启动的运行会出现在这里，反之亦然。

| 按键 | 作用 |
| --- | --- |
| `⏎` | 运行目标（或执行输入的命令） |
| `⌥⏎` | 输入区换行 —— 目标可以写很多行 |
| `/` | 打开命令面板 |
| `↑ ↓` | 浏览历史运行（面板打开时是选择命令） |
| `⇥` | 切换工作流（或补全命令） |
| `⇞ ⇟` | 回滚 / 前进日志 —— 停在上方时标题会显示 `↑N` |
| `^F` | 全文模式：折行显示 Agent 的完整输出，而不是截断 |
| `^U` · `^R` | 清空输入 · 刷新运行列表 |
| `esc` · `^C` | 取消运行 · 清空输入 · 退出 |

斜杠命令：`/workflow <name>`、`/provider <id|auto>`、`/settings`、`/runs`、
`/resume <runId>`、`/cancel`、`/clear`、`/help`、`/quit`。

## 无头运行与脚本化

TUI 能做的事情，不用 TUI 也都能做 —— 这正是重点：Omakase 就是为脚本、CI
和「被其它 Agent 当作工具调用」而设计的。

```bash
# 流式运行，直到测试通过为止。退出码：0 达成，1 未达成，130 被取消。
omks run "修好挂掉的测试" --check "bun test" --max-usd 2

# 机器可读：每行一个 JSON 事件，可以接到任何地方。
omks run "加一个 /healthz" --json | jq -r 'select(.type=="agent:completed") | .payload.text'

# 跟随一个在别处启动的运行（另一个终端、控制台、CI）。
omks logs run_ab12cd34 -f

# 接着跑被中断的运行：已完成的 agent 调用直接从缓存重放。
omks resume run_ab12cd34

# 不花一分钱地验证工作流的形状。
omks workflow test ship
```

每次 agent 调用都带着稳定的 id（`agt_q298tw` → `q298tw`），它同时出现在日志、
JSONL 流和每次运行的 journal 里，所以 `omks logs <runId> | grep q298tw`
就能把某一个 agent 的完整经过从多 Agent 交错的运行里捞出来。

其它 Agent 也可以直接驱动 Omakase：`omks mcp` 以 stdio 说 MCP 协议，暴露工作流
列表和一个 `run_goal` 工具，并且支持运行中途的 `notifications/cancelled`。

## 控制台（Web）

`omks web` 会起一个本地控制台（默认端口 **4517**；支持 `--port n`、`--cwd <dir>`，
以及 `--open` 直接打开浏览器 —— 需要先 `bun run build:web` 构建 SPA，否则页面会告诉你怎么做）。

它不是只读的看板。你可以直接从浏览器发起一个目标 —— 工作流、provider、校验命令、
自然语言标准、预算上限这些 `omks run` 支持的选项它都支持 —— 也可以中途取消；
运行就在 `omks web` 进程里执行，并通过 SSE 流进同一个事件存储。运行详情会把事件流
按阶段分组、每个 Agent 折叠成一张卡片，卡片里收着它自己的活动记录、花费和最终输出；
运行列表支持搜索、按会话分组、键盘导航（`j`/`k`）。深色与浅色主题都有，窄到手机也能用。

---

## 架构

Bun workspace，职责清晰的若干包：

| 包 | 职责 |
| --- | --- |
| `@omakase/core` | 领域类型、`.omks` 工作区、事件溯源的 SQLite 存储、预算、日志 |
| `@omakase/providers` | 探测并驱动 Agent CLI：spawn、流式解析、取消 |
| `@omakase/engine` | `w` 运行时、目标循环、验证、续跑、重试、工作流加载器、内置工作流、Harness |
| `@omakase/tui` | OpenTUI + React 19 终端界面 |
| `@omakase/web` | Vite 8 + React 19 控制台 SPA，由 `omks web` 提供服务 |
| `@omakase/cli` | `omks` 命令 |

## 开发

```bash
bun install
bun run check          # 全部包类型检查 + 测试
bun test               # 各包的单元与集成测试
bun run typecheck:all

bun run build:cli      # 编译出独立的 ./dist/omks 二进制（运行时不需要 Bun）
bun run build:web      # 构建控制台 SPA（Vite）
```

## 许可证

MIT © Omakase contributors
