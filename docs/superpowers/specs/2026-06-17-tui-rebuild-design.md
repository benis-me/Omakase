# TUI rebuild — design (factory.ai × opencode, on OpenTUI/Bun)

- 日期：2026-06-17
- 状态：清白重做(删除全部旧 UI;数据层保留)
- 基础:OpenTUI(@opentui/react)+ Bun(已验证可行,opencode 本人也用 OpenTUI)

## 0. 为什么重做

旧 TUI 经历 Ink → OpenTUI → 布局多次返工,积重难返。本次从零重建 UI 层,严格对照 factory droid 与 opencode 的界面与交互。**保留数据/集成层**(它不是 UI,是把本项目能力接进来的桥):`RunControllerClient`、`SessionStore`、`reduceTranscript`/`TranscriptItem`、`daemon-control`、daemon 流式 `streamFlushMs`。

## 1. 设计基线(已核实)

两者都是**单列对话 REPL**:顶部一行上下文、中间对话流、底部输入 + 状态行。无常驻侧栏。

- **factory droid**:状态行;`Shift+Tab` 切模式(Auto/Spec/Mission);`Tab` 切 reasoning;`Ctrl+N` 切模型、`Ctrl+L` 切自治;`!` bash 模式(`›`→`$`);`/` 命令面板(`/model /sessions /review /mcp /share`…);`Ctrl+O` 折叠细节;`Alt+↑/↓` 按回合滚动;持久 session、fork、compress;Mermaid→ASCII;`/context` 进度条;主题。
- **opencode**:`Ctrl+X` leader(`leader+n` 新建、`leader+l` sessions、`leader+m` 模型);`F2` 模型循环;`@` 文件模糊查找;`!` shell;多档滚动(page/half/line/首尾);`Esc` 中断;子 agent 树导航;主题;桌面通知。

## 2. 架构(干净、小文件)

**纯逻辑(留在 `src/`,Node 类型检查 + vitest 单测,无 OpenTUI 依赖)**
- `src/composer.ts` — `parseInput(raw)`:分类 task / slash-command / `@file` / `!bash` / workflow,抽取 `@agent`、`#file`。
- `src/fuzzy.ts` — `fuzzyFilter`(命令/文件/session/agent 选择器共用)。
- `src/keymap.ts` — 纯键位映射:`(key, ctx) → Action`(leader/shift-tab/ctrl-*/esc…),便于单测,UI 只负责执行 Action。
- `src/feed.ts` — `buildFeed(transcript, bashLog, opts) → FeedLine[]`:把 `TranscriptItem[]` + 本地(bash/系统)条目折成可渲染的行(含 diff/markdown 标记)。
- 复用:`view-model.ts`(`reduceTranscript`)、`run-client.ts`(`submitToSession`/`tailRun`/控制)。

**OpenTUI 渲染(`src/tui/`,Bun-only,排除出 Node tsc;OpenTUI `testRender` 帧测试)**
- `src/tui/main.tsx` — Bun 入口:argv → client/sessions/detect/daemon → `createCliRenderer` + `createRoot` → `<App>`。
- `src/tui/App.tsx` — 壳:组合下面组件 + 顶层键路由(用 `keymap.ts`)。
- `src/tui/useController.ts` — 把 client/session/run 状态收敛成一个 hook(UI 的 view-model):submit、attach/tail、命令、session 切换、流式。
- `src/tui/Transcript.tsx` — `<scrollbox>` 单列对话流;turn 渲染;编排内联(routed/plan/worker/review/done);`<markdown>`/`<diff>`;流式「working…」。
- `src/tui/Composer.tsx` — `<textarea>` + `›/$` 前缀 + 占位;`!`/`/` 触发;多行。
- `src/tui/StatusLine.tsx` — `mode · agent · tokens · ctx%` + 键位提示。
- `src/tui/Header.tsx` — `omakase · <cwd> · <session>`。
- `src/tui/Palette.tsx` — 通用 `<select>` 浮层(命令/sessions/agents/files),fuzzy 过滤。
- `src/tui/GatePrompt.tsx` — 风险门/审批 prompt(factory 式 approve/reject),写回 `answerGate`。

## 3. 完整功能矩阵(factory/opencode → omakase)

| 功能 | 键 | omakase 映射 | 完整实现 |
|---|---|---|---|
| 自然语言任务 | enter | `submitToSession`,router-agent 路由 | ✓ |
| 多行编辑 | shift+enter / ctrl+j | OpenTUI `<textarea>` 原生 | ✓ |
| 行内编辑键 | ctrl+a/e/k/u/w、方向、退格 | textarea 原生(修掉了 Ink 退格 bug) | ✓ |
| 命令面板 | `/` 或 ctrl+p | Palette + fuzzy,命令表 | ✓ |
| bash 模式 | `!` | inline 执行 shell,输出进 feed,esc 退出 | ✓ |
| `@file` 引用 | `@` | 模糊文件查找,插入 `#path` 进上下文 | ✓ |
| 切 agent/model | shift+tab / ctrl+n / `/model` | `agentOverride`(auto→检测到的 agent) | ✓ |
| 切模式 | (factory Mission) | normal / max-power / **mission(多 agent)** 标签,随提交带上 | ✓ |
| 折叠细节 | ctrl+o | 隐藏 route/report 等次要行 | ✓ |
| 滚动 | pageup/down、g/G、alt+↑/↓ | `<scrollbox>` + 偏移 | ✓ |
| 中断 | esc | `client.stop`(只有它+/stop 取消) | ✓ |
| sessions | `/sessions`、leader/`ctrl+s` | SessionStore 列表/切换/新建,上下文贯通 | ✓ |
| 退出不取消 | ctrl+c | 退 TUI,daemon 续跑,重连重放 | ✓ |
| 状态行 | — | mode·agent·tokens·daemon | ✓ |
| 主题 | `/theme` | 至少 default + 一个备选调色板 | ✓ |
| 帮助 | `?` | 键位浮层 | ✓ |

**能力融合(omakase 专有,体现在对话流/命令里)**
- 多 agent 编排:路由→计划→worker→review 作为内联 turn;mission 模式。
- Dynamic workflow:`/workflow <脚本/描述>`,phase 内联。
- 24/7:run 在 daemon,session 持久,退出重连。
- 知识/报告:`/web` 打开只读 server;report turn 内联。
- 风险门/验收:GatePrompt 就地审批(`answerGate`/`editCriteria`)。
- token/cost 预算:状态行显示。

## 4. 测试

- 纯逻辑(Node/vitest):`parseInput`、`fuzzyFilter`、`keymap`、`buildFeed`、`reduceTranscript`、`composeSessionPrompt`、`submitToSession`。
- OpenTUI(Bun/`testRender`):App 渲染帧断言(空态、含编排的对话、命令面板、bash 模式、gate),抓字符帧比对关键文本/布局。`pnpm --filter @omakase/cli test:tui`。
- Node 全套 typecheck + test + build 保持绿(`src/tui` 排除出 tsc,由 Bun 持有)。

## 5. 完成定义(DoD)

每个矩阵功能都「能用」:有按键/命令触发、有可见反馈、有测试(纯逻辑单测或 testRender 帧)。`omakase tui` 真机可进、可打字删字、可提交任务看到编排、可 `!`/`/`/`shift+tab`/`esc`。Node 全绿 + Bun 帧测试绿。

## 6. 风险

- OpenTUI 0.4.1 早期:组件 prop 以实测帧为准(已建立 testRender 抓帧流程)。
- 交互式 TTY 无法在 CI 驱动:用 testRender(headless)覆盖渲染与可断言的状态变化;真机交互由发布前手测兜底。
