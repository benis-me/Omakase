# Agent Wiki Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the project wiki from an append-only entry/log view into a structured, agent-authored project knowledge base with durable pages and read-only API/web display.

**Architecture:** Keep `knowledge-events.json` as the traceable source and add a derived `wiki-pages` layer for product display. `FileKnowledgeStore` writes `wiki-pages.json` and `wiki-pages.md` whenever knowledge events or wiki entries change; read-only web surfaces the pages through `/api/wiki/pages` and uses them for the dashboard wiki region.

**Tech Stack:** TypeScript, Vitest, existing `@omakase/core` knowledge store, existing CLI read-only HTTP server.

---

### Task 1: Core Wiki Page Model

**Files:**
- Create: `packages/core/src/knowledge/pages.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/knowledge-events.test.ts`

- [x] **Step 1: Write failing tests**

Add tests proving `buildWikiPages()`:
- creates stable pages from agent-authored synthesis/fact/decision/risk events,
- excludes raw task/run log entries from the primary page bodies,
- renders markdown with source ids.

Run:

```bash
pnpm --filter @omakase/core test -- knowledge-events
```

Expected: FAIL because `buildWikiPages` is not exported.

- [x] **Step 2: Implement minimal page builder**

Create `WikiPage`, `buildWikiPages`, and `renderWikiPagesMarkdown`. Pages:
- `overview`
- `decisions`
- `risks`
- `verification`

Only include agent-authored synthesis/fact/decision/risk/report/progress events in page bodies. Preserve source event ids and agent ids for traceability.

- [x] **Step 3: Export the model**

Export functions/types from `packages/core/src/index.ts`.

- [x] **Step 4: Verify**

Run:

```bash
pnpm --filter @omakase/core test -- knowledge-events
```

Expected: PASS.

### Task 2: Durable Wiki Page Artifacts

**Files:**
- Modify: `packages/core/src/knowledge/store.ts`
- Test: `packages/core/tests/knowledge-store.test.ts`

- [x] **Step 1: Write failing tests**

Add tests proving `FileKnowledgeStore`:
- writes `wiki-pages.json` and `wiki-pages.md` after `saveKnowledgeEvents`,
- can load `wiki-pages.json`,
- refreshes pages after `mergeWiki` when only wiki entries exist.

Run:

```bash
pnpm --filter @omakase/core test -- knowledge-store
```

Expected: FAIL because the store has no wiki page APIs/artifacts.

- [x] **Step 2: Implement store methods**

Add `loadWikiPages()`, `saveWikiPages()`, and internal `refreshWikiPages()` to `FileKnowledgeStore`. Derive pages from knowledge events first; fall back to wiki entries when no events exist.

- [x] **Step 3: Verify**

Run:

```bash
pnpm --filter @omakase/core test -- knowledge-store
```

Expected: PASS.

### Task 3: Read-Only API/Web Display

**Files:**
- Modify: `packages/cli/src/read-only-server.ts`
- Test: `packages/cli/tests/read-only-server.test.ts`

- [x] **Step 1: Write failing tests**

Add tests proving:
- `/api/wiki/pages` returns structured pages,
- home HTML includes a `data-region="wiki-pages"` section,
- dashboard JavaScript fetches `/api/wiki/pages`.

Run:

```bash
pnpm --filter @omakase/cli test -- read-only-server
```

Expected: FAIL because the endpoint and region do not exist.

- [x] **Step 2: Implement API and display**

Add `wikiPages()` helper. Prefer pages from `knowledgeStore.loadWikiPages()` when available; fall back to markdown-derived single page. Render page cards in home and refresh them through polling.

- [x] **Step 3: Verify**

Run:

```bash
pnpm --filter @omakase/cli test -- read-only-server
```

Expected: PASS.

### Task 4: Full Verification

- [x] Run focused tests:

```bash
pnpm --filter @omakase/core test -- knowledge-events knowledge-store
pnpm --filter @omakase/cli test -- read-only-server
```

- [x] Run full checks:

```bash
pnpm check
git diff --check
```

- [x] Real-run note:

Do not call this fully live-closed unless a real agent run creates at least one agent-authored synthesis event and `wiki-pages.json` updates. If real multi-agent is unavailable, state the exact auth/preflight blocker.
