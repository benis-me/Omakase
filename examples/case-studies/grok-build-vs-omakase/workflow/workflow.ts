// name: zh-report-v2
// description: Crystallised from an auto run: Execute across 4 agent step(s).
// version: 0.1.0
// when_to_use: For goals shaped like the one this was saved from.
//
// Saved from a real run with `omks run --save-as`. The structure is what
// actually executed; the prompts are that run's, with its goal replaced by
// this workflow's own. Edit it freely — it is ordinary TypeScript.
import type { WorkflowContext } from '@omakase/engine';

export default async function zhReportV2(w: WorkflowContext): Promise<void> {
  await w.phase('Execute', async () => {
    const stepResults = new Map<string, string>();
    const step_s1_0 = await w.agent({
      role: 'researcher',
      title: '提炼素材并核实 grok-build 落点',
      prompt: `只读取 \`./findings-grok.md\` 与 \`./findings-omakase.md\` 提炼可写入报告的核心结论，先收敛到“一句话结论、两者各是什么、3-4 组关键对比、各自更强处、收尾”这个骨架。对每个拟写入的 grok-build 断言补上可落到具体 crate 或文件路径的证据；仅在某个细节不确定时，去 \`./grok-build/\` 定点读取那一个相关文件，禁止全量扫描源码。输出给后续步骤一份可直接写作的中文提纲、可用断言清单、对应路径清单，以及必须避免的含混表述。`,
      workflowStep: {
        id: 's1',
        dependsOn: [],
        sourcePrompt: `只读取 \`./findings-grok.md\` 与 \`./findings-omakase.md\` 提炼可写入报告的核心结论，先收敛到“一句话结论、两者各是什么、3-4 组关键对比、各自更强处、收尾”这个骨架。对每个拟写入的 grok-build 断言补上可落到具体 crate 或文件路径的证据；仅在某个细节不确定时，去 \`./grok-build/\` 定点读取那一个相关文件，禁止全量扫描源码。输出给后续步骤一份可直接写作的中文提纲、可用断言清单、对应路径清单，以及必须避免的含混表述。`,
      },
      provider: 'codex',
      model: 'gpt-5.4',
      permission: 'bypass',
    });
    if (step_s1_0.status !== 'ok') throw new Error('Step s1 failed: ' + step_s1_0.text);
    stepResults.set('s1', step_s1_0.text);
    const context_step_s2_1 = ['s1'].map((id) => stepResults.get(id)).filter((value): value is string => Boolean(value));
    const step_s2_1 = await w.agent({
      role: 'worker',
      as: 'zh-designer',
      title: '撰写精致简洁的单文件 HTML 报告',
      prompt: `使用 \`zh-designer\`，基于 s1 的提纲与证据，创建 \`./report-zh.html\`。要求：正文控制在 1800 汉字以内；明确写清“grok-build 自己就是 agent，Omakase 编排别人的 agent CLI”；只保留 3-4 组高价值对比；每个 grok-build 断言都带可核实的 \`code\` 路径；单文件、无任何外部资源、仅一种强调色、深浅色都可读、中文正文 line-height 约 1.75，靠留白和字号层级建立节奏，不堆边框和阴影；中文自然，不要翻译腔。` + (context_step_s2_1.length ? '\n\n--- Context from earlier steps ---\n' + context_step_s2_1.join('\n\n') : ''),
      workflowStep: {
        id: 's2',
        dependsOn: ['s1'],
        sourcePrompt: `使用 \`zh-designer\`，基于 s1 的提纲与证据，创建 \`./report-zh.html\`。要求：正文控制在 1800 汉字以内；明确写清“grok-build 自己就是 agent，Omakase 编排别人的 agent CLI”；只保留 3-4 组高价值对比；每个 grok-build 断言都带可核实的 \`code\` 路径；单文件、无任何外部资源、仅一种强调色、深浅色都可读、中文正文 line-height 约 1.75，靠留白和字号层级建立节奏，不堆边框和阴影；中文自然，不要翻译腔。`,
      },
      provider: 'codex',
      model: 'gpt-5.4',
      permission: 'bypass',
    });
    if (step_s2_1.status !== 'ok') throw new Error('Step s2 failed: ' + step_s2_1.text);
    stepResults.set('s2', step_s2_1.text);
    const context_step_s3_2 = ['s2'].map((id) => stepResults.get(id)).filter((value): value is string => Boolean(value));
    const step_s3_2 = await w.agent({
      role: 'reviewer',
      as: 'zh-critic',
      title: '只读审阅内容与版式克制性',
      prompt: `使用 \`zh-critic\` 只读审阅 \`./report-zh.html\`，重点检查：是否五分钟可读并记住三件事；结构是否清晰且不混淆两者定位；grok-build 的每个断言是否都能落到文中给出的 crate/文件路径；是否存在不必要展开、翻译腔、视觉堆砌、外部资源、深浅色可读性问题。输出具体修改意见，按优先级排序，避免泛泛表扬。` + (context_step_s3_2.length ? '\n\n--- Context from earlier steps ---\n' + context_step_s3_2.join('\n\n') : ''),
      workflowStep: {
        id: 's3',
        dependsOn: ['s2'],
        sourcePrompt: `使用 \`zh-critic\` 只读审阅 \`./report-zh.html\`，重点检查：是否五分钟可读并记住三件事；结构是否清晰且不混淆两者定位；grok-build 的每个断言是否都能落到文中给出的 crate/文件路径；是否存在不必要展开、翻译腔、视觉堆砌、外部资源、深浅色可读性问题。输出具体修改意见，按优先级排序，避免泛泛表扬。`,
      },
      provider: 'codex',
      model: 'gpt-5.4',
      permission: 'read-only',
    });
    if (step_s3_2.status !== 'ok') throw new Error('Step s3 failed: ' + step_s3_2.text);
    stepResults.set('s3', step_s3_2.text);
    const context_step_s4_3 = ['s3'].map((id) => stepResults.get(id)).filter((value): value is string => Boolean(value));
    const step_s4_3 = await w.agent({
      role: 'worker',
      as: 'zh-designer',
      title: '按审阅意见修订并定稿',
      prompt: `使用 \`zh-designer\` 根据 s3 的具体意见修订 \`./report-zh.html\` 并定稿。必须真的吸收审阅意见：继续压缩冗余、修正任何含混或证据不足的表述、优化版式层级与深浅色表现，保留单文件与无外链约束。完成后自检一次：正文是否仍在 1800 汉字以内、所有 grok-build 断言是否都有对应路径、HTML 是否可直接打开阅读。` + (context_step_s4_3.length ? '\n\n--- Context from earlier steps ---\n' + context_step_s4_3.join('\n\n') : ''),
      workflowStep: {
        id: 's4',
        dependsOn: ['s3'],
        sourcePrompt: `使用 \`zh-designer\` 根据 s3 的具体意见修订 \`./report-zh.html\` 并定稿。必须真的吸收审阅意见：继续压缩冗余、修正任何含混或证据不足的表述、优化版式层级与深浅色表现，保留单文件与无外链约束。完成后自检一次：正文是否仍在 1800 汉字以内、所有 grok-build 断言是否都有对应路径、HTML 是否可直接打开阅读。`,
      },
      provider: 'codex',
      model: 'gpt-5.4',
      permission: 'bypass',
    });
    if (step_s4_3.status !== 'ok') throw new Error('Step s4 failed: ' + step_s4_3.text);
    stepResults.set('s4', step_s4_3.text);
  });

  await w.loopUntil(async () => {
    const { met, gaps } = await w.goalMet();
    if (met || gaps.length === 0) return [];
    const fixes = await w.parallel(
      gaps.map((g) => () => w.agent({ role: 'worker', title: 'Fix gap', prompt: `Fix this gap so the goal is satisfied:\n${g}` })),
    );
    const failedFix = fixes.find((fix) => fix.status !== 'ok');
    if (failedFix) throw new Error(`Gap fix failed: ${failedFix.text}`);
    return gaps;
  }, { maxRounds: 2 });

  w.requestReport({ kind: 'final', title: 'zh-report-v2 complete', summary: 'zh-report-v2 completed 4 step(s).' });
}
