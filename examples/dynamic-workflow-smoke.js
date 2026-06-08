export default async function workflow(w) {
  await w.phase('Real Agent Smoke', async () => {
    const result = await w.agent({
      title: 'Real dynamic workflow agent smoke',
      prompt: 'Reply with exactly: OMAKASE_DYNAMIC_WORKFLOW_REAL_AGENT_OK',
    });
    await w.updateWiki({
      kind: 'fact',
      title: 'Dynamic workflow real-agent smoke',
      body: result.text.slice(0, 500),
    });
  });
}
