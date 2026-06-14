# TUI 重构设计：opencode 式对话 × 多 agent 编排

- 日期：2026-06-15
- 状态：已批准（待实现计划）
- 范围：`@omakase/cli` 的 TUI，及 `@omakase/core` 新增的 session 层

## 1. 问题与目标

现有 TUI（`packages/cli/src/tui/App.tsx`，915 行）是一个「workflow monitor」式只读仪表盘：
Header + Plan 窗格 + Activity/detail 窗格 + workspace 切换，纯键盘驱动。它把编排过程当作被动监控对象展示，用户**无法对话、无法驱动**，与三项核心能力（Agent 路由、7×24 长线任务、Dynamic Workflow）脱节，实用价值低。

目标：参考 opencode 等 CLI 的体验，重构成**对话式 REPL**，并把三项核心能力显式接入：

- **Agent 路由**：每条自然语言任务默认由 router-agent 判定路由，判定结果在对话流中可见。
- **7×24 长线任务**：run 仍是后台 daemon 单元，退出 TUI 不停；重连重放；只有显式 `/stop` 取消。
- **Dynamic Workflow**：`/workflow` 是一等公民，侧栏显示其 phase/agent 编排进度。

非目标：不改后端编排能力（orchestrator / supervisor / daemon 运行语义一行不动）；不做 Electron Desktop App。

## 2. 交互范式（已定）

**对话流 + 可折叠编排侧栏（混合式）**：

- 左主区 = 会话 scrollback（对话时间线）。
- 右侧栏 = 当前聚焦 run 的编排（Plan + Agents），**默认展开**，`o` 折叠/展开，`Tab` 在两区间切焦点。
- 底部 = Composer 输入行。

```
┌─ omakase ───────────┬─ run ▸ 4 agents ─┐
│ › 给登录页加 OAuth   │ Plan             │
│ ✓ router COMPLEX     │  ✓ scaffold      │
│ ▸ worker[claude]     │  ▸ oauth-cb      │
│   callback.ts +82    │  ▸ token-refresh │
│ ▸ worker[codex]      │  ◷ review        │
│   refresh.ts         │ Agents           │
│                      │  claude ● 1.2k   │
│                      │  codex  ● 840    │
├──────────────────────┤ [tab] 切焦点      │
│ › _              ⏎   │                  │
└──────────────────────┴──────────────────┘
```

## 3. 会话模型（已定）

**一个 session 含多个 run，上下文贯通。session 内 run 串行。**

- 一条 session = 一条连续对话，可提多个任务；每个实质任务起一个后台 daemon run，但全部渲染在同一条 scrollback。
- **session 内 run 串行**：同一时刻 session 只有一个活跃 run。run 运行中的 follow-up = 注入输入（不起新 run）；run 终止后的新任务 = 起 session 内下一个 run。
- 跨 session 可并发（daemon 本就支持多 run）。
- 上下文贯通：起新 run 时把 session 的 `rollingSummary` + 项目 wiki 注入新 run 的 request preamble；run 结束把结果摘要回写 `rollingSummary`。

## 4. 架构分层

```
TUI (Ink, 重写)
  ├─ Session.tsx       会话 scrollback（多 run 的可读时间线）
  ├─ Orchestration.tsx 侧栏：聚焦 run 的 Plan + Agents（默认展开，Tab 切焦点，o 折叠）
  └─ Composer.tsx      输入行：NL / slash / @agent / #file / /workflow 解析
        │
        ▼
SessionStore (新, core)   .omakase/sessions/<id>.json — 多 runId 归一会话 + rollingSummary
        │
        ▼
RunControllerClient (扩展)  + transcript 投影；+ session 感知 submit
        │
        ▼
daemon (不动)  serve --watch 常驻，run 仍是后台单元
```

关键原则：TUI 仍是纯 client，daemon 仍拥有 run。新增的只是 (a) session 分组层，(b) 把 `OrchestratorEvent` 流投影成聊天时间线的 reducer。

## 5. 组件设计

### 5.1 SessionStore（新，`core/src/session/store.ts`）

- 数据：`Session { id, title, runIds: string[], rollingSummary: string, createdAt, updatedAt }`。
- 持久化：`.omakase/sessions/<id>.json`，原子写（temp + rename，沿用 `FileRunStore` 的写法）。
- 接口：`create()`, `load(id)`, `list()`, `appendRun(sessionId, runId)`, `updateSummary(sessionId, summary)`, `delete(id)`。
- 校验：`isValidSession`，部分/陈旧文件 fail clean（返回 null），与 `isValidRunRecord` 同风格。
- 标题：首个任务的前若干字或 router/planner 产出的 title。

### 5.2 Composer 解析（新，`cli/src/composer-parse.ts`）

纯函数 `parseComposerInput(raw): ComposerIntent`，判别：

