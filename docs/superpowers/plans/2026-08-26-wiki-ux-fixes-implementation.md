# Wiki UX 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Wiki 默认视图、待整理计数、多媒体误分类、归档日志过粗、清理批量勾选不便（问题 1–5）。

**Architecture:** 最小补丁。UI 改 WikiTab/CleanupView；待整理用 `listInbox('pending')` + 新 `countInbox`；分类在 `parseClassifyResponse` 后按 `media_type` 硬纠正；`wiki_organize_runs` 增 `result_detail` JSON，Organizer 写逐条明细，运行日志可展开。

**Tech Stack:** TypeScript、Vitest、React、SQLite schema 迁移（SCHEMA_VERSION 21）、现有 Electron IPC `agentRuntime.sendCommand`。

**Spec:** `docs/superpowers/specs/2026-08-26-wiki-ux-fixes-design.md`

## Global Constraints

- 本轮不做：综述 AI 自动合成、知识图谱改造、历史 media 误分类迁移、清理分页、从日志回滚。
- 中文 UI 文案；函数级注释；2 空格缩进；Conventional Commits。
- `pet-core` 不改；改动限于 `packages/agent-runtime` 的 wiki/schema 与 `apps/windows` 的 wiki UI/IPC。
- `result_detail` JSON 固定为 `{"items":[...]}`；旧行为 null 时只显示摘要。
- 角标与标题必须用 `countInbox`，禁止用列表 length 冒充总数。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/agent-runtime/src/storage/schema.ts` | V21：`result_detail` 列 |
| `packages/agent-runtime/src/wiki/types.ts` | `WikiOrganizeRun.result_detail`；明细类型可放此或 classifier |
| `packages/agent-runtime/src/wiki/wiki-repo.ts` | `countInbox`；`finishRun`/`listRuns` 读写 `result_detail` |
| `packages/agent-runtime/src/wiki/wiki-classifier.ts` | 提示词 + 非多媒体强制改 `sources/` |
| `packages/agent-runtime/src/wiki/wiki-organizer.ts` | 组装 `result_detail` 并 finishRun |
| `apps/windows/src/shared/agent-runtime-commands.ts` | `wiki:inbox:count`；runs 返回 `resultDetail` |
| `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts` | handlers |
| `apps/windows/src/main/ipc/agent-runtime-ipc.ts` | switch case |
| `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts` | countInbox；WikiRunItem.resultDetail |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx` | 默认 sources；pending 列表；日志展开 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/CleanupView.tsx` | 筛选/全选/一键归档 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.css` | 日志展开与清理 chips 样式 |
| 对应 `*.test.ts(x)` | 单测 |

---

