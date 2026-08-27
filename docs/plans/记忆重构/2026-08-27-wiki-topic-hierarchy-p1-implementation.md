# Wiki 用途目录一期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Wiki 从「按来源分栏 + 摘要页」改成「用途两级目录 → 文件列表 → 打开原文件」，走通归档、查找、打开。

**Architecture:** V22 给 `wiki_sources` 加用途两列与资料 FTS；分类器只从当前主题树选节点，失败留待整理；归档不再默认写 `wiki_pages`。前端左栏换成用途树，主区是文件列表和目录选择器。二期 mutate/重编目、三期图谱新模型本计划不实现。

**Tech Stack:** TypeScript、SQLite FTS5 bigram、Vitest、React、既有 `shell.openPath`、Electron IPC `agentRuntime.sendCommand`

**Spec:** `docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md` §0–§7、§15 一期命令、§16 第一期、§18 一期成功标准

## Global Constraints

- 只做一期。禁止实现 `wiki:topic:mutate`、`wiki:reclassify:*`、`wiki:source:create-note`、综述改写 sources、新图谱模型
- 分类轴是用途树（做事记录/学习资料/…），不是技术/工作/生活，也不是 sources/media
- AI 不得新建大类/小类，不得写「临时存放」；拿不准 skip，条目留待整理
- `topic_path` 禁止拼接查询：一律 `topic_category` + `topic_subtopic` 两列；小类名可含 `/`
- 主题树 JSON 为有序 `{ version: 1, categories: [{ name, subtopics }] }`，不含「临时存放」
- `PARKING_CATEGORY = '临时存放'` 是代码常量
- 新归档不写 `wiki_pages`；存量页只从「⋯ 更多 → 历史页面」进入
- 切断 chat 摄入：`ingestChat` / `wiki_capture` 不得再写 inbox
- 用户可见文案中文；提交 Conventional Commit，如 `feat(wiki): ...`
- 验证：`pnpm --filter ./packages/agent-runtime test`（Wiki 相关）+ `pnpm --filter ./apps/windows test`（WikiTab 相关）+ `pnpm typecheck`

---

## File Map

| 文件 | 职责 |
|---|---|
| `packages/agent-runtime/src/storage/schema.ts` | V22 DDL |
| `packages/agent-runtime/src/storage/schema-wiki.test.ts` | V22 列/FTS 断言 |
| `packages/agent-runtime/src/wiki/wiki-topic-tree.ts` | 默认树、校验、读写辅助 |
| `packages/agent-runtime/src/wiki/wiki-topic-tree.test.ts` | 树校验与孤儿拒绝 |
| `packages/agent-runtime/src/wiki/types.ts` | WikiSource 新列；ClassifiedItem 迁走后的共用类型 |
| `packages/agent-runtime/src/wiki/wiki-repo.ts` | 主题读写、listSources 过滤、资料 FTS 检索、touchSource |
| `packages/agent-runtime/src/wiki/wiki-index.ts` | `wiki_sources_fts` upsert/rebuild/health |
| `packages/agent-runtime/src/wiki/wiki-classifier.ts` | 口诀提示词 + 封闭小类 + skip |
| `packages/agent-runtime/src/wiki/wiki-classifier.test.ts` | 改断言 |
| `packages/agent-runtime/src/wiki/wiki-organizer.ts` | 成功写主题、不写页；skip 不建 source |
| `packages/agent-runtime/src/wiki/wiki-organizer.test.ts` | 改期望 |
| `packages/agent-runtime/src/wiki/wiki-ingest-hook.ts` | `ingestChat` 直接返回 null |
| `packages/agent-runtime/src/tools/built-in/wiki-tools.ts` | capture 拒绝；search/read 资料层 |
| `apps/windows/src/shared/agent-runtime-commands.ts` | 新命令类型 |
| `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts` | handlers |
| `apps/windows/src/main/ipc/agent-runtime-ipc.ts` | switch |
| `apps/windows/src/main/app-ui-control/command-allowlist.ts` | 白名单 |
| `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts` | 新 IPC 封装 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiLeftNav.tsx` | 用途树 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiFileList.tsx` | 文件列表（新建） |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTopicPicker.tsx` | 目录选择器（新建） |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiInboxPanel.tsx` | 待补分 + 归档到 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx` | 导航状态机 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiMoreMenu.tsx` | 历史页面入口；隐藏编目/编辑树 |
| `apps/windows/src/test/components/WikiTab.test.tsx` | 更新交互测试 |

