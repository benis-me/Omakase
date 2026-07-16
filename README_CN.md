# Omakase（`omks`）

> 用**动态工作流（Dynamic Workflow）**和**目标循环（Goal‑loop）**，编排你电脑上已经装好的各种 AI Agent CLI —— 直到目标被“可验证地”完成为止。

Omakase 是一个本地优先、可开源的 CLI + TUI，把 `claude`、`codex`、`gemini`、`cursor-agent` 等已安装的 Agent CLI 变成一支可编排的舰队。你给它一个**目标（Goal）**，它就会规划、并行派发多个 Agent、按成功标准**验证**结果，并循环直到达成 —— 同时具备可持久化的**续跑（Resume）**、**重试（Retry）**，以及对全过程的事件溯源记录。

技术栈：**Bun**、**TypeScript**、**React 19**、**OpenTUI**。除终端渲染器外，零运行时依赖。

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

工作流（可复用、可版本化、像 Skills）
  workflow list                 列出可用工作流
  workflow show <name>          查看某工作流文档
  workflow new <name> [--flat]  脚手架生成新工作流
  workflow run <name> "<目标>"  运行指定工作流
  workflow version <name>       查看 / --bump patch|minor|major

Agent 与配置
  agent list                    显示已安装的 Agent CLI
  agent scan                    重新探测 provider 与模型
  config [get|set|list]         工作区设置
  session [list|show]           分组运行
  doctor                        环境诊断

run 选项
  --workflow, -w <name>         选择工作流（默认：goal）
  --provider, -p <id>           指定 claude|codex|gemini|cursor-agent
  --model, -m <model>           指定模型
  --check "<cmd>"               成功校验：命令退出码须为 0（可重复）
  --criteria "<text>"           自然语言标准，由 Agent 判定（可重复）
  --max-agents <n>              限制 agent 调用数   --concurrency <n>  并发数
  --cwd <dir>                   工作目录   --json  输出 JSONL 事件
```

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

内置工作流：**goal**（默认）、**mission**、**tdd**、**review**、**research**、**solo**。工作区里的同名工作流会覆盖内置版本。

---

## 架构

Bun workspace，职责清晰的若干包：

| 包 | 职责 |
| --- | --- |
| `@omakase/core` | 领域类型、`.omks` 工作区、事件溯源的 SQLite 存储、预算、日志 |
| `@omakase/providers` | 探测并驱动 Agent CLI：spawn、流式解析、取消 |
| `@omakase/engine` | `w` 运行时、目标循环、验证、续跑、重试、工作流加载器、内置工作流、Harness |
| `@omakase/tui` | OpenTUI + React 19 终端界面 |
| `@omakase/cli` | `omks` 命令 |

## 开发

```bash
bun install
bun run check          # 全部包类型检查 + 测试
bun test
```

## 许可证

MIT © Omakase contributors