### Task 1: 默认资料列表 + 待整理计数对齐

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.ts`（在 `listInbox` 旁新增 `countInbox`）
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.test.ts`
- Modify: `apps/windows/src/shared/agent-runtime-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.test.ts`
- Modify: `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts`
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx`
- Test: `apps/windows/src/test/components/WikiTab.test.tsx`（若已有默认视图断言则更新）

**Interfaces:**
- Consumes: 现有 `listInbox(agentId, userId, status?, limit?)`
- Produces:
  - `WikiRepo.countInbox(agentId: string, userId: string, status?: WikiInboxStatus): number`
  - Command `{ type: 'wiki:inbox:count'; agentId?: string; sessionKey?: string; status?: 'pending' | 'organized' | 'discarded' }` → `{ total: number }`
  - `useWikiPage().countInbox(status?: string): Promise<number>`

- [ ] **Step 1: 写失败的 countInbox 单测**

在 `wiki-repo.test.ts` 增加：

```typescript
it("countInbox 按 status 计数且不受 list LIMIT 影响", () => {
  const repo = new WikiRepo(createMigratedTestDb());
  for (let i = 0; i < 5; i++) {
    repo.ingestToInbox({
      agentId: "ag",
      userId: "u",
      itemType: "upload",
      title: `t${i}`,
      mediaType: "document",
      sourcePath: `/tmp/f${i}`,
      contentHash: `h${i}`,
    });
  }
  const [first] = repo.listInbox("ag", "u", "pending");
  repo.markInboxOrganized(first!.id, "src-fake");
  expect(repo.countInbox("ag", "u", "pending")).toBe(4);
  expect(repo.countInbox("ag", "u")).toBe(5);
});
```

（若 `markInboxOrganized` 需要真实 sourceId，先 `createSource` 再 mark；按现有测试文件范式调整。）

- [ ] **Step 2: 运行单测确认失败**

Run: `pnpm --filter ./packages/agent-runtime test -- wiki-repo.test.ts -t "countInbox"`

Expected: FAIL（`countInbox` 不存在）

- [ ] **Step 3: 实现 countInbox**

在 `wiki-repo.ts` 的 `listInbox` 后：

```typescript
/** 收件箱条数；不传 status 则计全部状态 */
countInbox(agentId: string, userId: string, status?: WikiInboxStatus): number {
  const row = status
    ? this.db
        .prepare<{ c: number }>(
          `SELECT COUNT(*) AS c FROM wiki_inbox WHERE agent_id = ? AND user_id = ? AND status = ?`,
        )
        .get(agentId, userId, status)
    : this.db
        .prepare<{ c: number }>(
          `SELECT COUNT(*) AS c FROM wiki_inbox WHERE agent_id = ? AND user_id = ?`,
        )
        .get(agentId, userId);
  return row?.c ?? 0;
}
```

- [ ] **Step 4: 跑通 repo 单测**

Run: `pnpm --filter ./packages/agent-runtime test -- wiki-repo.test.ts -t "countInbox"`

Expected: PASS

- [ ] **Step 5: 增加 IPC 命令类型与 handler**

`agent-runtime-commands.ts`：

```typescript
export interface WikiInboxCountCommand {
  readonly type: 'wiki:inbox:count'
  readonly sessionKey?: string
  readonly agentId?: string
  readonly status?: 'pending' | 'organized' | 'discarded'
}
```

加入 `AgentRuntimeCommand` 联合类型；结果映射：

```typescript
: T extends 'wiki:inbox:count' ? { total: number }
```

`wiki-commands.ts`：

```typescript
/** 返回收件箱条数（角标用，不受 list LIMIT 影响） */
export function handleWikiInboxCount(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:inbox:count' }>,
): { total: number } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  return { total: bridge.wikiRepo.countInbox(agentId, LOCAL_USER_ID, command.status) }
}
```

`agent-runtime-ipc.ts`：在 `wiki:inbox:list` case 旁增加 `wiki:inbox:count` → `handleWikiInboxCount`。

在 `wiki-commands.test.ts` 增加断言：ingest 2 pending + 1 organized 后 `handleWikiInboxCount(..., { status: 'pending' }).total === 2`。

- [ ] **Step 6: hook + WikiTab 默认视图与 pending 对齐**

`useWikiPage.ts` 增加：

```typescript
const countInbox = useCallback(async (status?: string): Promise<number> => {
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand) return 0
  try {
    const r = (await api.sendCommand({
      type: 'wiki:inbox:count',
      status: status as 'pending' | 'organized' | 'discarded' | undefined,
    })) as { total: number }
    return typeof r?.total === 'number' ? r.total : 0
  } catch {
    return 0
  }
}, [])
```

并从 hook 返回 `countInbox`。

`WikiTab.tsx`：

```typescript
const [category, setCategory] = useState<WikiCategory | null>('sources')
const [rightView, setRightView] = useState<RightView>('page')
// ...
const refreshInbox = useCallback(async () => {
  const [all, total] = await Promise.all([listInbox('pending'), countInbox('pending')])
  setInboxItems(all)
  setPendingCount(total)
}, [listInbox, countInbox])
```

标题改为：

```tsx
<h3>待整理（{pendingCount}）</h3>
{inboxItems.length < pendingCount && (
  <p className="wiki-empty-hint">仅显示最近 {inboxItems.length} 条</p>
)}
```

确保 `useWikiPage` 解构包含 `countInbox`。

若 `WikiTab.test.tsx` 断言默认 inbox，改为断言默认资料列表（sources）。

- [ ] **Step 7: 提交**

```bash
git add packages/agent-runtime/src/wiki/wiki-repo.ts packages/agent-runtime/src/wiki/wiki-repo.test.ts \
  apps/windows/src/shared/agent-runtime-commands.ts \
  apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts \
  apps/windows/src/main/ipc/agent-runtime/wiki-commands.test.ts \
  apps/windows/src/main/ipc/agent-runtime-ipc.ts \
  apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts \
  apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx \
  apps/windows/src/test/components/WikiTab.test.tsx