---

### Task 1: Schema V22

**Files:**
- Modify: `packages/agent-runtime/src/storage/schema.ts`
- Modify: `packages/agent-runtime/src/storage/schema-wiki.test.ts`
- Modify: `packages/agent-runtime/src/wiki/types.ts`（`WikiSource` 加列）

**Interfaces:**
- Produces: `SCHEMA_VERSION === 22`；`wiki_sources` 含 `topic_category` / `topic_subtopic` / `last_used` / `use_count`；`wiki_sources_fts` 虚表；ERO 三表含可空 `source_id`

- [ ] **Step 1: 写失败测试**

在 `schema-wiki.test.ts` 追加：

```ts
describe("wiki schema V22", () => {
  it("wiki_sources 有用途列与使用计数", () => {
    const db = createMigratedTestDb();
    const cols = db.prepare<{ name: string }>("PRAGMA table_info(wiki_sources)").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      "topic_category", "topic_subtopic", "last_used", "use_count",
    ]));
    expect(db.prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name = 'wiki_sources_fts'",
    ).get()?.name).toBe("wiki_sources_fts");
    expect(SCHEMA_VERSION).toBe(22);
    db.close();
  });

  it("ERO 表有可空 source_id", () => {
    const db = createMigratedTestDb();
    for (const table of ["wiki_entities", "wiki_observations", "wiki_relations"]) {
      const cols = db.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      expect(cols, table).toContain("source_id");
    }
    db.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
pnpm --filter ./packages/agent-runtime exec vitest run src/storage/schema-wiki.test.ts
```

Expected: `SCHEMA_VERSION` 仍为 21 或列不存在。

- [ ] **Step 3: 最小实现**

`SCHEMA_VERSION = 22`。`MIGRATIONS` 追加：

```ts
[
  22,
  `
ALTER TABLE wiki_sources ADD COLUMN topic_category TEXT;
ALTER TABLE wiki_sources ADD COLUMN topic_subtopic TEXT;
ALTER TABLE wiki_sources ADD COLUMN last_used TEXT;
ALTER TABLE wiki_sources ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_wiki_sources_topic
  ON wiki_sources (agent_id, user_id, topic_category, topic_subtopic);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_sources_fts USING fts5(
  title_tokens,
  content_tokens
);

ALTER TABLE wiki_entities ADD COLUMN source_id TEXT;
ALTER TABLE wiki_observations ADD COLUMN source_id TEXT;
ALTER TABLE wiki_relations ADD COLUMN source_id TEXT;
CREATE INDEX IF NOT EXISTS idx_wiki_entities_source ON wiki_entities (source_id);
CREATE INDEX IF NOT EXISTS idx_wiki_observations_source ON wiki_observations (source_id);
`,
],
```

`wiki_sources_fts` 做成与 `wiki_pages_fts` 一样的独立虚表（不要 `content='wiki_sources'`，避免外置 content 触发器）。rowid 与 `wiki_sources.rowid` 对齐，由 `WikiIndexRepo` 维护。

`WikiSource` 增加：

```ts
readonly topic_category: string | null;
readonly topic_subtopic: string | null;
readonly last_used: string | null;
readonly use_count: number;
```

`createSource` 的 SELECT/INSERT 暂把新列写成默认 `NULL` / `0`（Task 2 再写主题）。从 DB 读出的 `findSourceById` / `listSources` 用 `SELECT *`，映射时补默认值以防旧测试行。

- [ ] **Step 4: 跑测试通过**

同上 vitest 命令。Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add packages/agent-runtime/src/storage/schema.ts packages/agent-runtime/src/storage/schema-wiki.test.ts packages/agent-runtime/src/wiki/types.ts
git commit -m "feat(wiki): add V22 topic columns and sources FTS"
```

---

### Task 2: 主题树模块与 Repo 读写

**Files:**
- Create: `packages/agent-runtime/src/wiki/wiki-topic-tree.ts`
- Create: `packages/agent-runtime/src/wiki/wiki-topic-tree.test.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.test.ts`
- Modify: `packages/agent-runtime/src/wiki/index.ts`（导出）

**Interfaces:**
- Consumes: `WikiRepo.getIndexMeta` / `setIndexMeta`
- Produces:

```ts
export const PARKING_CATEGORY = "临时存放";
export const TOPIC_CATEGORIES_META_KEY = "topic_categories";

