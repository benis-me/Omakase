# TUI opencode-grade interaction — design

- 日期：2026-06-15
- 状态：已批准（layout = 保留常驻侧栏的混合；范围 = 全部 A–F + daemon 流式 flush）
- 前置：建立在 `2026-06-15-tui-conversational-redesign` 之上（session/transcript/sidebar 已就位）

## 目标

把 TUI 的交互质量提到 opencode 级，**保留**混合布局（顶 status bar · 左聊天流 · 右常驻编排侧栏 · 底多行编辑器）。基于已核实的 opencode 行为复刻：真·多行编辑器、富渲染（markdown + diff）、逐 token 流式、命令面板 + 模糊查找（`/` `@` `!` `ctrl+p`）、leader 键体系 + 选择器（sessions/model/agent）、多档滚动。

后端编排能力不变；唯一的 daemon 改动是为流式输出增加去抖的流式 checkpoint（Phase C）。所有纯逻辑单测，Ink 组件用 ink-testing-library，无真实模型调用。

## opencode 行为基线（已核实）

- 编辑器：多行 + readline/emacs 键位（`ctrl+a/e` 行首尾、`ctrl+k` 删到行尾、`ctrl+w` 删词、`ctrl+u` 删到行首、方向键/home/end、任意位置增删）、`@` 模糊找文件、`!` shell、`/` slash、`$EDITOR` 外部编辑。
- 渲染：markdown 消息、diff（auto/stacked）、assistant 输出逐 token 流式。
- 导航：leader 键 `ctrl+x`（2000ms 超时）、命令面板 `ctrl+p`、which-key `ctrl+alt+k`、多档滚动（page/half/line/首尾）、`esc` 中断。
- 选择器：sessions `<leader>l`/新建 `<leader>n`、model `f2`/`<leader>m`、agent `<leader>a`/`tab`、主题。

## Phase A — 多行编辑器（最高杠杆）

`packages/cli/src/tui/editor/state.ts`（纯）+ `Editor.tsx`（视图）。

- `EditorState { lines: string[]; row: number; col: number }`。
- `reduceEditor(state, key): EditorState` 处理：可见字符插入、`backspace`/`delete`（含跨行）、方向键、`home`/`end`(=`ctrl+a`/`ctrl+e`)、`ctrl+k`（删到行尾）、`ctrl+u`（删到行首）、`ctrl+w`（删前一个词）、`alt+enter`（换行）。
- `editorText(state)`、`isEmpty(state)`。
- `Editor.tsx`：渲染多行 + 行内光标块；`onSubmit(text)`（enter，buffer 非空）；`onChange` 暴露当前文本（供 `/` `@` `!` 触发器判断）。

## Phase B — 富渲染

`packages/cli/src/tui/render/markdown.ts`（纯）+ `diff.ts`（纯）+ 在 `Session.tsx` 内消费。

- `tokenizeMarkdown(src): MdSegment[]`：标题、粗体/斜体、行内码、代码块（fenced）、有序/无序列表、普通段落。
- `renderMarkdown(segments)`：映射到 Ink `<Text>`（代码块灰底、标题加粗、列表前缀）。
- `tokenizeDiff(patch): DiffLine[]`：`+`/`-`/上下文/hunk 头；`renderDiff` 着色（增绿减红）。
- transcript 新增 `assistant-message`（markdown）与 `file-change`（diff）项类型（扩展 `reduceTranscript`）。

## Phase C — 实时流式（含 daemon 改动）

- daemon：`packages/cli/src/serve.ts` / orchestrator wiring 增加去抖流式 checkpoint——agent 流式 delta 累积超过 N 字符或 T ms 即持久化一次（不等任务边界）。配置项 `streamFlushMs`（默认 ~150ms），可关。
- client：`tailRun` 已在 record 前进时重投影；流式 flush 让 record 更频繁前进，聊天区即可显示「正在输出」的 assistant 消息（取 RunView 的 `activity`/`phrases` 尾部归属到当前活跃 agent）。
- transcript：把活跃 agent 的流式文本渲染为一个进行中的 `assistant-message`，完成后定格。