git commit -m "$(cat <<'EOF'
fix(wiki): 默认资料列表并对齐待整理计数

EOF
)"
```

---

### Task 2: 多媒体分类硬规则

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-classifier.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-classifier.test.ts`
- Modify: `packages/agent-runtime/src/wiki/types.ts`（若扩展 `ClassifiedItem` 导出）

**Interfaces:**
- Consumes: `WikiInboxItem.media_type`；现有 `ClassifiedItem`
- Produces: 扩展后的 `ClassifiedItem`：
  - `corrected?: true`
  - `correctReason?: string`（纠正时为 `non_media_forced_to_sources`）
  - 纠正时 **不** 设 `degraded`

- [ ] **Step 1: 写失败单测**

在 `wiki-classifier.test.ts`：

```typescript
it("document 落 media/ 时纠正为 sources/ 并标记 corrected", () => {
  const items = [
    {
      id: "i1",
      agent_id: "a",
      user_id: "u",
      item_type: "upload" as const,
      source_path: null,
      source_url: null,
      title: "规格书",
      content_preview: "正文",
      media_type: "document" as const,
      status: "pending" as const,
      attempt_count: 0,
      last_error: null,
      organized_source_id: null,
      content_hash: null,
      created_at: "now",
      organized_at: null,
    },
  ];
  const res = parseClassifyResponse(
    JSON.stringify([{ id: "i1", path: "media/spec", title: "规格书", summaryMd: "s" }]),
    items,
  );
  expect(res[0]!.path).toBe("sources/spec");
  expect(res[0]!.corrected).toBe(true);
  expect(res[0]!.correctReason).toBe("non_media_forced_to_sources");
  expect(res[0]!.degraded).toBeUndefined();
});

it("image 落 media/ 保持不变", () => {
  const items = [
    {
      id: "i1",
      agent_id: "a",
      user_id: "u",
      item_type: "upload" as const,
      source_path: null,
      source_url: null,
      title: "截图",
      content_preview: null,
      media_type: "image" as const,
      status: "pending" as const,
      attempt_count: 0,
      last_error: null,
      organized_source_id: null,
      content_hash: null,
      created_at: "now",
      organized_at: null,
    },
  ];
  const res = parseClassifyResponse(
    JSON.stringify([{ id: "i1", path: "media/shot", title: "截图", summaryMd: "s" }]),
    items,
  );
  expect(res[0]!.path).toBe("media/shot");
  expect(res[0]!.corrected).toBeUndefined();
});
```

（若 `parseClassifyResponse` 未导出，改为导出或测 `classifyBatch` + mock LLM。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter ./packages/agent-runtime test -- wiki-classifier.test.ts -t "document 落 media"`

Expected: FAIL（path 仍为 media/spec）

- [ ] **Step 3: 扩展 ClassifiedItem 与校验逻辑**

`ClassifiedItem` 增加：

```typescript
readonly corrected?: true;
readonly correctReason?: string;
```

`buildClassifyPrompt` 中分类说明改为：

```typescript
"- sources/：文档类资料，默认落点（所有 document 必须落这里）",
"- media/：仅图片/音频/视频索引页；禁止把文档放进 media/",
"- inbox/：无法判定归属时的兜底落点",
```

在 `parseClassifyResponse` 里，当 `allowed` 且拼出结果后，调用：

```typescript
/** 非多媒体禁止落 media/：保留 slug，顶层改为 sources/ */
function applyMediaTypeGuard(item: WikiInboxItem, result: ClassifiedItem): ClassifiedItem {
  const top = result.path.split("/")[0];
  const isMultimedia = item.media_type === "image" || item.media_type === "audio" || item.media_type === "video";
  if (top !== "media" || isMultimedia) return result;
  const slug = result.path.split("/").slice(1).join("/") || item.id;
  return {
    ...result,
    path: `sources/${slug}`,
    corrected: true,
    correctReason: "non_media_forced_to_sources",
    degraded: undefined,
    degradeReason: undefined,
  };
}
```

对每条 push 前 `results.push(applyMediaTypeGuard(item, {...}))`。漏答兜底的 inbox/ 路径无需纠正。

- [ ] **Step 4: 跑通 classifier 单测**

Run: `pnpm --filter ./packages/agent-runtime test -- wiki-classifier.test.ts`

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/agent-runtime/src/wiki/wiki-classifier.ts packages/agent-runtime/src/wiki/wiki-classifier.test.ts
git commit -m "$(cat <<'EOF'
fix(wiki): 非多媒体禁止落入 media 分类

EOF
)"
```