export interface WikiTopicTree {
  version: 1;
  categories: Array<{ name: string; subtopics: string[] }>;
}

export const DEFAULT_TOPIC_TREE: WikiTopicTree = {
  version: 1,
  categories: [
    { name: "做事记录", subtopics: ["项目/任务资料", "会议聊天记录", "汇报总结文稿", "规则制度文档", "数据统计报表", "对外沟通材料"] },
    { name: "学习资料", subtopics: ["课堂&课程笔记", "读书摘抄整理", "调研搜集材料", "考试备考资料", "知识思维导图", "行业专题材料"] },
    { name: "计划与复盘", subtopics: ["目标规划方案", "日程待办清单", "风险预案", "收支预算测算", "经历复盘总结", "备选方案记录"] },
    { name: "证件凭据", subtopics: ["合同协议文件", "证件扫描副本", "票据收据凭证", "保险相关资料", "个人履历档案", "申请证明材料"] },
    { name: "模板参考", subtopics: ["各类文档模板", "PPT与表单素材", "范文案例参考", "图片媒体素材", "工具使用参考", "文案脚本素材"] },
    { name: "随笔创作", subtopics: ["原创作品底稿", "灵感随手记录", "爱好相关笔记", "生活感悟随笔", "作品修改草稿"] },
  ],
};

export function parseTopicTree(json: string | null): WikiTopicTree | null;
export function validateTopicTree(tree: unknown): tree is WikiTopicTree;
/** 正式节点；parking 时 subtopic 必须为 null */
export function validateTopicAssignment(
  tree: WikiTopicTree,
  category: string,
  subtopic: string | null,
  opts?: { allowParking?: boolean },
): { ok: true } | { ok: false; reason: string };
export function treeHasOrphans(
  tree: WikiTopicTree,
  occupied: ReadonlyArray<{ category: string; subtopic: string }>,
): boolean;
```

Repo 新增（名称必须一致，后续 Task 依赖）：

```ts
getOrCreateTopicTree(): WikiTopicTree
setTopicTree(tree: WikiTopicTree): void  // 有孤儿则 throw
listSourcesByTopic(agentId, userId, filter: {
  category?: string;
  subtopic?: string;
  parking?: boolean;
  unfiled?: boolean;
  mediaType?: WikiMediaType;
}): WikiSource[]
updateSourceTopic(sourceId: string, category: string, subtopic: string | null): WikiSource
touchSource(sourceId: string): void  // last_used=now, use_count+1
```

- [ ] **Step 1: 写失败测试**（`wiki-topic-tree.test.ts`）

```ts
it("默认树含 6 个大类且不含临时存放", () => {
  expect(DEFAULT_TOPIC_TREE.categories).toHaveLength(6);
  expect(DEFAULT_TOPIC_TREE.categories.map((c) => c.name)).not.toContain(PARKING_CATEGORY);
});

it("拒绝把临时存放写进树", () => {
  expect(validateTopicTree({
    version: 1,
    categories: [{ name: PARKING_CATEGORY, subtopics: [] }],
  })).toBe(false);
});

it("允许小类名含斜杠", () => {
  expect(validateTopicAssignment(DEFAULT_TOPIC_TREE, "做事记录", "项目/任务资料")).toEqual({ ok: true });
});

