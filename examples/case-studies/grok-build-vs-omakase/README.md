# Grok-Build × Omakase

This is a real Omakase dogfood run, not a hand-written mock. The `auto`
workflow designed a four-step DAG, then executed it with the installed Codex
CLI:

1. distil the two codebase findings and verify exact Grok-Build paths;
2. draft the standalone Chinese report as the named `zh-designer` agent;
3. review it as the named, `read-only` `zh-critic` agent;
4. revise against the critique and pass a deterministic Bun verifier.

The successful run was crystallized into `zh-report-v2` and replayed without a
planning turn. The replay preserved the named agents, permission boundary and
DAG dependencies. The generated v0.1.0 workflow is preserved in
[`workflow/`](workflow/); it expects `findings-grok.md`, `findings-omakase.md`
and a `grok-build/` checkout in the target workspace.

See [report-zh.html](report-zh.html) for the final standalone artifact; it has
no external scripts, fonts, images, or network dependencies.