---

### Task 3: 归档运行日志 result_detail

**Files:**
- Modify: `packages/agent-runtime/src/storage/schema.ts`（SCHEMA_VERSION 21 + V21 迁移）
- Modify: `packages/agent-runtime/src/storage/schema-wiki.test.ts`
- Modify: `packages/agent-runtime/src/wiki/types.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.test.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-organizer.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-organizer.test.ts`
- Modify: `packages/agent-runtime/src/wiki/index.ts`（若导出新类型）
- Modify: `apps/windows/src/shared/agent-runtime-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`
- Modify: `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts`
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx`
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.css`

**Interfaces:**
- Produces:
  - `WikiOrganizeRunDetailItem`：
    ```typescript
    {
      inboxId: string;
      title: string;
      path: string;
      mediaType: WikiMediaType;
      outcome: "archived" | "corrected" | "degraded" | "failed";
      reason?: string;
      extract: "preview" | "extracted" | "none";
    }
    ```
  - `result_detail` 存 `JSON.stringify({ items: WikiOrganizeRunDetailItem[] })`
  - `finishRun(id, status, resultSummary?, error?, resultDetail?)`
  - IPC runs 项增加 `resultDetail: { items: ... } | null`

- [ ] **Step 1: 写 schema 迁移失败测**

`schema-wiki.test.ts`：

```typescript
it("V21 wiki_organize_runs 含 result_detail 列", () => {
  const db = createMigratedTestDb();
  const cols = db
    .prepare<{ name: string }>("PRAGMA table_info(wiki_organize_runs)")
    .all()
    .map((c) => c.name);
  expect(cols).toContain("result_detail");
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(21);
  db.close();
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `pnpm --filter ./packages/agent-runtime test -- schema-wiki.test.ts -t "result_detail"`

Expected: FAIL

- [ ] **Step 3: 实现 V21 迁移**

`schema.ts`：

```typescript
export const SCHEMA_VERSION = 21;
```

在 migrations 数组末尾追加：

```typescript
// V21: 归档运行日志逐条明细（JSON {"items":[...]}）
[
  21,
  `ALTER TABLE wiki_organize_runs ADD COLUMN result_detail TEXT;`,
],
```

同时更新文件顶部 V16 `CREATE TABLE wiki_organize_runs` 定义中的列列表 **不必** 改（新库走迁移链也会 ADD）；若项目有「新库直建最终形态」惯例则同步加列——本仓库以迁移链为准，只 ADD 即可。

- [ ] **Step 4: 跑通 schema 测**

Run: `pnpm --filter ./packages/agent-runtime test -- schema-wiki.test.ts -t "result_detail"`

Expected: PASS

- [ ] **Step 5: 扩展类型与 repo finishRun/listRuns**

`types.ts` 增加 `WikiOrganizeRunDetailItem` 与 `WikiOrganizeRun.result_detail: string | null`。

`WikiRunRow` 增加 `result_detail: string | null`；`runRowToRun` 透传。

```typescript
finishRun(
  id: string,
  status: WikiOrganizeRunStatus,
  resultSummary?: string,
  error?: string,
  resultDetail?: string,
): void {
  this.db
    .prepare(
      `UPDATE wiki_organize_runs
       SET status = ?, result_summary = ?, error = ?, result_detail = ?, finished_at = ?
       WHERE id = ?`,
    )
    .run(
      status,
      resultSummary ?? null,
      error ?? null,
      resultDetail ?? null,
      new Date().toISOString(),
      id,
    );
}
```

`createRun` 返回对象带 `result_detail: null`。

单测：`finishRun` 写入 detail 后 `listRuns` 能读回。

- [ ] **Step 6: Organizer 组装明细**

在 `organizeBatch` 中：

1. 记录每条 enrich 前是否已有 `content_preview` → `extract: 'preview' | 'extracted' | 'none'`（enrich 后仍无正文则为 `none`；enrich 前有则为 `preview`；enrich 前无、后有则为 `extracted`）。
2. 循环 classified 时推入 detail items：
   - 成功且 `corrected` → `outcome: 'corrected'`，`reason: correctReason`
   - 成功且 `degraded` → `outcome: 'degraded'`
   - 成功否则 → `outcome: 'archived'`
   - catch → `outcome: 'failed'`，`path` 可用 result.path 或空，`reason: err.message`
3. classify 整批 throw：对本批每个 item 写 `failed`，`finishRun(..., detailJson)`。
4. summary 文案示例：

```typescript
const corrected = detailItems.filter((d) => d.outcome === "corrected").length;
const summary = [
  `${organized} 项已归档`,
  corrected > 0 ? `其中 ${corrected} 项纠正到 sources/` : "",
  degraded > 0 ? `其中 ${degraded} 项分类降级到 inbox/` : "",
  failed > 0 ? `${failed} 项待重试` : "",
].filter(Boolean).join(" · ");
```

5. `finishRun(run.id, status, summary, error, JSON.stringify({ items: detailItems }))`

更新 `wiki-organizer.test.ts`：成功归档后 `result_detail` 含对应 inboxId 与 path；document 被纠正时 outcome 为 corrected（可与 Task 2 联测）。

- [ ] **Step 7: IPC + hook + UI 展开**

`handleWikiRunsList` 映射：

```typescript
resultDetail: r.result_detail
  ? (JSON.parse(r.result_detail) as { items: unknown[] })
  : null,