it("parking 只能 category=临时存放 且 subtopic=null", () => {
  expect(validateTopicAssignment(DEFAULT_TOPIC_TREE, PARKING_CATEGORY, null, { allowParking: true }))
    .toEqual({ ok: true });
  expect(validateTopicAssignment(DEFAULT_TOPIC_TREE, PARKING_CATEGORY, "x", { allowParking: true }).ok)
    .toBe(false);
});
```

Repo 测试：`getOrCreateTopicTree` 空库写入默认树；`setTopicTree` 在已有 `做事记录/会议聊天记录` 文件时删掉该小类应 throw。

- [ ] **Step 2: 跑测试确认失败**

```powershell
pnpm --filter ./packages/agent-runtime exec vitest run src/wiki/wiki-topic-tree.test.ts src/wiki/wiki-repo.test.ts
```

- [ ] **Step 3: 实现**

校验规则（与 spec §2.2 一致）：`version===1`；≥1 个大类；大名唯一、1–20 字、无控制字符、≠临时存放；小类无重复、1–32 字、允许 `/` `&`；整树 set 时若 `occupied` 出现树中没有的 `(category,subtopic)` 则拒绝。

`listSourcesByTopic`：

- `parking: true` → `topic_category = '临时存放' AND topic_subtopic IS NULL`
- `unfiled: true` → 两列皆 NULL（且不要和 parking 同时用）
- 仅 `category` → `topic_category = ? AND topic_subtopic IS NOT NULL`
- `category`+`subtopic` → 等值匹配（不要 `LIKE '做事记录/%'`）
- 可选 `mediaType`
- 排除 `archived_at IS NOT NULL`

`updateSourceTopic` 先 `validateTopicAssignment(..., { allowParking: true })`，再 UPDATE。

`createSource` INSERT 补上新列（默认 null/0），返回对象带这些字段。

- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit** `feat(wiki): add topic tree helpers and source topic queries`

---

### Task 3: 分类器改为用途二元组

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-classifier.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-classifier.test.ts`
- Modify: `packages/agent-runtime/src/wiki/index.ts`（若导出 ClassifiedItem）

**Interfaces:**
- Consumes: `WikiTopicTree`、`validateTopicAssignment`
- Produces:

```ts
export interface ClassifiedItem {
  readonly inboxId: string;
  readonly category: string | null;
  readonly subtopic: string | null;
  readonly skip?: boolean;
  readonly reason?: string;
  readonly degraded?: true;
  readonly degradeReason?: string;
}

export function buildClassifyPrompt(
  items: readonly WikiInboxItem[],
  topicTree: WikiTopicTree,
): string;

export function parseClassifyResponse(
  response: string,
  items: readonly WikiInboxItem[],
  topicTree: WikiTopicTree,
): readonly ClassifiedItem[];

export async function classifyBatch(
  items: readonly WikiInboxItem[],
  callLLM: (prompt: string) => Promise<string>,
  topicTree: WikiTopicTree,
): Promise<readonly ClassifiedItem[]>;
```

删除对 `path` / `title` / `summaryMd` / `validateWikiPath` / `AI_WRITABLE_CATEGORIES` 的分类写入依赖（`validateWikiPath` 可留着给历史页导出，分类器不再调用）。

- [ ] **Step 1: 改测试为新契约**

`buildClassifyPrompt` 必须包含「做事记录」「口诀」「项目/任务资料」，且**不得**包含 `sources/`、`临时存放`。

`parseClassifyResponse`：

- 合法 `{"id":"i1","category":"学习资料","subtopic":"课堂&课程笔记","skip":false}` → 写入这两列
- `skip: true` 或空类 → `{ skip: true, degraded: true, category: null, subtopic: null }`
- 自造小类「深度学习」→ skip/degraded
- 模型漏答的 inboxId → skip/degraded
- 不再生成 `inbox/<id>` path

- [ ] **Step 2: 跑测试确认失败**

```powershell
pnpm --filter ./packages/agent-runtime exec vitest run src/wiki/wiki-classifier.test.ts
```

- [ ] **Step 3: 实现提示词**

按 spec §3.1 原文结构拼接：口诀、易混、可选目录（遍历 `topicTree.categories` 渲染 `- 做事记录：项目/任务资料、…`）、规则、JSON 输出。`extractJsonPayload` 原样保留。

校验：`skip===true` 或 assignment 失败 → `degraded: true`，不抛。`classifyBatch` 把 `topicTree` 传入 prompt 与 parse。LLM 抛错仍向上抛（organizer 记 failed），不要再 fallbackAll 成 inbox 页。

- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit** `feat(wiki): classify by purpose tree with skip fallback`

---