## Phase D — 命令面板 + 查找器

`packages/cli/src/tui/overlay/`：

- `palette.ts`（纯 fuzzy 过滤）+ `Palette.tsx`：`ctrl+p` 打开命令面板，列出全部命令 + 当前可用动作，模糊筛选 + 上下选择 + enter 执行。
- `/` slash：复用命令表，编辑器里以 `/` 开头时显示模糊菜单（升级现 Composer 的静态列表）。
- `@` 文件查找：`@` 触发，模糊匹配项目文件（glob，排除 .gitignore/node_modules），选中插入 `#path`。
- `!` shell：`!cmd` 提交时跑 shell，stdout/stderr 作为一条 `shell-output` transcript 项注入（不进 run）。

## Phase E — leader 键 + 选择器 + status bar

- `leader.ts`（纯）：leader 键状态机（`ctrl+x` 进入待续，超时 2000ms 复位，第二键映射到动作）。which-key `ctrl+alt+k` 显示可续键。
- 选择器浮层（复用 Palette 模式）：sessions（`<leader>l`，列出 SessionStore，enter 切换；`<leader>n` 新建）、model（`<leader>m`/`f2`，列出 detect() 的可用 agent，选中即设 agentOverride）、agent（`<leader>a`/`tab`，Ralph 角色主 agent）。
- `StatusBar.tsx`：session 标题 · 主 agent/model · mode · daemon 状态 · 活跃 agent 数。

## Phase F — 滚动 + 收尾

- `Session.tsx` 增加滚动偏移状态：page(`pageup/down`)、half(`ctrl+alt+u/d`)、line(`ctrl+alt+y/e`)、首/尾(`ctrl+g`/`end`)；新消息到来时若在底部则跟随，否则保持位置。
- `esc` 中断当前 run（= `/stop`）。
- 主题：`theme.ts` 简单调色板（默认 + 至少一个备选），`/themes` 切换。

## 文件结构（新增/修改）

新增：
- `packages/cli/src/tui/editor/state.ts`, `Editor.tsx`
- `packages/cli/src/tui/render/markdown.ts`, `diff.ts`
- `packages/cli/src/tui/overlay/palette.ts`, `Palette.tsx`
- `packages/cli/src/tui/leader.ts`
- `packages/cli/src/tui/StatusBar.tsx`
- `packages/cli/src/tui/theme.ts`
- `packages/cli/src/tui/files.ts`（`@` 文件查找：列举 + fuzzy）

修改：
- `packages/cli/src/tui/Composer.tsx`（改用 Editor + 触发器接线）或并入 Editor
- `packages/cli/src/tui/Session.tsx`（markdown/diff/streaming/滚动）
- `packages/cli/src/tui/App.tsx`（leader 键、浮层、status bar、键位路由）
- `packages/cli/src/view-model.ts`（transcript 增 assistant-message/file-change/shell-output；活跃流式归属）
- `packages/cli/src/serve.ts` + orchestrator wiring（流式 checkpoint）
- 相应测试

## 测试策略

- 纯逻辑单测：`reduceEditor`（每个键位）、`tokenizeMarkdown`/`tokenizeDiff`、`palette` fuzzy、`leader` 状态机、`files` fuzzy。
- 组件：Editor（输入/光标/多行/emacs 键）、Session（markdown/diff/滚动）、Palette（筛选/选择/执行）、StatusBar，用 ink-testing-library。
- daemon 流式：serve 测试加一个去抖 flush 的断言（record 在任务中途前进）。
- 全程 build + typecheck + 全测试绿。

## 风险

- Ink 渲染量：长会话 + markdown 节点多 → 只渲染可见窗口（滚动偏移裁剪），侧栏只投影聚焦 run。
- 键位冲突：leader 键体系避免与编辑器 emacs 键冲突（`ctrl+x` 不被编辑器占用）；浮层打开时拦截全部键。
- daemon 流式频率：去抖 + 字符阈值，避免文件写风暴；可配置/可关。