- `NL 任务` → `{ kind: 'task', prompt, agentOverride?, files: string[] }`（剥离内联 `@agent`/`#file` 后的正文）。
- `/cmd …` → `{ kind: 'command', name, args }`，命令表：
  `/new /sessions /runs /stop /pause /resume /model /agent /workflow /web /clear /help`。
- 内联 `@agent` → 填 `agentOverride`（已支持 `request.metadata.agentOverride`）。
- 内联 `#path` → 进 `files`（提交时读入 request 上下文）。
- `/workflow <脚本|描述>` → `{ kind: 'workflow', source }`。

补全：`/` 前缀弹命令菜单；`@` 弹可用 agent；`#` 弹文件（codegraph/glob）。补全 UI 在 Composer.tsx，纯函数只负责解析已确定的输入。

### 5.3 Transcript 投影（扩展 `cli/src/view-model.ts`）

- 新增纯 reducer `reduceTranscript(events): TranscriptItem[]`。
- `TranscriptItem` 种类：`user-message` / `route`（含 SIMPLE/COMPLEX 判定）/ `plan`（任务数）/ `task-progress`（worker 角色 + agent + diff 摘要 `+N -M`）/ `review` / `report` / `workflow-phase`。
- 侧栏复用现有 `reduceRunView` / `buildRunView` 取 Plan/Agents。
- 两者皆纯 reducer，可单测，不碰真实模型。

### 5.4 RunControllerClient 扩展（`cli/src/run-client.ts`）

- 现有：`submit/resolveRunId/snapshot/list/tail/stop/pause/resume/sendInput/answerGate/editCriteria`。
- 新增：session 感知 `submitToSession(sessionId, intent)`（注入 rollingSummary + files，写 agentOverride header）；`transcript(runId)` / `tailTranscript`（基于 `reduceTranscript`）。

### 5.5 TUI Shell（重写 `cli/src/tui/App.tsx` + 拆分组件）

- `App.tsx` 瘦身为壳：持有 session 列表、当前 session、焦点区、侧栏展开态、daemon 状态、composer 态。
- `Session.tsx`：渲染当前 session 所有 run 的 transcript（每 run 一个可折叠块）。
- `Orchestration.tsx`：侧栏 Plan + Agents，默认展开。
- `Composer.tsx`：输入行 + 补全弹层。
- 键位：`Tab` 切焦点；`o` 折叠侧栏；`↑↓` 在聚焦区滚动/选择；`enter` 提交；`/ @ #` 触发补全；`esc` 关补全/返回。
- 全屏自适应沿用 `useTerminalSize`；`useInput` 仍 gated on `isRawModeSupported`。

## 6. 现有能力去留

- 折叠进新结构：agent 状态 → 侧栏 Agents；knowledge/wiki → `/web` 打开只读 server（保留 `readOnlyUrl`、`addWikiEntry` 走 slash 命令）。
- 丢弃：旧 workspace 切换、Phases/Detail 两窗格 monitor 模型及其键位。
- 不丢任何后端能力，仅替换前端交互。

## 7. 测试策略

- 纯单测：`parseComposerInput`、`reduceTranscript`、`SessionStore`（含校验/原子写/上下文继承）。
- TUI：`ink-testing-library` + mock client（沿用现有 `tui.test.tsx` 模式），**无真实模型调用**。
- 端到端（mock daemon）：提交 → 路由判定显示 → 侧栏更新 → run 中 follow-up 注入 → run 终止后新 run 继承 `rollingSummary`。
- `/workflow` 路径：mock workflow runner，验证侧栏 phase/agent 进度渲染。
- 回归：保持 build + typecheck + 全测试绿。

## 8. 文件计划

新增：

- `packages/core/src/session/store.ts`
- `packages/cli/src/composer-parse.ts`
- `packages/cli/src/tui/Composer.tsx`
- `packages/cli/src/tui/Session.tsx`
- `packages/cli/src/tui/Orchestration.tsx`

修改：

- `packages/cli/src/view-model.ts`（+ `reduceTranscript` / `TranscriptItem`）
- `packages/cli/src/run-client.ts`（session 感知 submit + transcript tail）
- `packages/cli/src/tui/App.tsx`（重写为壳 + 组件组合）
- `packages/cli/src/cli.ts`（session 列表/切换接线）
- `packages/core/src/index.ts`（导出 SessionStore）
- 测试文件相应新增/扩展

## 9. 风险与缓解

- **scrollback 性能**（长 session 多 run 事件多）：transcript reducer 增量化 + 折叠非聚焦 run；侧栏只投影聚焦 run。
- **补全 UI 复杂度**：补全是 Composer.tsx 局部状态，解析是纯函数，二者解耦，降低 TUI 测试难度。
- **session/run 一致性**：SessionStore 只存 runId 引用，run 真相仍在 daemon 的 RunStore，避免双写不一致。