### Task 4: 归档流水线不写摘要页

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-organizer.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-organizer.test.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-index.ts`

**Interfaces:**
- Consumes: `classifyBatch(items, llm, tree)`、`repo.getOrCreateTopicTree()`、`repo.updateSourceTopic` 或 `createSource` 带主题、`WikiIndexRepo.upsertSourceRow`
- Produces: 成功归档 = source 有主题 + inbox organized + FTS；skip = 不建 source、inbox 记失败可重试、不写 wiki_pages

`WikiIndexRepo` 增加：

```ts
upsertSourceRow(rowid: number | bigint, title: string, extractedText: string | null): void
deleteSourceRow(rowid: number | bigint): void
rebuildSourceFts(repo: { listAllSourceRowids(): ... }): number
checkSourceFtsHealth(): WikiFtsHealth
```

`rebuildFts`（页面）保留给历史页。`wiki:index:rebuild`（Task 7）两者都跑。

- [ ] **Step 1: 改 organizer 测试**

现有「上传 3 条 → 3 个页面」改为：

```ts
it("上传 3 条 → 3 条 sources 带主题、inbox organized、不新建 wiki_pages", async () => {
  // mock LLM 返回用途 JSON
  // expect(pages.filter(p => p.editor === 'ai' && created in this run)). 用整理前后 page 计数差 === 0
  // sources 每条 topic_category/subtopic 非空
});

it("skip 条目保持 pending/failed 且不建 source", async () => {
  // LLM 返回 skip:true
  // inbox 非 organized；sources 不增加
});
```

「越权分类降级到 inbox/」改为「越权 → 不写主题、条目可重试」。

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

`organizeBatch`：enrich 后 `const tree = this.repo.getOrCreateTopicTree()`，`classifyBatch(enriched, this.callLLM, tree)`。

循环：

```ts
if (result.skip || result.degraded || !result.category || !result.subtopic) {
  this.repo.markInboxAttemptFailed(item.id, result.degradeReason ?? result.reason ?? "无法归类");
  failed += 1;
  // detail path 用空字符串；outcome = "degraded" 或 "failed"
  continue;
}
const source = this.repo.createSource({ ..., title: item.title /* 不用 AI 标题 */ });
this.repo.updateSourceTopic(source.id, result.category, result.subtopic);
this.upsertSourceFts(source);
this.repo.markInboxOrganized(item.id, source.id);
// 禁止 savePage / attachMediaIfApplicable（附件挂页是旧模型）
```

`createSource` 后取 rowid：

```ts
const rowid = this.db.prepare<{ rowid: number }>(
  "SELECT rowid AS rowid FROM wiki_sources WHERE id = ?",
).get(source.id)!.rowid;
this.index.upsertSourceRow(rowid, source.title, source.extracted_text);
```

需要给 `WikiOrganizer` 注入 `WikiIndexRepo`，或让 `WikiRepo` 封装 `upsertSourceFts`。优先 **WikiRepo 封装**，避免 organizer 直接碰 db：`repo.indexSource(sourceId: string): void`。

运行摘要文案：「N 项已归档 · M 项无法归类留在待整理」，不要再写「降级到 inbox/」。

- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit** `feat(wiki): archive into topic columns without summary pages`

---

### Task 5: 切断聊天摄入

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-ingest-hook.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-organizer.test.ts`（ingestChat 相关）
- Modify: `packages/agent-runtime/src/tools/built-in/wiki-tools.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge-wiki-tools.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge-wiki-tools.test.ts`

**Interfaces:**
- Produces: `ingestChat` 永不写库；`wiki_capture` 对用户/模型返回明确中文错误

- [ ] **Step 1: 测试**

```ts
it("ingestChat 返回 null 且 inbox 不增加", () => {
  const before = repo.listInbox(...).length;
  expect(hook.ingestChat("ag", "u", "对话", "标题")).toBeNull();
  expect(repo.listInbox(...).length).toBe(before);
});
```

`wiki_capture` 测试：期望 `ok: false` 且文案含「不收录对话」。

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**

```ts
ingestChat(): string | null {
  return null;
}
```

`wiki_capture` handler / tool execute：`return { error: "Wiki 只收录文件与文档，不再收录对话消息。请上传会议纪要等文件。" }`，不要调用 ingestChat。