```

（解析失败时返回 null，避免整列表炸掉。）

Commands 结果类型为 runs 增加 `resultDetail: { items: readonly { inboxId: string; title: string; path: string; mediaType: string; outcome: string; reason?: string; extract: string }[] } | null`。

`WikiRunItem` 同步增加 `resultDetail`。

`WikiTab` 运行日志：

```tsx
{runs.map((run) => (
  <RunLogItem key={run.id} run={run} />
))}
```

实现可展开组件（可内联在 WikiTab）：点击 header 切换 `expanded`；展开后 map `run.resultDetail?.items` 显示 `title → path`、outcome 标签、reason、extract。

CSS：`.wiki-run-detail-item`、outcome 色点（失败红、纠正橙、降级黄）。

- [ ] **Step 8: 跑相关测试**

Run:

```bash
pnpm --filter ./packages/agent-runtime test -- wiki-organizer.test.ts wiki-repo.test.ts schema-wiki.test.ts
pnpm --filter ./apps/windows test -- wiki-commands.test.ts
```

Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add packages/agent-runtime/src/storage/schema.ts \
  packages/agent-runtime/src/storage/schema-wiki.test.ts \
  packages/agent-runtime/src/wiki/types.ts \
  packages/agent-runtime/src/wiki/wiki-repo.ts \
  packages/agent-runtime/src/wiki/wiki-repo.test.ts \
  packages/agent-runtime/src/wiki/wiki-organizer.ts \
  packages/agent-runtime/src/wiki/wiki-organizer.test.ts \
  packages/agent-runtime/src/wiki/index.ts \
  apps/windows/src/shared/agent-runtime-commands.ts \
  apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts \
  apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts \
  apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx \
  apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.css
git commit -m "$(cat <<'EOF'
feat(wiki): 归档运行日志写入可展开明细

EOF
)"
```

---

### Task 4: 清理筛选 / 全选 / 一键归档

**Files:**
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/CleanupView.tsx`
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.css`（或 Cleanup 共用类）
- Test: 若无 CleanupView 测试，新增 `apps/windows/src/test/components/CleanupView.test.tsx`；否则用轻量逻辑单测抽纯函数

