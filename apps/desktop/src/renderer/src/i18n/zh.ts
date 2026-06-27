/** English source string → Chinese. Missing keys fall back to the English source. */
export const zh: Record<string, string> = {
  // ── Nav + hints ──────────────────────────────────────────────────────────
  Runs: '运行',
  Specs: '规格',
  Agents: '智能体',
  Automations: '自动化',
  Memory: '记忆',
  Workflows: '工作流',
  Commands: '命令',
  Dev: '开发',
  'Active and past agent runs': '进行中与历史的智能体运行',
  'Specifications you hand to the loop': '交给循环执行的规格',
  'Live sub-agents spawned by runs': '运行中实时生成的子智能体',
  'Triggers that start runs on a schedule or on file changes': '按计划或文件变更自动起跑的触发器',
  'AGENTS.md, wiki, and accumulated knowledge': 'AGENTS.md、wiki 与累积的知识',
  'Dynamic orchestration scripts': '动态编排脚本',
  'Reusable prompt recipes (skills)': '可复用的提示配方（技能）',
  'Scripts, ports, terminals, open with': '脚本、端口、终端、用…打开',

  // ── Common actions ───────────────────────────────────────────────────────
  Save: '保存',
  Delete: '删除',
  Cancel: '取消',
  Run: '运行',
  New: '新建',
  Rescan: '重新扫描',
  Settings: '设置',
  'Toggle theme': '切换主题',
  Edit: '编辑',
  Preview: '预览',

  // ── Title bar / sidebar / workspace ──────────────────────────────────────
  'Select workspace': '选择工作区',
  Workspaces: '工作区',
  'No workspaces yet — add one with the + above.': '还没有工作区——点上方的 + 添加。',
  'Search workspaces': '搜索工作区',
  'No matching workspaces.': '没有匹配的工作区。',
  'Command palette': '命令面板',
  Clear: '清除',
  'Open folder…': '打开文件夹…',
  'New project…': '新建项目…',
  'No workspace open. Pick one above to begin.': '未打开工作区。在上方选择一个开始。',
  'Welcome to Omakase': '欢迎使用 Omakase',
  'Open a folder': '打开文件夹',
  'New project workspace': '新建项目工作区',
  Location: '位置',
  'Choose a parent folder…': '选择上级文件夹…',
  'Project name': '项目名称',
  'Create workspace': '创建工作区',
  'Type a command or search…': '输入命令或搜索…',
  'No matches': '无匹配',

  // ── Settings ─────────────────────────────────────────────────────────────
  General: '通用',
  'Run defaults': '运行默认值',
  'Agent CLIs': '智能体 CLI',
  Theme: '主题',
  Language: '语言',
  'App appearance': '应用外观',
  System: '系统',
  Light: '浅色',
  Dark: '深色',
  'Appearance and app-level preferences.': '外观与应用级偏好。',
  'Default autonomy': '默认自治档',
  'Default work mode': '默认工作模式',
  'How far a run proceeds before it pauses to ask': '运行在暂停询问前推进的程度',
  'Agent + model selection strategy': '智能体 + 模型选择策略',
  'Applied to new runs (overridable per run when you start one).': '应用于新运行（起跑时可逐次覆盖）。',
  Rescanning: '扫描中',
  'No agent CLIs found. Install one and Rescan.': '未找到智能体 CLI。安装后重新扫描。',

  // ── Runs / cockpit ───────────────────────────────────────────────────────
  'Start a run': '开始一次运行',
  'From a spec': '从规格',
  'None — write a task below': '无 —— 在下方写任务',
  'Describe the task…': '描述任务…',
  'Optional extra instructions…': '可选的额外说明…',
  'No runs yet. Start one with “New”.': '还没有运行。点「新建」开始。',
  Activity: '动态',
  Tasks: '任务',
  Reports: '报告',
  Knowledge: '知识',
  Diffs: '改动',
  // ── Acceptance panel ─────────────────────────────────────────────────────
  'criteria met': '条标准达成',
  'from agent spec': '来自 agent 规格',
  'agent spec': 'agent 规格',
  'No acceptance criteria yet — they appear once a spec drives the run, or the agent authors one.':
    '还没有验收标准——当 spec 驱动运行,或 agent 自己写出 spec 时,标准会出现在这里。',
  pending: '待定',
  pass: '通过',
  fail: '未通过',
  unknown: '未知',
  'needs-user': '待人工',
  'The run needs your decision': '运行需要你的决定',
  Hold: '暂缓',
  'Approve & proceed': '批准并继续',
  'Queue a steering message…': '排入一条引导消息…',
  'This run has ended.': '此运行已结束。',
  'This run was interrupted — resume to continue.': '此运行已中断——恢复以继续。',
  'No uncommitted changes in the workspace.': '工作区没有未提交的改动。',
  'Loading diff…': '加载改动…',
  idle: '空闲',

  // ── Specs ────────────────────────────────────────────────────────────────
  'New spec': '新建规格',
  'No specs yet.': '还没有规格。',
  Idea: '想法',
  Spec: '规格',
  Acceptance: '验收',
  'Test plan': '测试计划',
  Done: '完成',

  // ── Agents (roster) ──────────────────────────────────────────────────────
  'No runs yet. Agents appear here as a run spawns them.': '还没有运行。智能体会在运行生成它们时出现。',

  // ── Automations ──────────────────────────────────────────────────────────
  'New automation': '新建自动化',
  'Edit automation': '编辑自动化',
  Automation: '自动化',
  'No automations yet. Create a trigger to start a run on a schedule or whenever files change — the basis for unattended, self-iterating loops.':
    '还没有自动化。创建一个触发器，按计划或在文件变更时启动运行——这是无人值守、自我迭代循环的基础。',
  Name: '名称',
  Source: '来源',
  'A task': '一个任务',
  'Every N minutes': '每 N 分钟',
  'Daily at a time': '每天定时',
  'On file changes': '文件变更时',
  Mode: '模式',
  Autonomy: '自治',
  'Agent CLI': '智能体 CLI',
  'Save automation': '保存自动化',
  Enabled: '已启用',
  Disabled: '已禁用',

  // ── Commands ─────────────────────────────────────────────────────────────
  'New command': '新建命令',

  // ── Workflows ────────────────────────────────────────────────────────────
  'New workflow': '新建工作流',
  Blank: '空白',

  // ── Title bar / sidebar / workspace (additional) ─────────────────────────
  missing: '缺失',
  'Switch to': '切换到',
  'Go to': '前往',
  'Theme:': '主题：',
  'Open settings': '打开设置',
  'Creates a new folder with an': '新建一个文件夹，内含',
  'workspace inside.': '工作区。',

  // ── Empty state ──────────────────────────────────────────────────────────
  'Hand a spec to autonomous, long-running multi-agent loops — and let them finish the work, while you watch and steer. Open a folder to begin; it becomes a workspace.':
    '把规格交给自治、长时运行的多智能体循环——让它们完成工作，你只需旁观与引导。打开一个文件夹即可开始；它会成为一个工作区。',

  // ── Settings (additional) ────────────────────────────────────────────────
  'App and run settings': '应用与运行设置',
  'Scanning…': '扫描中…',
  'Detected on your': '检测自你的',
  'and common toolchain dirs. Runs spawn their sub-agents through these; pick which to use when you start a run.':
    '及常见工具链目录。运行通过它们生成子智能体；起跑时选择使用哪一个。',
  'Supported:': '支持：',
  'Any installed on your PATH is detected automatically.': '凡安装在你 PATH 上的都会被自动检测。',

  // ── Specs (additional) ───────────────────────────────────────────────────
  'Select a spec from the list, or create a new one to start capturing requirements.':
    '从列表中选择一个规格，或新建一个以开始记录需求。',
  "Add this phase's content before advancing.": '请先补充本阶段的内容再推进。',
  'Delete spec': '删除规格',
  Title: '标题',
  'What are we building?': '我们要构建什么？',
  edit: '编辑',
  preview: '预览',
  'Nothing to preview yet.': '暂无可预览内容。',
  'This spec is fully drafted.': '此规格已完整拟定。',
  'Idea, spec, acceptance criteria, test plan, and tasks are all captured.':
    '想法、规格、验收标准、测试计划与任务均已记录。',
  'Not advanced yet': '尚未推进',
  'Spec complete': '规格完成',
  'Advance to': '推进到',
  Add: '补充',
  'content to advance': '内容以推进',
  Advance: '推进',
  'Nothing here yet — add at least one to advance.': '这里还是空的——至少添加一项才能推进。',
  Remove: '移除',
  'Add criterion': '添加标准',
  'Add test': '添加测试',
  'Add task': '添加任务',
  'Add item': '添加条目',
  'A one-line title for what you want to build.': '为你想构建的东西写一句标题。',
  'The markdown spec: summary, scope, and approach.': 'Markdown 规格：概要、范围与思路。',
  'Testable assertions that define done.': '界定「完成」的可测试断言。',
  'How each criterion is verified.': '每条标准如何验证。',
  'The implementation slices to execute.': '要执行的实现切片。',
  'The spec is fully drafted and ready to run.': '规格已完整拟定，可以运行。',

  // ── Agents (roster, additional) ──────────────────────────────────────────
  'No sub-agents yet. The orchestrator spawns planner, worker, reviewer and validator agents as this run progresses.':
    '还没有子智能体。随着本次运行推进，编排器会生成规划、执行、审查与校验智能体。',
  'Agents are spawned by runs — start a run, and its planner/worker/reviewer/validator agents appear here live.':
    '智能体由运行生成——开始一次运行，它的规划/执行/审查/校验智能体会在此实时出现。',

  // ── Automations (additional) ─────────────────────────────────────────────
  'A trigger starts a run automatically — on a schedule or when files change.':
    '触发器会自动起跑一次运行——按计划或在文件变更时。',
  'Nightly spec run': '夜间规格运行',
  'Choose a spec…': '选择一个规格…',
  Trigger: '触发器',
  'Every (minutes)': '每隔（分钟）',
  'At (local time)': '于（本地时间）',
  'Debounce (ms)': '防抖（毫秒）',
  'Token budget per run (optional)': '每次运行的 Token 预算（可选）',
  '∞ — no cap': '∞ —— 不设上限',
  'Enabled — arm this trigger now': '已启用 —— 立即布防此触发器',
  every: '每',
  daily: '每天',
  'on changes': '变更时',
  'spec:': '规格：',
  'task:': '任务：',
  'no source': '无来源',
  autonomy: '自治',
  fired: '触发于',

  // ── Memory (additional) ──────────────────────────────────────────────────
  Wiki: 'Wiki',
  Rules: '规则',
  'Add rule': '添加规则',
  'Delete rule': '删除规则',
  'The project wiki is empty. Agents accumulate knowledge here as they run.':
    '项目 wiki 为空。智能体会在运行时在此累积知识。',
  'No knowledge events yet. Agents record what they learn here as runs progress.':
    '还没有知识事件。随着运行推进，智能体会在此记录所学。',

  // ── Workflows (additional) ───────────────────────────────────────────────
  'From a template': '从模板',
  'No workflows yet. Start from a template with “New”.': '还没有工作流。点「新建」从模板开始。',
  'Run this workflow (requires Bun)': '运行此工作流（需要 Bun）',
  'Delete workflow': '删除工作流',
  'Select a workflow script, or start one from a template to orchestrate multi-agent runs.':
    '选择一个工作流脚本，或从模板新建一个来编排多智能体运行。',

  // ── Commands (additional) ────────────────────────────────────────────────
  'No commands yet. Create one with “New” to save a reusable prompt.':
    '还没有命令。点「新建」创建一个以保存可复用的提示。',
  'Delete command': '删除命令',
  Recipe: '配方',
  'Interpolated with the text passed after the command when it runs.': '运行时会用命令后面传入的文本进行插值。',
  'Markdown prompt that agents and loops can invoke as': '智能体与循环可调用的 Markdown 提示，调用方式为',
  'Commands are reusable prompt recipes — “skills” you write once as markdown and the agents or loops invoke as /name. Create one to capture a prompt you run often.':
    '命令是可复用的提示配方——你以 Markdown 写一次的「技能」，智能体或循环以 /name 调用。新建一个来沉淀你常用的提示。',

  // ── Runs / cockpit (additional) ──────────────────────────────────────────
  'Hand a spec or a task to the loop. It plans, executes, verifies, and reports — you steer.':
    '把规格或任务交给循环。它会规划、执行、验证并汇报——由你引导。',
  'CLI:': 'CLI：',
  'autonomy:': '自治：',
  '∞ tokens': '∞ Token',
  'Token budget — the run stops once spent': 'Token 预算 —— 用尽后运行即停止',
  'Optional guidance…': '可选的引导…',
  'Queue message': '排入消息',
  'Delete run': '删除运行',
  Close: '关闭',
  Pause: '暂停',
  Resume: '恢复',
  Stop: '停止',
  'No content.': '无内容。',
  'No tasks yet — the planner will break the work down here.': '还没有任务——规划器会在此拆解工作。',
  'No reports yet — the reporter writes summaries here as the run progresses.':
    '还没有报告——随着运行推进，汇报器会在此撰写总结。',
  'No knowledge captured yet — agents record what they learn here.':
    '还没有沉淀知识——智能体会在此记录所学。',
  'Waiting for the first event…': '等待第一个事件…',
  live: '进行中',
  total: '总计',
  armed: '已布防',
  'Resume run': '恢复运行',
  'Automation:': '自动化：',
  auto: '自动',

  // ── Dev ──────────────────────────────────────────────────────────────────
  Env: '环境',
  'Rescan scripts': '重新扫描脚本',
  'No runnable scripts found in this workspace.': '此工作区未找到可运行的脚本。',
  Restart: '重启',
  Start: '启动',
  'Environment files': '环境文件',
  'No .env files in this workspace.': '此工作区没有 .env 文件。',
  'Open with': '用…打开',
  'Open workspace in': '在以下应用中打开工作区',
  change: '处改动',
  changes: '处改动',
};