保留 `WikiInboxItemType` 的 `"chat"` 以读存量行，但 organizer 的 takeInboxBatch 对 `chat` 可跳过或整理时直接 discard。一期最简单：**take 时仍可能扫到旧 chat，classify 全 skip**；同时 `ingestChat` 不再新增。

- [ ] **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(wiki): stop ingesting chat messages`

---

### Task 6: 资料层检索

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.ts`（`searchSources`）
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.test.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-index.ts`
- Modify: `packages/agent-runtime/src/wiki/index.ts`

**Interfaces:**

```ts
export interface WikiSourceSearchHit {
  readonly source: WikiSource;
  readonly snippet: string;
}

searchSources(agentId: string, userId: string, keyword: string, limit = 10): readonly WikiSourceSearchHit[]
```

查询构造复制现有 `search()` 的 bigram + 引号转义 + AND。JOIN `wiki_sources_fts` ON `wiki_sources.rowid`。排除 `archived_at`。命中后 `touchSource`。

`index:rebuild` 内部：现有 `rebuildFts()` + `rebuildSourceFts()`（从 `SELECT rowid, title, extracted_text FROM wiki_sources` 灌入）。

- [ ] **Step 1: 测试** 插入一条带 extracted_text 的 source，index 后搜中文片段能命中；空 keyword 返回 []。
- [ ] **Step 2: 失败**
- [ ] **Step 3: 实现**（页面 `search()` 保留给历史页面视图，不要删）
- [ ] **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(wiki): index and search wiki_sources extracted text`

---

### Task 7: IPC 命令全链路

**Files:**
- Modify: `apps/windows/src/shared/agent-runtime-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.test.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts`
- Modify: `apps/windows/src/main/app-ui-control/command-allowlist.ts`
- Modify: `apps/windows/src/main/app-ui-control/command-allowlist.test.ts`（若有枚举快照）
- Modify: `packages/agent-runtime/src/tools/built-in/wiki-tools.ts`（search 走 searchSources）

**Interfaces:** 下列命令必须加入联合类型、discriminated result、handler、ipc switch、allowlist。

```ts
{ type: 'wiki:topic:tree:get'; agentId: string; userId?: string }
// result: { tree: WikiTopicTree }

{ type: 'wiki:topic:tree:set'; agentId: string; userId?: string; tree: WikiTopicTree }
// result: { success: true } 或 throw

{ type: 'wiki:source:list'; agentId: string; userId?: string;
  category?: string; subtopic?: string; parking?: boolean; unfiled?: boolean; mediaType?: WikiMediaType }
// result: { sources: Array<{
//   id, title, sourcePath, mediaType, topicCategory, topicSubtopic, updatedAt, useCount
// }> }

{ type: 'wiki:source:update-topic'; agentId: string; sourceId: string; category: string; subtopic: string | null }
{ type: 'wiki:source:move-to-parking'; agentId: string; sourceId: string }
{ type: 'wiki:source:open'; agentId: string; sourceId: string }
// result: { success: true } ；失败 throw 中文「无法打开原文件：…」

// 改：wiki:inbox:organize
{ type: 'wiki:inbox:organize'; inboxId: string; category: string; subtopic: string; title?: string }
// result: { sourceId: string; category: string; subtopic: string }  // 不再返回 pageId/path

// 改：wiki:search 主结果改为资料
{ type: 'wiki:search'; keyword: string; limit?: number; agentId?: string; sessionKey?: string }
// result: Array<{ sourceId, title, category, subtopic, snippet, mediaType, sourcePath, updatedAt }>
```

`wiki:source:open`：读 `source_path`，`fs.existsSync`，`await shell.openPath(abs)`；openPath 返回非空字符串视为失败（与 Electron API 一致）。成功则 `touchSource`。路径相对时按 `bridge.getCwd()` resolve（同 `files-commands.ts`）。

`wiki:inbox:organize`：**不要** `savePage`。`createSource` + `updateSourceTopic` + `markInboxOrganized` + `indexSource`。`organize` 不允许 `category === PARKING_CATEGORY`。

`wiki:inbox:count`：pending inbox 数 + unfiled sources 数（角标）。可新增 `wiki:inbox:count` 返回 `{ total, pending, unfiled }`，旧 `{ total }` 兼容则 `total = pending + unfiled`。

