# Codegraph Knowledge Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make codegraph output useful as project knowledge by deriving a durable Project Structure wiki page from codegraph snapshots.

**Architecture:** Keep `CodeGraph` as the source for syntactic dependency data and add a small summary layer that ranks dependency hubs, entry-like files, external dependencies, and cycles. Feed that summary into `buildWikiPages()` so `FileKnowledgeStore.saveCodegraph()` refreshes `wiki-pages.json/md` and read-only web/TUI knowledge surfaces can show code structure without parsing raw graph JSON.

**Tech Stack:** TypeScript, Vitest, existing `CodeGraph`, `FileKnowledgeStore`, and `WikiPage` model.

---

### Task 1: Codegraph Summary Model

**Files:**
- Modify: `packages/core/src/knowledge/codegraph.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/codegraph.test.ts`

- [x] **Step 1: Write failing tests**

Add tests proving `CodeGraph.summary()` returns stable ranked project knowledge:
- stats,
- top dependency hubs by dependent count,
- entry-like files with no internal dependents,
- top external dependencies,
- detected cycles.

Run:

```bash
pnpm --filter @omakase/core test -- codegraph
```

Expected: FAIL because `CodeGraph.summary()` does not exist.

- [x] **Step 2: Implement summary**

Add `CodeGraphSummary`, `CodeGraphHotspot`, and `CodeGraphExternalDependency` types plus a `summary()` method. Keep the method deterministic by sorting by count descending and then path/name ascending.

- [x] **Step 3: Verify**

Run:

```bash
pnpm --filter @omakase/core test -- codegraph
```

Expected: PASS.

### Task 2: Wiki Page Integration

**Files:**
- Modify: `packages/core/src/knowledge/pages.ts`
- Modify: `packages/core/src/knowledge/store.ts`
- Test: `packages/core/tests/knowledge-store.test.ts`

- [x] **Step 1: Write failing tests**

Add a test proving `FileKnowledgeStore.saveCodegraph()` refreshes `wiki-pages.json/md` with a `codegraph` page containing file count, internal edges, dependency hubs, entry files, external dependencies, and cycles.

Run:

```bash
pnpm --filter @omakase/core test -- knowledge-store
```

Expected: FAIL because saving codegraph does not refresh wiki pages and `WikiPageId` has no `codegraph` page.

- [x] **Step 2: Implement page generation**

Extend `WikiPageId` with `codegraph`. Let `buildWikiPages()` accept an optional `CodeGraphSnapshot`, derive `CodeGraph.fromJSON(snapshot).summary()`, and append a Project Structure page. Update `FileKnowledgeStore.refreshWikiPages()` and `saveCodegraph()`.

- [x] **Step 3: Verify**

Run:

```bash
pnpm --filter @omakase/core test -- knowledge-store
```

Expected: PASS.

### Task 3: Focused And Full Verification

- [x] **Step 1: Focused tests**

Run:

```bash
pnpm --filter @omakase/core test -- codegraph knowledge-store knowledge-events
pnpm --filter @omakase/cli test -- read-only-server
```

Expected: PASS.

- [x] **Step 2: Full checks**

Run:

```bash
pnpm check
git diff --check
```

Expected: PASS.

- [x] **Step 3: Real run verification**

Run a real `codex` no-edit task through `scripts/omakase.sh run --json --cwd /Users/ben/Projects/Omakase2 --mode normal --agent codex`, then verify `.omakase/wiki-pages.json` contains the `codegraph` page and project structure content.