**Interfaces:**
- Consumes: 现有 `cleanupScan` / `archiveSources` / `deleteSources` / `restoreSources`
- Produces: 无新 IPC；纯 UI

- [ ] **Step 1: 抽出筛选纯函数并写测**

在 `CleanupView.tsx` 同文件或旁路 `cleanupSelection.ts`：

```typescript
export type CleanupReasonFilter = "all" | WikiCleanupSuggestionItem["reason"];

/** 按原因筛选清理建议 */
export function filterCleanupSuggestions(
  items: readonly WikiCleanupSuggestionItem[],
  reason: CleanupReasonFilter,
): readonly WikiCleanupSuggestionItem[] {
  if (reason === "all") return items;
  return items.filter((i) => i.reason === reason);
}
```

测试：

```typescript
it("filterCleanupSuggestions 按 reason 过滤", () => {
  const items = [
    { sourceId: "a", title: "A", reason: "stale" as const },
    { sourceId: "b", title: "B", reason: "broken_source" as const },
  ];
  expect(filterCleanupSuggestions(items, "stale")).toHaveLength(1);
  expect(filterCleanupSuggestions(items, "all")).toHaveLength(2);
});
```

- [ ] **Step 2: 跑测确认（先红后绿若函数尚未导出）**

Run: `pnpm --filter ./apps/windows test -- CleanupView` 或对应测试文件

- [ ] **Step 3: 实现 CleanupView UI**

状态：

```typescript
const [reasonFilter, setReasonFilter] = useState<CleanupReasonFilter>("all")
const [confirmArchiveAll, setConfirmArchiveAll] = useState(false)
const [confirmDelete, setConfirmDelete] = useState(false)
const visible = filterCleanupSuggestions(suggestions, reasonFilter)
const allVisibleSelected =
  visible.length > 0 && visible.every((s) => selected.has(s.sourceId))
```

工具栏：

- chips：全部 / 长期未用 / 来源失效 / 内容重复 → `setReasonFilter`
- 按钮「全选当前」：`setSelected(new Set(visible.map(s => s.sourceId)))`；若已全选则 `setSelected(new Set())`
- 筛选变更时：若 `allVisibleSelected` 为真，重算为新 visible 的 id 集合（用 effect：当 reasonFilter 变且 prev 是全选态时）——实现上更简单：筛选变更清空勾选（与「扫描刷新清空」一致也可接受）。**本计划采用：筛选变更时清空勾选**，避免半选歧义。
- 「一键归档全部建议」：`setConfirmArchiveAll(true)`；确认后 `archiveSources(suggestions.map(s => s.sourceId))` 再 `runScan`
- 批量删除：先 `setConfirmDelete(true)`，确认后 `deleteSources([...selected])`

引入 `ConfirmModal`（与 WikiTab 相同组件）。

文案：

- 一键：`将归档 ${suggestions.length} 条清理建议，确定？`
- 删除：`将永久删除已选 ${selected.size} 条，不可恢复`

- [ ] **Step 4: 手动/组件测要点**

- 筛选后列表变短；全选只勾可见项。
- 一键归档确认调用全部 suggestions 的 sourceId（不受筛选）。
- 删除无确认不调用。

- [ ] **Step 5: 提交**

```bash
git add apps/windows/src/renderer/pages/MemoriesPage/components/CleanupView.tsx \
  apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.css \
  apps/windows/src/test/components/CleanupView.test.tsx
git commit -m "$(cat <<'EOF'
feat(wiki): 清理支持筛选全选与一键归档

EOF
)"
```

---

## Spec Coverage Checklist

| Spec 节 | Task |
|---|---|
| §2 默认资料列表 | Task 1 |
| §3 待整理计数与列表 | Task 1 |
| §4 多媒体硬规则 | Task 2 |
| §5 运行日志明细 | Task 3 |
| §6 清理批量 | Task 4 |
| §7 非目标 | 无任务（刻意不做） |

## Plan Self-Review

- 无 TBD/占位步骤；`result_detail` 形状与角标计数策略与 spec 自审后约定一致。
- `finishRun` 签名在 Task 3 定义，organizer/IPC 使用同一五参形式。
- `corrected` 与 `degraded` 互斥由 `applyMediaTypeGuard` 保证。