`tree:get`：`getOrCreateTopicTree()`。userId 缺省 `LOCAL_USER_ID`。

- [ ] **Step 1: wiki-commands.test.ts** 用现有 bridge fixture：set 默认树；createSource 后 update-topic；list 按「做事记录/项目/任务资料」能滤出；非法小类 organize throw；open 对缺失文件 throw。
- [ ] **Step 2: 失败（类型未加）**
- [ ] **Step 3: 实现 handlers + switch + allowlist**
- [ ] **Step 4: `pnpm --filter ./apps/windows test` 中 wiki-commands 相关 + typecheck**
- [ ] **Step 5: Commit** `feat(wiki): add topic tree and source list IPC`

---

### Task 8: useWikiPage 封装

**Files:**
- Modify: `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts`
- Modify: `apps/windows/src/renderer/hooks/business/useWikiPage/index.ts`（导出新类型）

**Interfaces:**

```ts
export interface WikiTopicTree { version: 1; categories: Array<{ name: string; subtopics: string[] }> }
export interface WikiSourceListItem {
  id: string
  title: string
  sourcePath: string | null
  mediaType: string
  topicCategory: string | null
  topicSubtopic: string | null
  updatedAt: number
  useCount: number
}
export interface WikiSourceSearchHit {
  sourceId: string
  title: string
  category: string | null
  subtopic: string | null
  snippet: string
  mediaType: string
  sourcePath: string | null
  updatedAt: number
}

// hook 增加：
loadTopicTree(): Promise<WikiTopicTree>
listSources(filter): Promise<WikiSourceListItem[]>
updateSourceTopic(...)
moveToParking(sourceId)
openSource(sourceId): Promise<void>  // 失败把 error 交给调用方
organizeInbox(inboxId, category, subtopic)
searchSources(keyword): Promise<WikiSourceSearchHit[]>
```

搜索主框改走 `searchSources`。旧 `WikiSearchHit`（pageId）仅历史页面内部搜索保留。

- [ ] **Step 1–4:** 若 hook 无单测，用 WikiTab 测试覆盖；有则补 hook 测试。
- [ ] **Step 5: Commit** `feat(wiki-ui): expose topic and source commands in useWikiPage`

---

### Task 9: 左栏树 + 文件列表 + 选择器 + 待整理/临时存放

**Files:**
- Modify: `WikiLeftNav.tsx`、`WikiTab.tsx`、`WikiTab.css`、`WikiInboxPanel.tsx`、`WikiMoreMenu.tsx`、`WikiTopBar.tsx`
- Create: `WikiFileList.tsx`、`WikiTopicPicker.tsx`
- Modify: `apps/windows/src/test/components/WikiTab.test.tsx`
- Modify: 新建或扩展 `WikiFileList.test.tsx` / `WikiTopicPicker.test.tsx`

**Interfaces:**

```ts
export type WikiNav =
  | { kind: 'inbox' }
  | { kind: 'parking' }
  | { kind: 'graph' }
  | { kind: 'history' }
  | { kind: 'cleanup' }
  | { kind: 'synthesis' }
  | { kind: 'category'; name: string }
  | { kind: 'subtopic'; category: string; subtopic: string }
```

**选择器 `WikiTopicPicker`：** 两级：大类按钮 → 小类按钮；确认回调 `(category, subtopic)`；无自由输入；不列出临时存放。

**WikiFileList：** 行 = 图标 + 文件名 + 相对时间 + 打开 / 移动 / 存到临时存放。顶栏可选 media 芯片：全部 / 文档 / 图片 / 音视频。打开调用 `openSource`，失败 toast/文案「无法打开原文件」。

**WikiLeftNav：** 固定区：待整理（警示角标）、知识图谱、临时存放。其下按 `tree.categories` 渲染大类（可折叠；点标题选 `kind:'category'`；chevron 只折叠）。小类全部渲染（count=0 也可点）。计数来自一次 `listSources` 全量或专门 count——一期可 `listSources({})` 在 renderer `useMemo` 分组（个人库体量可接受）。

**Inbox：** 两段。上：现有 inbox 行，待处理/失败加「归档到…」打开 Picker，成功后 `organizeInbox`。下：`unfiled` sources，「归档到…」走 `updateSourceTopic`。副文案：「系统还在归档或无法自动归类的文件」。

**Parking：** `listSources({ parking: true })`，副文案：「你主动搁置、暂不进入正式目录的文件」。行：打开、移出（Picker → updateTopic）。

**更多：** 保留清理、重建；综述入口可留（旧页面合成，不改算法）；**增加「历史页面」** → `kind:'history'` 用现有 `WikiPageList` + `WikiDetailDrawer`。不要放「全库重新编目」「编辑主题树」。

**图谱：** 仍进现有 `WikiGraphView`。可在空状态加一句「新归档的文件请用左侧目录浏览」。

**搜索：** 顶栏结果用 `WikiFileList` 形态（带 大类/小类），点打开原文件。

**不要**对资料行再开详情侧滑。侧滑只服务历史页面。

- [ ] **Step 1: 组件测试**

`WikiLeftNav`：渲染「做事记录」「项目/任务资料」「待整理」「临时存放」。

`WikiTopicPicker`：选「证件凭据」后出现「合同协议文件」；提交回调参数为这两段中文，不是 path split。

`WikiTab`：mock `listSources` 返回一条会议纪要；点小类后主区出现文件名；不要再出现「资料」「多媒体」一级项。

- [ ] **Step 2: 失败（旧 nav 仍在）**
- [ ] **Step 3: 实现 UI**
- [ ] **Step 4:** `pnpm --filter ./apps/windows test` 中 Wiki 组件测试
- [ ] **Step 5: Commit** `feat(wiki-ui): replace source/media nav with purpose topic tree`

---

### Task 10: 清理列表展示主题 + 回归

**Files:**
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/CleanupView.tsx`（展示 `大类 / 小类` 若 source 带得到；没有则「待补分」）
- 视 `wiki:cleanup:scan` 返回值是否含 topic：可在 handler 里附带 `topicCategory`/`topicSubtopic`（一期只读展示，不加「移到临时存放」按钮——那是二期）
- Modify: 任何因 ClassifiedItem 改形而红的测试（`wiki-organize-queue`、CLI 若有）

- [ ] **Step 1: 全量 Wiki 测试**

```powershell
pnpm --filter ./packages/agent-runtime exec vitest run src/wiki src/storage/schema-wiki.test.ts
pnpm --filter ./apps/windows exec vitest run src/test/components src/main/ipc/agent-runtime/wiki-commands.test.ts src/main/agent-runtime/bridge-wiki-tools.test.ts
pnpm typecheck
```

- [ ] **Step 2: 修编译与测试**
- [ ] **Step 3: Commit** `test(wiki): fix regressions after purpose-tree archive`

**手测清单（执行者必做，写进 PR）：**

1. 上传一份会议纪要 → 待整理消失 → `做事记录 / 会议聊天记录` 能打开原文件
2. 让分类失败（或 mock skip）→ 文件仍在待整理，临时存放计数不变
3. 「归档到」手动选 `证件凭据 / 合同协议文件`
4. 「存到临时存放」再移出
5. 搜索正文片段能打开
6. 历史页面仍能打开旧摘要
7. 待整理与临时存放副文案可区分

---

## Spec coverage（一期）

| Spec | Task |
|---|---|
| V22 两列 + FTS + ERO source_id + last_used | 1 |
| 有序默认用途树、set 禁孤儿 | 2 |
| 口诀分类器、封闭小类、skip 留待整理 | 3 |
| 归档不写编目卡 | 4 |
| 切断 chat | 5 |
| 资料 FTS 检索 | 6 |
| tree get/set、source list/update/parking/open、inbox organize | 7–8 |
| 左栏树、点大类/小类、选择器、待补分、媒体芯片、历史页 | 9 |
| 打开失败提示、角标含待补分 | 7+9 |
| mutate / reclassify / 笔记 / 新综述 / 新图谱 | **不做** |

## 不做（防止执行时膨胀）

- `wiki:topic:mutate`、重新编目候选、新建笔记
- 综述 accept 改写 sources
- 图谱结构边 / `mentioned_in`
- 向量改挂 sources
- 清理「移到临时存放」批量动作
- 把 wiki_pages 再塞进用途树
