# Wiki 用途目录二期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在一期「用途两级目录」之上补齐编目质量与合成能力：用户可改主题树骨架、可让 AI 重新编目并审阅候选、可在目录里新建笔记、综述产出变成目录里的普通文件、清理与向量检索都改挂 `wiki_sources`。

**Architecture:** 主题树编辑是「先改 `wiki_index_meta.topic_categories` JSON，再级联 `UPDATE wiki_sources` 两列」的单事务操作，删除必须带 `disposition`。重新编目是候选态：`wiki_index_meta.reclassify_run` 单条覆盖式存 runId + status + candidates，`running` 期间暂停自动 organize，用户接受后才写主题两列。综述沿用 `wiki_syntheses` 候选表，但 `accept` 从「写 `wiki_pages`」改成「落盘 md + `createSource` + 写主题两列」。向量层新增 `wiki_source_embeddings` 派生表，与资料 FTS 做 RRF，失败显式降级。

**Tech Stack:** TypeScript、SQLite（FTS5 bigram + 线性余弦向量）、Vitest、React、Electron IPC `agentRuntime.sendCommand`、`shell.openPath`

**Spec:** `docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md` §5.1 二期段、§6.2 二期列、§8–§12、§15 二期命令、§16 第二期、§18 二期成功标准

---

## 前置状态（实施前必读）

一期计划 `2026-08-27-wiki-topic-hierarchy-p1-implementation.md` **全部 10 个 Task 已完成**（截至 `ece2beb`）。二期直接在此基础上开工，无门禁。

| 一期 Task | 交付物 |
|---|---|
| 1 Schema V22 | `SCHEMA_VERSION = 22`；`wiki_sources` 有 `topic_category`/`topic_subtopic`/`last_used`/`use_count`；`wiki_sources_fts`、ERO `source_id` |
| 2 主题树 + Repo | `wiki-topic-tree.ts`；`getOrCreateTopicTree` / `setTopicTree` / `listSourcesByTopic` / `updateSourceTopic` / `touchSource` |
| 3 分类器 | `buildClassifyPrompt(items, tree)`、`ClassifiedItem` 用途二元组 |
| 4 归档不写页 | `cb20a29` |
| 5 切断 chat | `1f180d1` |
| 6 资料层检索 | `searchSources`、`rebuildSourceFts` |
| 7 IPC 全链路 | `4cfe994` |
| 8 useWikiPage 封装 | `941fc8c` |
| 9 左栏树 / 文件列表 / 选择器 / 待整理两段 | `11951c4`：`WikiFileList.tsx`、`WikiTopicPicker.tsx`、`WikiLeftNav` 用途树 + `topicCountKey` |
| 10 清理展示主题 + 回归 | `ece2beb`：`CleanupView` 显示 `大类 / 小类`；stale 规则已改看 `last_used`/`use_count` |

### 二期要对接的既有签名（verbatim，勿凭记忆改写）

```ts
// WikiLeftNav.tsx —— WikiNav 与计数 key 都定义在这里，不在 WikiTab
export type WikiNav =
  | { kind: 'inbox' } | { kind: 'parking' } | { kind: 'graph' } | { kind: 'history' }
  | { kind: 'cleanup' } | { kind: 'synthesis' }
  | { kind: 'category'; name: string }
  | { kind: 'subtopic'; category: string; subtopic: string }

/** 两列分组计数 key：JSON.stringify([category])（大类聚合）或 JSON.stringify([category, subtopic]) */
export function topicCountKey(category: string, subtopic?: string | null): string

interface WikiLeftNavProps {
  active: WikiNav | { kind: 'more' }
  tree: WikiTopicTree | null
  pendingCount: number
  parkingCount: number
  topicCounts: Record<string, number>          // 注意是 Record，不是 Map
  moreButtonRef?: React.RefObject<HTMLButtonElement>
  onSelect: (nav: WikiNav) => void
  onOpenMore: () => void
}
```

```ts
// WikiTopicPicker.tsx —— onConfirm 的 subtopic 是 string（非空），临时存放不在选项里
interface WikiTopicPickerProps {
  open: boolean
  tree: WikiTopicTree | null
  title?: string          // 默认「归档到…」
  itemTitle?: string
  onCancel: () => void
  onConfirm: (category: string, subtopic: string) => void
}
```

```ts
// WikiFileList.tsx —— 当前无多选、无批量条、无顶栏动作槽
interface WikiFileListProps {
  items: readonly WikiSourceListItem[]
  emptyHint: string
  showTopic?: boolean
  moveLabel?: string          // 临时存放视图传「移出」
  showParkAction?: boolean
  showMediaChips?: boolean
  onOpen: (item: WikiSourceListItem) => void
  onMove: (item: WikiSourceListItem) => void
  onPark?: (item: WikiSourceListItem) => void
}
```

```ts
// WikiMoreMenu.tsx —— 二期需要新增三个回调；当前只有四项
interface WikiMoreMenuProps {
  readonly open: boolean
  readonly anchorRef?: React.RefObject<HTMLButtonElement>
  readonly onClose: () => void
  readonly onHistory: () => void
  readonly onCleanup: () => void
  readonly onSynthesis: () => void
  readonly onRebuild: () => void
}
```

```ts
// useWikiPage.ts —— 一期已交付的主题/资料 API
loadTopicTree(): Promise<WikiTopicTree | null>
setTopicTree(tree: WikiTopicTree): Promise<boolean>
listSources(filter): Promise<readonly WikiSourceListItem[]>
updateSourceTopic(sourceId: string, category: string, subtopic: string | null): Promise<boolean>
moveToParking(sourceId: string): Promise<boolean>
openSource(sourceId: string): Promise<void>
searchSources(keyword: string, limit?: number): Promise<readonly WikiSourceSearchHit[]>  // 裸数组
```

```ts
// WikiTab.tsx —— 选择器复用这个目标联合类型，二期加分支时沿用
type PickerTarget =
  | { mode: 'inbox'; item: WikiInboxItem }
  | { mode: 'source'; item: WikiSourceListItem }
```

**其它现状：** `useWikiTaskCenter.ts` 的 `WikiTaskKind = 'archive' | 'cleanup' | 'synthesis' | 'rebuild' | 'graph'`（无 `reclassify`）。`CleanupView` 已有批量归档/恢复/删除，**无**「移到临时存放」。`WikiCleanupSuggestion` **无** `suggestedAction` 字段。测试文件已存在：`WikiFileList.test.tsx`、`WikiTopicPicker.test.tsx`、`WikiTab.test.tsx`、`useWikiTaskCenter.test.ts`。

---

## Global Constraints

- 只做二期。禁止实现三期：`wiki:graph:data` 新模型、`wiki:ero:extract`、结构/实体图层、`mentioned_in`
- **AI 永不改主题树**：`wiki:topic:mutate` 只由用户 UI 触发；分类器与重新编目都只能选**当前树**已有节点
- **AI 永不写「临时存放」**：`PARKING_CATEGORY` 只允许用户路径（`update-topic`、`move-to-parking`、清理批量动作、mutate disposition）写入
- 主题一律 `topic_category` + `topic_subtopic` 两列。**禁止** `大类/小类` 拼接串做主键、查询键或 `split('/')`（小类名含 `/` 与 `&`）
- 删除大类/小类必须带 `disposition`，无 disposition 且有文件 → 拒绝并返回 `fileCount`。整树 `tree:set` 仍禁孤儿
- 每 agent+user **同时只允许一个** `reclassify_run`；`running` 时暂停自动 organize（新文件仍进 inbox pending，不丢）
- 重新编目**不扫描** inbox 未完成、待补分（主题两列 NULL）、临时存放
- 综述 `accept` 后产出是 `wiki_sources` 一行（普通文件），**不写** `wiki_pages`。旧 `accept`（写页）仅保留给历史页面路径的存量记录
- 新建笔记写磁盘 md + `wiki_sources`，**不写** `wiki_pages`
- 向量失败/关闭一律显式降级到 FTS，界面写明原因，禁止静默降级
- 用户可见文案中文；提交 Conventional Commit，如 `feat(wiki): ...`
- 验证：`pnpm --filter ./packages/agent-runtime test`（Wiki 相关）+ `pnpm --filter ./apps/windows test`（Wiki 相关）+ `pnpm typecheck`

---

## File Map

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/agent-runtime/src/storage/schema.ts` | V23：`wiki_source_embeddings` | 改 |
| `packages/agent-runtime/src/wiki/wiki-topic-mutate.ts` | mutation 校验 + 级联计划 | 新建 |
| `packages/agent-runtime/src/wiki/wiki-topic-mutate.test.ts` | 九种 op 规则 | 新建 |
| `packages/agent-runtime/src/wiki/wiki-topic-tree.ts` | 导出 mutation 类型 | 改 |
| `packages/agent-runtime/src/wiki/wiki-repo.ts` | `applyTopicMutation` 事务、`countSourcesByTopic`、`bulkUpdateSourceTopic`、`getReclassifyRun`/`setReclassifyRun`、`listSourcesForReclassify`、`acceptSynthesisAsSource` | 改 |
| `packages/agent-runtime/src/wiki/wiki-reclassifier.ts` | 候选生成、状态机推进 | 新建 |
| `packages/agent-runtime/src/wiki/wiki-reclassifier.test.ts` | 状态机 + 非法候选丢弃 | 新建 |
| `packages/agent-runtime/src/wiki/wiki-organizer.ts` | `running` 时跳过 organize | 改 |
| `packages/agent-runtime/src/wiki/wiki-synthesizer.ts` | `synthesizeSources` + `acceptAsSource` | 改 |
| `packages/agent-runtime/src/wiki/wiki-cleanup.ts` | stale 改看 `last_used`/`use_count` | 改 |
| `packages/agent-runtime/src/wiki/wiki-source-vector.ts` | 资料向量 upsert/rebuild/search | 新建 |
| `packages/agent-runtime/src/wiki/index.ts` | 导出 | 改 |
| `apps/windows/src/shared/agent-runtime-commands.ts` | 二期命令类型 | 改 |
| `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts` | handlers | 改 |
| `apps/windows/src/main/ipc/agent-runtime-ipc.ts` | switch | 改 |
| `apps/windows/src/main/app-ui-control/command-allowlist.ts` | 白名单 | 改 |
| `apps/windows/src/main/agent-runtime/bridge.ts` | `wikiReclassifier`、organize 轮询判暂停、note 落盘 deps | 改 |
| `.../hooks/business/useWikiPage/useWikiPage.ts` | 二期 IPC 封装 | 改 |
| `.../MemoriesPage/components/WikiTopicTreeEditor.tsx` | 主题树编辑弹层 | 新建 |
| `.../MemoriesPage/components/WikiReclassifyView.tsx` | 候选主区列表 | 新建 |
| `.../MemoriesPage/components/WikiTopicPicker.tsx` | 增「让 AI 建议」可选 props | 改 |
| `.../MemoriesPage/components/WikiFileList.tsx` | `headerActions` 槽 + 可选多选 props | 改 |
| `.../MemoriesPage/components/WikiLeftNav.tsx` | `WikiNav` 增 `reclassify` kind | 改 |
| `.../MemoriesPage/components/WikiMoreMenu.tsx` | 新增三项：全库重编目 / 编辑主题树 / 从当前目录生成综述 | 改 |
| `.../MemoriesPage/components/CleanupView.tsx` | 「移到临时存放」批量动作 | 改 |
| `.../MemoriesPage/components/WikiTab.tsx` | 新导航分支、弹层状态、多选状态、批量条组装 | 改 |
| `.../MemoriesPage/components/useWikiTaskCenter.ts` | `reclassify` task kind | 改 |

---

### 建议实施顺序

无门禁，但任务间有真实依赖，按下列顺序推可以让每一步都能独立手测：

```
Task 1 (mutation 纯函数)
  └─ Task 2 (落库事务 + IPC)
       └─ Task 3 (编辑器 UI)              ← 可独立验收：改树
Task 4 (编目状态机)
  ├─ Task 5 (organize 互斥)
  └─ Task 6 (编目 IPC + 候选 UI)          ← 依赖 Task 3 的「重新编目受影响小类」复选框
Task 7 (新建笔记)                          ← 只依赖一期，可随时插入
Task 8 (综述改产资料)
  └─ Task 9 (多选 + 清理「移到临时存放」)   ← 多选给 Task 8 供输入
Task 10 (资料向量 + RRF)                   ← 独立，破坏 wiki:search 形状，建议最后做
Task 11 (菜单亮灯 + 回归)
```

Task 1/4/7/10 的 runtime 部分互不相干，可并行分给不同执行者。Task 3、6、9 都动 `WikiTab.tsx` 与 `WikiMoreMenu.tsx`，**串行执行**避免冲突。

---

### Task 1: 主题树 mutation 运行时（§8.1 / §8.2）

**Files:**
- Create: `packages/agent-runtime/src/wiki/wiki-topic-mutate.ts`
- Create: `packages/agent-runtime/src/wiki/wiki-topic-mutate.test.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-topic-tree.ts`（复用名称校验，导出 `isValidCategoryName` / `isValidSubtopicName`）
- Modify: `packages/agent-runtime/src/wiki/index.ts`

**Interfaces:**

```ts
export type FileDisposition =
  | { type: 'parking' }
  | { type: 'move'; category: string; subtopic: string };

export type WikiTopicMutation =
  | { op: 'addCategory'; name: string; index?: number }
  | { op: 'renameCategory'; from: string; to: string }
  | { op: 'deleteCategory'; name: string; disposition?: FileDisposition }
  | { op: 'reorderCategories'; names: string[] }
  | { op: 'addSubtopic'; category: string; name: string; index?: number }
  | { op: 'renameSubtopic'; category: string; from: string; to: string }
  | { op: 'deleteSubtopic'; category: string; name: string; disposition?: FileDisposition }
  | { op: 'moveSubtopic'; fromCategory: string; name: string; toCategory: string; index?: number }
  | { op: 'mergeSubtopic'; fromCategory: string; fromName: string; toCategory: string; toName: string };

/** 一条文件级级联：把命中的 (from) 改写成 (to)；to.subtopic 为 null 表示进临时存放 */
export interface TopicCascade {
  readonly from: { category: string; subtopic: string | null };
  readonly to: { category: string; subtopic: string | null };
}

export type TopicMutationPlan =
  | { ok: true; tree: WikiTopicTree; cascades: readonly TopicCascade[] }
  | { ok: false; reason: string; needsDisposition?: true; fileCount?: number };

/**
 * 纯函数：给定当前树 + 每个 (category, subtopic) 的文件条数，算出新树与级联计划。
 * 不碰数据库，便于穷举规则测试。
 */
export function planTopicMutation(
  tree: WikiTopicTree,
  mutation: WikiTopicMutation,
  counts: ReadonlyMap<string, number>,   // key = JSON.stringify([category, subtopic])
): TopicMutationPlan;

/**
 * counts 的 key 构造器；禁止用 `${c}/${s}` 拼接。
 * 语义必须与 renderer 侧 `WikiLeftNav.tsx` 的同名函数**完全一致**（`JSON.stringify` 两列数组），
 * 否则 `WikiTopicTreeEditor` 传进来的 counts 会对不上号。
 * 两处独立实现（runtime 不依赖 renderer），改动时同步改并各自留断言测试。
 */
export function topicCountKey(category: string, subtopic?: string | null): string;
```

- [ ] **Step 1: 写失败测试** `wiki-topic-mutate.test.ts`

```ts
const T = DEFAULT_TOPIC_TREE;
const empty = new Map<string, number>();

it("addCategory 支持 index 插入且拒绝重名", () => {
  const r = planTopicMutation(T, { op: "addCategory", name: "外部协作", index: 1 }, empty);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.tree.categories[1]!.name).toBe("外部协作");
  expect(planTopicMutation(T, { op: "addCategory", name: "学习资料" }, empty).ok).toBe(false);
});

it("拒绝把大类命名为临时存放", () => {
  expect(planTopicMutation(T, { op: "addCategory", name: PARKING_CATEGORY }, empty).ok).toBe(false);
});

it("renameCategory 级联该大类全部小类的文件", () => {
  const r = planTopicMutation(T, { op: "renameCategory", from: "做事记录", to: "工作产出" }, empty);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.cascades).toContainEqual({
      from: { category: "做事记录", subtopic: "项目/任务资料" },
      to: { category: "工作产出", subtopic: "项目/任务资料" },
    });
  }
});

it("有文件的小类删除时缺 disposition 必须拒绝并回报条数", () => {
  const counts = new Map([[topicCountKey("做事记录", "会议聊天记录"), 3]]);
  const r = planTopicMutation(T, { op: "deleteSubtopic", category: "做事记录", name: "会议聊天记录" }, counts);
  expect(r).toMatchObject({ ok: false, needsDisposition: true, fileCount: 3 });
});

it("deleteSubtopic 带 parking disposition 时级联到临时存放", () => {
  const counts = new Map([[topicCountKey("做事记录", "会议聊天记录"), 3]]);
  const r = planTopicMutation(
    T,
    { op: "deleteSubtopic", category: "做事记录", name: "会议聊天记录", disposition: { type: "parking" } },
    counts,
  );
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.cascades[0]!.to).toEqual({ category: PARKING_CATEGORY, subtopic: null });
    expect(r.tree.categories[0]!.subtopics).not.toContain("会议聊天记录");
  }
});

it("大类只剩一个时不可删；小类只剩一个时不可删", () => {
  const one: WikiTopicTree = { version: 1, categories: [{ name: "唯一", subtopics: ["甲"] }] };
  expect(planTopicMutation(one, { op: "deleteCategory", name: "唯一" }, empty).ok).toBe(false);
  expect(planTopicMutation(one, { op: "deleteSubtopic", category: "唯一", name: "甲" }, empty).ok).toBe(false);
});

it("moveSubtopic 只改大类，小类名不变；目标重名拒绝", () => {
  const r = planTopicMutation(
    T, { op: "moveSubtopic", fromCategory: "做事记录", name: "数据统计报表", toCategory: "学习资料" }, empty,
  );
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.cascades).toContainEqual({
      from: { category: "做事记录", subtopic: "数据统计报表" },
      to: { category: "学习资料", subtopic: "数据统计报表" },
    });
  }
});

it("mergeSubtopic 把 from 文件改成 to 并从树删除 from；同节点拒绝", () => {
  const r = planTopicMutation(
    T,
    { op: "mergeSubtopic", fromCategory: "做事记录", fromName: "汇报总结文稿", toCategory: "做事记录", toName: "对外沟通材料" },
    empty,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.tree.categories[0]!.subtopics).not.toContain("汇报总结文稿");
  expect(planTopicMutation(
    T,
    { op: "mergeSubtopic", fromCategory: "做事记录", fromName: "汇报总结文稿", toCategory: "做事记录", toName: "汇报总结文稿" },
    empty,
  ).ok).toBe(false);
});

it("reorderCategories 的 names 集合必须与现有大类相等", () => {
  const names = T.categories.map((c) => c.name);
  expect(planTopicMutation(T, { op: "reorderCategories", names: [...names].reverse() }, empty).ok).toBe(true);
  expect(planTopicMutation(T, { op: "reorderCategories", names: names.slice(1) }, empty).ok).toBe(false);
});

it("disposition 的 move 目标必须是新树里的合法节点", () => {
  const counts = new Map([[topicCountKey("做事记录", "会议聊天记录"), 1]]);
  const r = planTopicMutation(
    T,
    { op: "deleteSubtopic", category: "做事记录", name: "会议聊天记录",
      disposition: { type: "move", category: "做事记录", subtopic: "会议聊天记录" } },
    counts,
  );
  expect(r.ok).toBe(false); // 目标即被删节点
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
pnpm --filter ./packages/agent-runtime exec vitest run src/wiki/wiki-topic-mutate.test.ts
```

Expected: 模块不存在。

- [ ] **Step 3: 实现**

名称校验复用一期 `wiki-topic-tree.ts`：大类 1–20 字、小类 1–32 字、无控制字符、允许 `/` `&`、不得为 `PARKING_CATEGORY`。

各 op 要点：

- `renameCategory`：目标名已存在拒绝。交换两名由 UI 分两步做，运行时不特殊处理（§8.2 的「中间名」由调用方在同一 `mutate` 序列里保证；本函数只保证单步不产生重名）
- `deleteCategory` / `deleteSubtopic`：先按 `counts` 求受影响文件总数；`>0` 且无 `disposition` → `{ ok: false, needsDisposition: true, fileCount }`
- `disposition.type === 'move'`：目标 `(category, subtopic)` 必须存在于**变更后**的树里，否则拒绝
- `disposition.type === 'parking'`：级联 `to = { category: PARKING_CATEGORY, subtopic: null }`
- `mergeSubtopic`：`from === to` 拒绝；`to` 必须已存在；`from` 删除后其大类不得空
- 所有分支返回的 `tree` 必须通过 `validateTopicTree`（实现里加一次断言式自检）

- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit**

```powershell
git add packages/agent-runtime/src/wiki/wiki-topic-mutate.ts packages/agent-runtime/src/wiki/wiki-topic-mutate.test.ts packages/agent-runtime/src/wiki/wiki-topic-tree.ts packages/agent-runtime/src/wiki/index.ts
git commit -m "feat(wiki): plan topic tree mutations with file disposition"
```

---

### Task 2: mutation 落库事务 + IPC（§8.1 单事务、§8.4 刷新）

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.test.ts`
- Modify: `apps/windows/src/shared/agent-runtime-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.test.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts`
- Modify: `apps/windows/src/main/app-ui-control/command-allowlist.ts`

**Interfaces:**

```ts
// wiki-repo.ts
/** 分组统计各 (category, subtopic) 的未归档文件数；key 用 topicCountKey */
countSourcesByTopic(agentId: string, userId: string): Map<string, number>

/**
 * 单事务：plan → 写 topic_categories JSON → 按 cascades 批量 UPDATE wiki_sources。
 * plan 失败直接抛（带 fileCount 信息）；任一步失败整单回滚。
 */
applyTopicMutation(agentId: string, userId: string, mutation: WikiTopicMutation): {
  readonly tree: WikiTopicTree;
  readonly movedCount: number;
}
```

IPC：

```ts
{ type: 'wiki:topic:mutate'; agentId?: string; sessionKey?: string; userId?: string;
  mutation: WikiTopicMutation }
// result: { tree: WikiTopicTree; movedCount: number }
// 需要去向时 throw，message 形如「「会议聊天记录」下还有 3 个文件，请先选择去向」
```

- [ ] **Step 1: 写失败测试**（`wiki-repo.test.ts`）

```ts
it("applyTopicMutation 改名后文件跟着走，树也更新", () => {
  const s = repo.createSource({ agentId: "ag", userId: "u", title: "周报.docx" });
  repo.updateSourceTopic(s.id, "做事记录", "汇报总结文稿");
  const r = repo.applyTopicMutation("ag", "u", { op: "renameCategory", from: "做事记录", to: "工作产出" });
  expect(r.tree.categories.map((c) => c.name)).toContain("工作产出");
  expect(repo.findSourceById(s.id)!.topic_category).toBe("工作产出");
  expect(repo.findSourceById(s.id)!.topic_subtopic).toBe("汇报总结文稿");
});

it("删有文件的小类未给去向时抛错且树不变", () => {
  const s = repo.createSource({ agentId: "ag", userId: "u", title: "纪要.md" });
  repo.updateSourceTopic(s.id, "做事记录", "会议聊天记录");
  expect(() => repo.applyTopicMutation("ag", "u", {
    op: "deleteSubtopic", category: "做事记录", name: "会议聊天记录",
  })).toThrow(/3|文件|去向/);
  expect(repo.getOrCreateTopicTree().categories[0]!.subtopics).toContain("会议聊天记录");
  expect(repo.findSourceById(s.id)!.topic_subtopic).toBe("会议聊天记录");
});

it("merge 后 from 的文件全部落到 to", () => {
  const a = repo.createSource({ agentId: "ag", userId: "u", title: "a.md" });
  repo.updateSourceTopic(a.id, "做事记录", "汇报总结文稿");
  repo.applyTopicMutation("ag", "u", {
    op: "mergeSubtopic", fromCategory: "做事记录", fromName: "汇报总结文稿",
    toCategory: "做事记录", toName: "对外沟通材料",
  });
  expect(repo.findSourceById(a.id)!.topic_subtopic).toBe("对外沟通材料");
});
```

`wiki-commands.test.ts`：`wiki:topic:mutate` 加小类后 `wiki:topic:tree:get` 能读到；删有文件小类返回中文错误。

- [ ] **Step 2: 跑测试确认失败**

```powershell
pnpm --filter ./packages/agent-runtime exec vitest run src/wiki/wiki-repo.test.ts
```

- [ ] **Step 3: 实现**

`applyTopicMutation` 用现有 `withTransaction`：

```ts
return withTransaction(this.db, () => {
  const tree = this.getOrCreateTopicTree();
  const counts = this.countSourcesByTopic(agentId, userId);
  const plan = planTopicMutation(tree, mutation, counts);
  if (!plan.ok) {
    throw new Error(plan.needsDisposition
      ? `该目录下还有 ${plan.fileCount} 个文件，请先选择去向`
      : plan.reason);
  }
  // 先写 JSON（复用 setIndexMeta，不走 setTopicTree 的孤儿校验——级联在同一事务内随后执行）
  this.setIndexMeta(TOPIC_CATEGORIES_META_KEY, JSON.stringify(plan.tree));
  let moved = 0;
  for (const c of plan.cascades) {
    moved += this.bulkUpdateSourceTopic(agentId, userId, c.from, c.to);
  }
  return { tree: plan.tree, movedCount: moved };
});
```

`bulkUpdateSourceTopic` 为私有方法：等值 `WHERE topic_category = ? AND topic_subtopic = ?`（`from.subtopic` 为 null 时用 `IS NULL`），返回 `info.changes`。

**注意：** 不能在事务里调用一期的 `setTopicTree`——它带禁孤儿校验，而级联尚未执行，会误判。此处直接写 meta 键，事务结束时不变量已恢复。

`countSourcesByTopic`：`SELECT topic_category, topic_subtopic, COUNT(*) FROM wiki_sources WHERE agent_id=? AND user_id=? AND archived_at IS NULL GROUP BY 1,2`，跳过两列全 NULL 与临时存放行（临时存放不参与 disposition 判定）。

- [ ] **Step 4: 测试通过**（含 `pnpm --filter ./apps/windows exec vitest run src/main/ipc/agent-runtime/wiki-commands.test.ts`）
- [ ] **Step 5: Commit** `feat(wiki): apply topic mutations in a single transaction`

---

### Task 3: 主题树编辑器 UI（§8.3）

**Files:**
- Create: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTopicTreeEditor.tsx`
- Create: `apps/windows/src/test/components/WikiTopicTreeEditor.test.tsx`
- Modify: `WikiMoreMenu.tsx`（亮出「编辑主题树」）
- Modify: `WikiTab.tsx`（弹层状态 + mutate 后刷新树与列表）
- Modify: `WikiTab.css`
- Modify: `useWikiPage.ts`（`mutateTopic(mutation): Promise<WikiTopicTree | null>`）

**Interfaces:**

```tsx
interface WikiTopicTreeEditorProps {
  open: boolean                                  // 与 WikiTopicPicker 的开关风格一致
  tree: WikiTopicTree | null
  /** 节点文件数，用于删除前提示。key 由 WikiLeftNav 的 topicCountKey 生成，
   *  形状与 WikiLeftNavProps.topicCounts 相同（Record 而非 Map），直接复用 WikiTab 已算好的那份 */
  topicCounts: Record<string, number>
  onMutate: (mutation: WikiTopicMutation) => Promise<WikiTopicTree | null>
  onClose: () => void
}
```

`WikiMoreMenuProps` 需加 `readonly onEditTopicTree: () => void`，并在 `MENU_ITEMS` 里插入「编辑主题树」项（描述：「增删改并大类与小类」）。`WikiTab` 里 `topicCounts` 已为左栏算好，直接透传，不要重算。

交互规格（§8.3）：

- 左列大类可拖拽排序（放下即 `reorderCategories`），右列显示当前选中大类的小类，可拖拽（`index` 参数）
- 行内重命名：双击或铅笔进入 input，Enter 提交 `renameCategory` / `renameSubtopic`，Esc 取消
- 删除：先弹去向框，三选一 —— 移到临时存放 / 移到另一小类 / 合并到另一小类；无文件时可直接删（不弹框）
- 底栏「+ 添加大类」「+ 添加小类」
- **不展示临时存放**
- **每次操作立刻调用 `onMutate`**，不在本地攒整树再 `set`（否则中途关闭会留孤儿）
- 失败：行内红字显示后端中文 message，树回滚为 `onMutate` 返回前的状态

- [ ] **Step 1: 写失败测试**

```tsx
const props = { open: true, tree: DEFAULT_TREE, topicCounts: {}, onMutate: vi.fn(), onClose: vi.fn() }

it("渲染大类与选中大类的小类，不列出临时存放", () => {
  render(<WikiTopicTreeEditor {...props} />)
  expect(screen.getByText('做事记录')).toBeInTheDocument()
  expect(screen.getByText('项目/任务资料')).toBeInTheDocument()
  expect(screen.queryByText('临时存放')).not.toBeInTheDocument()
})

it("添加小类后立刻发出 addSubtopic mutation", async () => {
  const onMutate = vi.fn().mockResolvedValue(DEFAULT_TREE)
  render(<WikiTopicTreeEditor {...props} onMutate={onMutate} />)
  await userEvent.click(screen.getByRole('button', { name: /添加小类/ }))
  await userEvent.type(screen.getByRole('textbox'), '客户往来函件{Enter}')
  expect(onMutate).toHaveBeenCalledWith({ op: 'addSubtopic', category: '做事记录', name: '客户往来函件' })
})

it("删除有文件的小类先弹去向框，取消则不发 mutation", async () => {
  const onMutate = vi.fn()
  const topicCounts = { [topicCountKey('做事记录', '会议聊天记录')]: 3 }
  render(<WikiTopicTreeEditor {...props} topicCounts={topicCounts} onMutate={onMutate} />)
  await userEvent.click(screen.getByLabelText('删除小类 会议聊天记录'))
  expect(screen.getByText(/3 个文件/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(onMutate).not.toHaveBeenCalled()
})

it("选择移到临时存放后带 disposition 提交", async () => {
  const onMutate = vi.fn().mockResolvedValue(DEFAULT_TREE)
  const topicCounts = { [topicCountKey('做事记录', '会议聊天记录')]: 3 }
  render(<WikiTopicTreeEditor {...props} topicCounts={topicCounts} onMutate={onMutate} />)
  await userEvent.click(screen.getByLabelText('删除小类 会议聊天记录'))
  await userEvent.click(screen.getByRole('radio', { name: /移到临时存放/ }))
  await userEvent.click(screen.getByRole('button', { name: '确认删除' }))
  expect(onMutate).toHaveBeenCalledWith({
    op: 'deleteSubtopic', category: '做事记录', name: '会议聊天记录',
    disposition: { type: 'parking' },
  })
})

it("无文件的小类可直接删除，不弹去向框", async () => {
  const onMutate = vi.fn().mockResolvedValue(DEFAULT_TREE)
  render(<WikiTopicTreeEditor {...props} onMutate={onMutate} />)
  await userEvent.click(screen.getByLabelText('删除小类 会议聊天记录'))
  expect(onMutate).toHaveBeenCalledWith({ op: 'deleteSubtopic', category: '做事记录', name: '会议聊天记录' })
})
```

- [ ] **Step 2: 跑测试确认失败**（组件不存在）
- [ ] **Step 3: 实现**

`WikiTab` 侧：`mutateTopic` 成功后重新 `loadTopicTree()` + 重新 `listSources(当前 nav 过滤)`；若当前 nav 指向的节点被删或改名，导航回 `{ kind: 'inbox' }` 或改名后的节点（改名时按 `cascades` 语义映射）。

确认框底部加复选框「同时重新编目受影响的小类」，**默认不勾**（§8.2）。勾选时在 mutate 成功后调 Task 5 的 `wiki:reclassify:run`（`scope=subtopic`，指向去向节点）。Task 5 未完成前该复选框隐藏。

- [ ] **Step 4:** `pnpm --filter ./apps/windows exec vitest run src/test/components/WikiTopicTreeEditor.test.tsx`
- [ ] **Step 5: Commit** `feat(wiki-ui): add topic tree editor with delete disposition`

---

### Task 4: 重新编目状态机与候选生成（§9.1 / §9.2）

**Files:**
- Create: `packages/agent-runtime/src/wiki/wiki-reclassifier.ts`
- Create: `packages/agent-runtime/src/wiki/wiki-reclassifier.test.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.ts`（run 读写 + 扫描集查询）
- Modify: `packages/agent-runtime/src/wiki/index.ts`

**Interfaces:**

```ts
// wiki-repo.ts
export const RECLASSIFY_RUN_META_KEY = "reclassify_run";

getReclassifyRun(agentId: string, userId: string): WikiReclassifyRun | null
setReclassifyRun(agentId: string, userId: string, run: WikiReclassifyRun | null): void  // null 清空
/** 扫描集：仅正式归档（两列非空且 category ≠ 临时存放、未 archived） */
listSourcesForReclassify(agentId: string, userId: string, scope: WikiReclassifyScope): readonly WikiSource[]
```

```ts
// wiki-reclassifier.ts
export type WikiReclassifyStatus = "running" | "review" | "applying" | "failed" | "discarded";

export type WikiReclassifyScope =
  | { kind: "source"; sourceId: string }
  | { kind: "subtopic"; category: string; subtopic: string }
  | { kind: "all" };

export interface WikiReclassifyCandidate {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly fromCategory: string;
  readonly fromSubtopic: string;
  readonly toCategory: string;
  readonly toSubtopic: string;
  readonly reason: string;
  decision: "pending" | "applied" | "ignored";
  /** 接受失败（目标小类已被删）时的中文原因，条目留在 review */
  applyError?: string;
}

export interface WikiReclassifyRun {
  readonly runId: string;
  readonly status: WikiReclassifyStatus;
  readonly scope: WikiReclassifyScope;
  readonly total: number;
  readonly processed: number;
  readonly droppedInvalid: number;
  readonly unchanged: number;
  readonly candidates: readonly WikiReclassifyCandidate[];
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class WikiReclassifier {
  constructor(
    private readonly repo: WikiRepo,
    private readonly callLLM: (prompt: string) => Promise<string>,
    /** 测试注入固定 id；生产用 generateWikiId */
    private readonly newId: () => string = generateWikiId,
  ) {}

  /** 启动：写 running → 分批问 LLM → 写 review。已有 running/review 时抛错（除 force） */
  async run(agentId: string, userId: string, scope: WikiReclassifyScope,
            opts?: { force?: boolean }): Promise<string>;
  get(agentId: string, userId: string): WikiReclassifyRun | null;
  /** 部分接受；返回 applied / failed 条数。全部 applied|ignored 后清空 run */
  apply(agentId: string, userId: string, candidateIds: readonly string[]):
    { applied: number; failed: number };
  ignore(agentId: string, userId: string, candidateId: string): void;
  discard(agentId: string, userId: string): void;
  /** organizer 判暂停用 */
  static isRunning(run: WikiReclassifyRun | null): boolean;
}

/** 提示词：口诀 + 当前树 + 每条的当前大类/小类；只在确有更好用途时输出新节点 */
export function buildReclassifyPrompt(
  items: readonly { id: string; title: string; text: string | null;
                    fromCategory: string; fromSubtopic: string }[],
  tree: WikiTopicTree,
): string;

export function parseReclassifyResponse(
  response: string,
  items: readonly { id: string; sourceId: string; title: string;
                    fromCategory: string; fromSubtopic: string }[],
  tree: WikiTopicTree,
  newId: () => string,
): { candidates: WikiReclassifyCandidate[]; droppedInvalid: number; unchanged: number };
```

- [ ] **Step 1: 写失败测试** `wiki-reclassifier.test.ts`

```ts
it("提示词含口诀、当前树与当前所属目录，且不含临时存放", () => {
  const p = buildReclassifyPrompt(
    [{ id: "i1", title: "2027年度OKR草案.docx", text: "未执行的规划", fromCategory: "做事记录", fromSubtopic: "项目/任务资料" }],
    DEFAULT_TOPIC_TREE,
  );
  expect(p).toContain("事情做完留下的结果");
  expect(p).toContain("目标规划方案");
  expect(p).toContain("做事记录 / 项目/任务资料");
  expect(p).not.toContain(PARKING_CATEGORY);
});

it("自造节点计入 droppedInvalid；与原节点相同计入 unchanged", () => {
  const items = [
    { id: "a", sourceId: "s1", title: "a", fromCategory: "做事记录", fromSubtopic: "项目/任务资料" },
    { id: "b", sourceId: "s2", title: "b", fromCategory: "学习资料", fromSubtopic: "读书摘抄整理" },
  ];
  const r = parseReclassifyResponse(JSON.stringify([
    { id: "a", category: "计划与复盘", subtopic: "自创小类", reason: "x" },
    { id: "b", category: "学习资料", subtopic: "读书摘抄整理", reason: "y" },
  ]), items, DEFAULT_TOPIC_TREE, mkId);
  expect(r.droppedInvalid).toBe(1);
  expect(r.unchanged).toBe(1);
  expect(r.candidates).toHaveLength(0);
});

it("scope=all 只扫描正式归档，跳过临时存放与待补分", async () => {
  const filed = mkSource("已归档.docx"); repo.updateSourceTopic(filed.id, "做事记录", "项目/任务资料");
  const parked = mkSource("搁置.docx"); repo.updateSourceTopic(parked.id, PARKING_CATEGORY, null);
  const unfiled = mkSource("待补分.docx");
  const run = await reclassifier.run("ag", "u", { kind: "all" });
  const got = reclassifier.get("ag", "u")!;
  expect(got.total).toBe(1);
  expect(got.candidates.map((c) => c.sourceId)).not.toContain(parked.id);
  expect(got.candidates.map((c) => c.sourceId)).not.toContain(unfiled.id);
});

it("已有 running 时再 run 抛错；review 时需 force", async () => {
  await reclassifier.run("ag", "u", { kind: "all" });          // → review
  await expect(reclassifier.run("ag", "u", { kind: "all" })).rejects.toThrow(/已有/);
  await expect(reclassifier.run("ag", "u", { kind: "all" }, { force: true })).resolves.toBeTruthy();
});

it("apply 部分接受后写两列；目标小类已删则该条留 review 带 applyError", async () => {
  // 生成 2 条候选，其中一条目标节点先被 mutate 删掉
  const r = reclassifier.apply("ag", "u", [c1.id, c2.id]);
  expect(r.applied).toBe(1);
  expect(r.failed).toBe(1);
  const got = reclassifier.get("ag", "u")!;
  expect(got.status).toBe("review");
  expect(got.candidates.find((c) => c.id === c2.id)!.applyError).toMatch(/目录/);
});

it("全部 applied/ignored 后 run 被清空", async () => {
  reclassifier.apply("ag", "u", [c1.id]);
  reclassifier.ignore("ag", "u", c2.id);
  expect(reclassifier.get("ag", "u")).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
pnpm --filter ./packages/agent-runtime exec vitest run src/wiki/wiki-reclassifier.test.ts
```

- [ ] **Step 3: 实现**

- 存储：`setIndexMeta(RECLASSIFY_RUN_META_KEY, JSON.stringify(run))`，**覆盖式**，不按 runId 堆键。`getIndexMeta` 解析失败视为 null
- `run()`：先 `get()` 判状态 → `running` 一律拒绝；`review` 需 `force`（UI 层先弹「丢弃旧批次？」）。写 `status: 'running', total, processed: 0` 后再逐批调 LLM，每批结束更新 `processed`（任务 pill 读进度）
- 批切分沿用 `wiki-classifier.ts` 的批大小常量；正文取 `extracted_text` 截断（与 classify 同一截断长度）
- LLM 抛错 → `status: 'failed'`，`error` 存 message，**保留 scope** 供 retry
- `apply()`：对每个 candidateId 先 `validateTopicAssignment(currentTree, to...)`；失败写 `applyError` 保持 `pending`；成功调 `repo.updateSourceTopic` 并标 `applied`。全部非 pending → `setReclassifyRun(null)`
- `discard()` → 直接 `setReclassifyRun(null)`（`discarded` 只是瞬态语义，不需要持久留存）

- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit** `feat(wiki): add reclassify candidate state machine`

---

### Task 5: 编目与自动归档互斥（§7 / §9.2）

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-organizer.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-organizer.test.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge.ts`

**Interfaces:** `organizeBatch` 开头判断 `WikiReclassifier.isRunning(this.repo.getReclassifyRun(agentId, userId))`，为真则**直接返回空运行摘要**（不取件、不改 attempt_count），条目留 pending。

- [ ] **Step 1: 写失败测试**

```ts
it("reclassify running 时 organizeBatch 不取件，条目仍 pending", async () => {
  hook.ingestUpload("ag", "u", "会议纪要.docx", "/tmp/a.docx");
  repo.setReclassifyRun("ag", "u", { runId: "r1", status: "running", /* … */ } as never);
  const summary = await organizer.organizeBatch("ag", "u", "upload");
  expect(summary.organized).toBe(0);
  expect(repo.listInbox("ag", "u").filter((i) => !i.organized_at)).toHaveLength(1);
});

it("review 状态不阻塞自动归档", async () => {
  repo.setReclassifyRun("ag", "u", { runId: "r1", status: "review", /* … */ } as never);
  const summary = await organizer.organizeBatch("ag", "u", "upload");
  expect(summary.organized).toBe(1);
});
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**

`bridge.ts` 的 `startWikiOrganizePolling`（约 `bridge.ts:1816`）无需改动结构——判断放在 organizer 内部即可，队列仍会 enqueue 但任务立即返回。同时 `bridge.ts` 加：

```ts
private _wikiReclassifier: WikiReclassifier | null = null
get wikiReclassifier(): WikiReclassifier {
  if (!this._wikiReclassifier) {
    this._wikiReclassifier = new WikiReclassifier(
      this.wikiRepo,
      (prompt) => this.callLLM(prompt, undefined, 'wiki_classify'),
    )
  }
  return this._wikiReclassifier
}
```

LLM purpose 复用归档分类用的那个（与 `wiki-organizer` 注入的 `callLLM` 同一 purpose，保证小模型预算一致）。

- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit** `feat(wiki): pause auto organize while reclassify runs`

---

### Task 6: 重新编目 IPC + 候选 UI（§9.3 / §9.4）

**Files:**
- Modify: `apps/windows/src/shared/agent-runtime-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.test.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts`、`command-allowlist.ts`
- Modify: `useWikiPage.ts`
- Create: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiReclassifyView.tsx`
- Create: `apps/windows/src/test/components/WikiReclassifyView.test.tsx`
- Modify: `WikiTopicPicker.tsx`、`WikiFileList.tsx`、`WikiMoreMenu.tsx`、`WikiTab.tsx`、`useWikiTaskCenter.ts`

**Interfaces:**

```ts
{ type: 'wiki:reclassify:run'; agentId?: string; sessionKey?: string;
  scope: 'source' | 'subtopic' | 'all';
  sourceId?: string; category?: string; subtopic?: string; force?: boolean }
// result: { runId: string }

{ type: 'wiki:reclassify:get'; agentId?: string; sessionKey?: string }
// result: { run: WikiReclassifyRunDto | null }

{ type: 'wiki:reclassify:apply'; agentId?: string; candidateIds: string[] }
// result: { applied: number; failed: number }

{ type: 'wiki:reclassify:ignore'; agentId?: string; candidateId: string }
{ type: 'wiki:reclassify:discard'; agentId?: string }
// result: { success: true }
```

handler 侧：`run` 用 `void` 异步启动（不阻塞 IPC 返回），进度由 renderer 轮询 `get`。`scope` 与 `sourceId`/`category`/`subtopic` 不匹配时抛中文错误。

UI 规格：

- **`WikiReclassifyView`（主区）**：顶栏「N 条建议 · 接受已选 · 全部接受 · 全部忽略」；行 = 文件名 + `from → to` + 理由 + 接受/忽略。`applyError` 显示红字并保留行。`running` 时显示进度 `processed/total`，不显示候选。**不用右下角 toast**
- **`WikiNav`**（定义在 `WikiLeftNav.tsx`）增 `{ kind: 'reclassify' }`。左栏**不加**固定入口（§6.1 只有待整理/知识图谱/临时存放三项），仅由更多菜单与任务中心跳入；`isActive` 的 switch 要覆盖新 kind
- **`WikiTopicPicker`** 增可选 props，**不破坏现有调用**：

```ts
interface WikiTopicPickerProps {
  // …现有 6 个 props 不变
  /** 提供时显示次要按钮「让 AI 建议」 */
  onRequestSuggestion?: () => void
  /** AI 建议结果；展示为「AI 建议：计划与复盘 / 目标规划方案」+「采用」 */
  suggestion?: { category: string; subtopic: string; reason: string } | null
  suggestionState?: 'idle' | 'loading' | 'failed'
  onAdoptSuggestion?: () => void
}
```

「采用」= 直接以建议的两列调用现有 `onConfirm(category, subtopic)`（走确定性写入路径 ②），**不**调 `reclassify:apply`——单文件建议用完即弃，随后 `discard` 清掉该批次，避免占用唯一 run 槽位。

- **`WikiFileList`** 小类视图顶栏增「重新编目本小类」。当前组件无顶栏动作槽，需加 `headerActions?: React.ReactNode`（Task 9 的多选批量条也复用这个槽）
- **`WikiMoreMenu`** 加 `readonly onReclassifyAll: () => void`，`MENU_ITEMS` 插入「全库重新编目」。二次确认文案：「将扫描 N 个已归档文件，不会改临时存放」（N = `listSources({})` 中 `topicCategory` 非空且 ≠ 临时存放的条数）
- **`useWikiTaskCenter`** 的 `WikiTaskKind` 加 `'reclassify'`，`TASK_PROGRESS_PREFIX` 加 `reclassify: '重新编目中'`（该文件有 `useWikiTaskCenter.test.ts`，可能有 kind 枚举断言，需同步）

- [ ] **Step 1: 写失败测试**

`wiki-commands.test.ts`：`scope: 'subtopic'` 缺 `category` 抛错；`run` 后 `get` 返回 `status`；`apply` 空数组返回 `{ applied: 0, failed: 0 }`。

```tsx
// WikiReclassifyView.test.tsx
it("running 时显示进度不显示候选", () => {
  render(<WikiReclassifyView run={{ status: 'running', processed: 12, total: 80, candidates: [] }} {...cbs} />)
  expect(screen.getByText(/12\s*\/\s*80/)).toBeInTheDocument()
})

it("review 时显示 from → to 与理由，接受已选只提交勾选项", async () => {
  const onApply = vi.fn()
  render(<WikiReclassifyView run={reviewRun} onApply={onApply} {...cbs} />)
  expect(screen.getByText('做事记录 / 项目/任务资料')).toBeInTheDocument()
  expect(screen.getByText('计划与复盘 / 目标规划方案')).toBeInTheDocument()
  await userEvent.click(screen.getByLabelText('选择 2027年度OKR草案.docx'))
  await userEvent.click(screen.getByRole('button', { name: '接受已选' }))
  expect(onApply).toHaveBeenCalledWith(['c1'])
})

it("applyError 的行保留并显示红字", () => {
  render(<WikiReclassifyView run={runWithError} {...cbs} />)
  expect(screen.getByText(/目标目录已不存在/)).toBeInTheDocument()
})
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现 handlers + switch + allowlist + UI**
- [ ] **Step 4:**

```powershell
pnpm --filter ./apps/windows exec vitest run src/main/ipc/agent-runtime/wiki-commands.test.ts src/test/components
pnpm typecheck
```

- [ ] **Step 5: Commit** `feat(wiki): add reclassify commands and candidate review UI`

---

### Task 7: 新建笔记（§10）

**Files:**
- Modify: `apps/windows/src/shared/agent-runtime-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.test.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts`、`command-allowlist.ts`
- Modify: `useWikiPage.ts`、`WikiFileList.tsx`、`WikiTab.tsx`
- Modify: `apps/windows/src/test/components/WikiFileList.test.tsx`

**Interfaces:**

```ts
{ type: 'wiki:source:create-note'; agentId?: string; sessionKey?: string;
  category: string; subtopic: string; title?: string }
// result: { sourceId: string; sourcePath: string; title: string }
```

实现要点：

1. 校验 `validateTopicAssignment(tree, category, subtopic)`——**不允许**写临时存放（笔记必须落在正式目录）
2. 落盘目录：`path.join(app.getPath('userData'), 'wiki-notes', safeSegment(category))`。`safeSegment` 复用 `sanitizeFilenameSegment`（`wiki-exporter.ts` 已导出），把 `/`、`&` 等替换掉——**不要**用带 `/` 的小类名当文件夹
3. 文件名 `${timestamp}-untitled.md`，timestamp 用 `YYYYMMDD-HHmmss`；冲突时复用 `resolveUniqueFilename`
4. 初始内容：`# ${title ?? '未命名笔记'}\n\n`
5. `repo.createSource({ title: title ?? '未命名笔记', sourcePath: 绝对路径, mediaType: 'document', mimeType: 'text/markdown', originContext: '用户在 Wiki 目录中新建' })` → `updateSourceTopic` → `indexSource`
6. **不写 `wiki_pages`**

UI：小类视图顶栏「新建笔记」。大类聚合视图下该按钮先要求选小类（用 `WikiTopicPicker` 限定在当前大类，或默认该大类第一个小类——取**先选**，避免误放）。创建成功后列表刷新并高亮新行，「打开」走 `openSource` → `shell.openPath` 用系统编辑器打开。

重命名 = 改 `title`（新增 `wiki:source:rename` 或复用现有更新命令；磁盘文件名不动，避免链接失效）。删除复用现有 `wiki:source:delete`。

- [ ] **Step 1: 写失败测试**

```ts
it("create-note 写磁盘 md 并插入带主题的 source", async () => {
  const r = await handleWikiSourceCreateNote(bridge, {
    type: 'wiki:source:create-note', category: '随笔创作', subtopic: '灵感随手记录',
  } as never)
  expect(fs.existsSync(r.sourcePath)).toBe(true)
  const s = bridge.wikiRepo.findSourceById(r.sourceId)!
  expect(s.topic_category).toBe('随笔创作')
  expect(s.mime_type).toBe('text/markdown')
})

it("小类名含斜杠时目录名被安全化", async () => {
  const r = await handleWikiSourceCreateNote(bridge, {
    type: 'wiki:source:create-note', category: '做事记录', subtopic: '项目/任务资料',
  } as never)
  expect(r.sourcePath).not.toContain('项目/任务资料')
})

it("拒绝在临时存放建笔记", async () => {
  await expect(handleWikiSourceCreateNote(bridge, {
    type: 'wiki:source:create-note', category: '临时存放', subtopic: null,
  } as never)).rejects.toThrow()
})
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 测试通过 + typecheck**
- [ ] **Step 5: Commit** `feat(wiki): create markdown notes inside topic folders`

---

### Task 8: 综述产出改为普通资料文件（§11）

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-synthesizer.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-synthesizer.test.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.ts`（`acceptSynthesisAsSource`）
- Modify: `apps/windows/src/shared/agent-runtime-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`
- Modify: `useWikiPage.ts`、`WikiFileList.tsx`、`WikiMoreMenu.tsx`、`WikiSynthesisPanel`（现有综述视图组件）

**现状：** `wiki-synthesizer.ts` 的 `synthesize(agentId, userId, pageIds, opts)` 读 `wiki_pages`；`accept()` 走 `repo.acceptSynthesis` → `savePage('syntheses/...')`。二期要新增以 `sourceIds` 为输入、以 `wiki_sources` 为产出的路径，**保留旧方法**给历史页面存量记录。

**Interfaces:**

```ts
// wiki-synthesizer.ts
/** 以资料为输入：读 extracted_text（媒体退化为 title + media_meta）→ 分块 → 落盘 → candidate */
async synthesizeSources(
  agentId: string, userId: string,
  sourceIds: readonly string[],
  options?: WikiSynthesizeOptions,
): Promise<string>;

/** 接受：落盘已在 synthesizeSources 完成，此处插入 wiki_sources 并写主题两列 */
acceptAsSource(
  agentId: string, userId: string, synthesisId: string,
  topic: { category: string; subtopic: string },
): WikiSource;
```

```ts
// wiki-repo.ts —— 单事务：createSource + updateSourceTopic + indexSource + 标 accepted
acceptSynthesisAsSource(params: {
  synthesisId: string; agentId: string; userId: string;
  title: string; outputPath: string; category: string; subtopic: string;
}): WikiSource
```

IPC：

```ts
// 改：create 支持资料输入
{ type: 'wiki:synthesis:create'; agentId?: string; sessionKey?: string;
  sourceIds?: string[]; category?: string; subtopic?: string;   // 新增
  pageIds?: string[];                                            // 保留（历史页路径）
  title?: string }

// 新：以资料形式接受
{ type: 'wiki:synthesis:accept-as-source'; agentId?: string; synthesisId: string;
  category: string; subtopic: string }
// result: { sourceId: string; category: string; subtopic: string }
```

`handleWikiSynthesisCreate` 分支：给 `sourceIds` 或 `category`（+可选 `subtopic`）时走 `synthesizeSources`；`category` 展开用 `listSourcesByTopic`。条数 > 40 时 handler **不**自动截断，抛中文错误让 UI 二次确认（`confirmed: true` 参数放行）；空输入拒绝。

默认目标目录（§11.1 步骤 4）由 renderer 计算并传入，规则：

1. 来源大类众数 → 若该大类含「汇报总结文稿」用它
2. 否则该大类第一个小类
3. 来源跨大类无众数 → `做事记录 / 汇报总结文稿`

用户在接受前仍可用 `WikiTopicPicker` 改。

- [ ] **Step 1: 写失败测试**

```ts
it("synthesizeSources 用 extracted_text 分块并落盘 outputs/wiki-syntheses", async () => {
  const a = mkSourceWithText("调研A.pdf", "长正文……");
  const id = await synthesizer.synthesizeSources("ag", "u", [a.id]);
  const row = repo.findSynthesisById(id)!;
  expect(row.status).toBe("candidate");
  expect(row.output_path).toMatch(/^outputs[\\/]wiki-syntheses[\\/]/);
  expect(row.source_ids).toContain(a.id);
});

it("无正文的媒体退化为 title + media_meta，不抛错", async () => {
  const v = repo.createSource({ agentId: "ag", userId: "u", title: "演示.mp4", mediaType: "video", mediaMeta: '{"duration":120}' });
  await expect(synthesizer.synthesizeSources("ag", "u", [v.id])).resolves.toBeTruthy();
});

it("acceptAsSource 产出一条带主题的 source 且不新建 wiki_pages", () => {
  const before = repo.listPages("ag", "u").length;
  const s = synthesizer.acceptAsSource("ag", "u", id, { category: "做事记录", subtopic: "汇报总结文稿" });
  expect(s.topic_subtopic).toBe("汇报总结文稿");
  expect(s.mime_type).toBe("text/markdown");
  expect(repo.listPages("ag", "u")).toHaveLength(before);
  expect(repo.findSynthesisById(id)!.status).toBe("accepted");
});

it("空输入与非 candidate 状态都拒绝", async () => {
  await expect(synthesizer.synthesizeSources("ag", "u", [])).rejects.toThrow();
  expect(() => synthesizer.acceptAsSource("ag", "u", id, topic)).toThrow(/candidate/);
});
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**

- `synthesizeSources` 复用现有 `runPipeline` 的分块 / 归纳 / 落盘逻辑，只把「读 pages → `content_md`」换成「读 sources → `extracted_text ?? title + media_meta`」。`insertSynthesis` 的 `sourcePageIds` 传 `[]`，`sourceIds` 传实际 id 列表
- 正文末尾列来源文件名（沿用 `buildAcceptedSynthesisPageMd` 的来源段思路，但改成文件名列表，不生成 `[[双链]]`）
- `acceptAsSource` 调 `repo.acceptSynthesisAsSource`：事务内 `createSource({ title, sourcePath: output_path, mediaType: 'document', mimeType: 'text/markdown', contentMd: candidate_md, extractedText: candidate_md, originContext: `综述:${synthesisId}` })` → `updateSourceTopic` → `indexSource` → `UPDATE wiki_syntheses SET status='accepted', finished_at=?`（`page_id` 保持 NULL）
- **不动** `accept()` / `synthesizeDirectToPath()`；`wiki:synthesis:auto-run` 属于旧自动综述路径，二期不扩展（§19「不做 AI 自动综述」），保持现状即可
- `reject` 不变

- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit** `feat(wiki): accept syntheses as topic files instead of pages`

---

### Task 9: 多选 + 清理对齐（§6.3 二期、§12）

**Files:**
- Modify: `WikiFileList.tsx`（多选，可选 props）
- Modify: `apps/windows/src/test/components/WikiFileList.test.tsx`（已存在）
- Modify: `packages/agent-runtime/src/wiki/wiki-cleanup.ts`（只加 `suggestedAction`，**不动 stale 判据**）
- Modify: `packages/agent-runtime/src/wiki/wiki-cleanup.test.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`（scan 追加 `suggestedAction`）
- Modify: `CleanupView.tsx`（加「移到临时存放」批量动作）
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/cleanupSelection.ts`（若批量选择逻辑集中在此）
- Modify: `WikiTab.tsx`（多选状态 + 批量条组装）

**多选：** `WikiFileList` 加复选框列 + 全选（复用 Task 6 引入的 `headerActions` 槽）。新增可选 props，默认关闭以不影响现有调用点：

```ts
interface WikiFileListProps {
  // …现有 props 不变
  selectable?: boolean
  selectedIds?: ReadonlySet<string>
  onToggleSelect?: (id: string) => void
  onToggleSelectAll?: () => void
  headerActions?: React.ReactNode
}
```

选中 ≥1 时批量条：「生成本组综述」（→ Task 8 `sourceIds`）、「移动到…」（Picker → 逐条 `updateSourceTopic`）、「存到临时存放」。0 选时隐藏。临时存放视图与搜索结果视图不开多选（`selectable` 不传）。

**stale 规则已在一期 Task 10 改好**（`wiki-cleanup.ts:72-83`：`lastActivity = use_count > 0 && last_used ? last_used : created_at`，不再 join 页面）。二期**不要重写这条规则**，只在其上加建议动作。

**已在临时存放且长期未用（§12）：** `WikiCleanupSuggestion` 加 `readonly suggestedAction: 'archive' | 'delete' | 'parking'`：

- `topic_category === PARKING_CATEGORY` 且 stale → `'delete'`（不再移一次）
- 其他 stale / duplicate → `'parking'`
- `broken_source` → `'delete'`

**`wiki:cleanup:scan`** 已返回 `topicCategory` / `topicSubtopic`（`wiki-commands.ts:436-437`），只需追加 `suggestedAction`。`CleanupView` 已按 `大类 / 小类` 展示（临时存放只显示大类名），只需在批量动作区（现有「批量归档 / 批量恢复 / 批量删除」旁）加「移到临时存放」，逐条调 `wiki:source:move-to-parking`。

- [ ] **Step 1: 写失败测试**

```ts
it("正式目录里的长期未用 → 建议移到临时存放", () => {
  const s = mkSourceCreatedDaysAgo(120);
  repo.updateSourceTopic(s.id, "学习资料", "调研搜集材料");
  expect(scanner.scan("ag", "u").find((x) => x.source.id === s.id))
    .toMatchObject({ reason: "stale", suggestedAction: "parking" });
});

it("已在临时存放且长期未用 → 建议删除，不再移一次", () => {
  const s = mkSourceCreatedDaysAgo(200);
  repo.updateSourceTopic(s.id, PARKING_CATEGORY, null);
  expect(scanner.scan("ag", "u").find((x) => x.source.id === s.id)!.suggestedAction).toBe("delete");
});

it("来源失效 → 建议删除", () => {
  const s = repo.createSource({ agentId: "ag", userId: "u", title: "丢了.docx", sourcePath: "/gone.docx" });
  const out = scanner.scan("ag", "u", { fileExists: () => false });
  expect(out.find((x) => x.source.id === s.id)!.suggestedAction).toBe("delete");
});
```

```tsx
it("selectable 时多选出现批量条并能生成综述", async () => {
  const onSynthesize = vi.fn()
  const Wrapper = () => {
    const [sel, setSel] = useState<Set<string>>(new Set())
    return <WikiFileList
      items={[a, b]} emptyHint="" selectable selectedIds={sel}
      onToggleSelect={(id) => setSel(new Set([id]))}
      headerActions={sel.size > 0
        ? <button onClick={() => onSynthesize([...sel])}>生成本组综述</button>
        : null}
      onOpen={vi.fn()} onMove={vi.fn()} />
  }
  render(<Wrapper />)
  await userEvent.click(screen.getByLabelText('选择 调研A.pdf'))
  await userEvent.click(screen.getByRole('button', { name: '生成本组综述' }))
  expect(onSynthesize).toHaveBeenCalledWith(['a'])
})

it("不传 selectable 时不渲染复选框（保持一期行为）", () => {
  render(<WikiFileList items={[a]} emptyHint="" onOpen={vi.fn()} onMove={vi.fn()} />)
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
})
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit** `feat(wiki): add cleanup parking action and file multi-select`

---

### Task 10: 资料层向量与 RRF 融合（§5.1 二期段、§2.1 向量对齐）

**Files:**
- Modify: `packages/agent-runtime/src/storage/schema.ts`（V23）
- Modify: `packages/agent-runtime/src/storage/schema-wiki.test.ts`
- Create: `packages/agent-runtime/src/wiki/wiki-source-vector.ts`
- Create: `packages/agent-runtime/src/wiki/wiki-source-vector.test.ts`
- Modify: `packages/agent-runtime/src/wiki/index.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`（`wiki:search`、`wiki:vector:rebuild`、`wiki:index:rebuild`）
- Modify: `useWikiPage.ts`、`WikiTopBar.tsx`（降级提示）

**为什么要 V23：** V22 只加了 `wiki_sources` 的主题列与 `wiki_sources_fts`，没有资料向量表。设计 §0.3「一次 schema，三期共用」指的是主题列 + ERO `source_id`，向量派生表是可重建产物，独立迁移不影响三期。V23 只建派生表，不改任何现有列。

```sql
-- V23: 资料层向量派生表（可重建；结构对齐 wiki_page_embeddings）
CREATE TABLE IF NOT EXISTS wiki_source_embeddings (
  source_id      TEXT PRIMARY KEY REFERENCES wiki_sources(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  dims           INTEGER NOT NULL,
  embedding      BLOB NOT NULL,
  content_hash   TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_source_embeddings_agent
  ON wiki_source_embeddings (agent_id, user_id, model_id);
```

**Interfaces:**

```ts
export class WikiSourceVectorIndex {
  constructor(db: DatabaseAdapter, embedder: WikiEmbedder | null);
  get enabled(): boolean;
  /** 语料 = title + extracted_text；content_hash 未变且模型一致时跳过 */
  async upsertSource(s: Pick<WikiSource, 'id'|'agent_id'|'user_id'|'title'|'extracted_text'>): Promise<void>;
  async rebuild(sources: readonly WikiSource[]): Promise<number>;
  async searchSimilar(agentId: string, userId: string, query: string, limit: number):
    Promise<readonly { sourceId: string; score: number }[]>;
}

/** 复用 reciprocalRankFusion；资料没有页面的遗忘分，用 use_count/last_used 做轻微加权 */
export function mergeSourceHybridRanks(params: {
  ftsIds: readonly string[];
  vectorIds: readonly string[];
  sourceById: ReadonlyMap<string, WikiSource>;
}): { ids: string[]; mode: 'fts' | 'vector' | 'hybrid' };
```

`wiki:search`（一期已改为资料层）result 增加两个字段：

```ts
{ hits: WikiSourceSearchHitDto[]; mode: 'fts' | 'vector' | 'hybrid'; degradeReason: string | null }
```

**兼容处理：** 一期 `wiki:search` 直接返回数组。改成对象是破坏性变更，需同步改 `useWikiPage.searchSources` 与调用方；实现时先搜 `wiki:search` 的全部消费点（含 `wiki-tools.ts` 的 `wiki_search` 工具）一并改，不留两套形状。

降级文案（禁止静默）：`enableVector === false` → 「向量检索已关闭，仅全文检索」；embedder 解析失败 → 「向量模型不可用，已退回全文检索」；`bigram-hash` 后备 → 沿用 `resolveWikiEmbedder` 返回的 `notice`。顶栏搜索结果区显示该文案。

`wiki:vector:rebuild` 与 `wiki:index:rebuild` 都要把资料向量算进去：前者对 `listSources` 全量 `rebuild`，后者在现有 `rebuildFts()` + `rebuildSourceFts()` 之后追加资料向量重建（向量关闭时跳过并在返回值里带 `notice`）。

- [ ] **Step 1: 写失败测试**

```ts
it("V23 建出 wiki_source_embeddings", () => {
  const db = createMigratedTestDb();
  expect(db.prepare<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE name = 'wiki_source_embeddings'").get()?.name)
    .toBe("wiki_source_embeddings");
  expect(SCHEMA_VERSION).toBe(23);
});

it("正文未变时不重复 embed", async () => {
  const spy = vi.fn(fakeEmbed);
  const idx = new WikiSourceVectorIndex(db, { modelId: "m", dims: 4, embed: spy });
  await idx.upsertSource(s); await idx.upsertSource(s);
  expect(spy).toHaveBeenCalledTimes(1);
});

it("embedder 为 null 时 searchSimilar 返回空、enabled 为 false", async () => {
  const idx = new WikiSourceVectorIndex(db, null);
  expect(idx.enabled).toBe(false);
  expect(await idx.searchSimilar("ag", "u", "x", 5)).toEqual([]);
});

it("只有 FTS 命中时 mode 为 fts", () => {
  expect(mergeSourceHybridRanks({ ftsIds: ["a"], vectorIds: [], sourceById }).mode).toBe("fts");
});
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**（`wiki-source-vector.ts` 直接复制 `wiki-vector.ts` 的 `float32ToBuffer` / `cosineSimilarity` / `reciprocalRankFusion` 用法，不复制页面语义）
- [ ] **Step 4: 测试通过 + typecheck**
- [ ] **Step 5: Commit** `feat(wiki): add source-level vector index with explicit degrade`

---

### Task 11: 更多菜单亮灯 + 全量回归

**Files:**
- Modify: `WikiMoreMenu.tsx`、`apps/windows/src/test/components/WikiMoreMenu.test.tsx`
- Modify: 任何因签名变化而红的测试（`wiki-organize-queue`、`bridge-wiki-tools`、CLI 相关）

一期 `WikiMoreMenu` 只有四项（历史页面 / 清理 / 综述 / 重建索引），二期按 §6.2 补到六项。最终 props：

```ts
interface WikiMoreMenuProps {
  readonly open: boolean
  readonly anchorRef?: React.RefObject<HTMLButtonElement>
  readonly onClose: () => void
  readonly onHistory: () => void
  readonly onCleanup: () => void
  readonly onSynthesis: () => void
  readonly onRebuild: () => void
  readonly onReclassifyAll: () => void       // Task 6
  readonly onEditTopicTree: () => void       // Task 3
}
```

| 项 | 二期状态 | 来源 |
|---|---|---|
| 全库重新编目 | 新增 | Task 6 |
| 编辑主题树 | 新增 | Task 3 |
| 重建索引 | 已有，扩为含资料向量 | Task 10 |
| 清理 | 已有，增「移到临时存放」 | Task 9 |
| 历史页面 | 已有，只读 | 一期 |
| 从当前目录生成综述 | 已有「综述」项，改为按当前 nav 目录取资料 | Task 8 |

- [ ] **Step 1: 全量 Wiki 测试**

```powershell
pnpm --filter ./packages/agent-runtime exec vitest run src/wiki src/storage/schema-wiki.test.ts
pnpm --filter ./apps/windows exec vitest run src/test/components src/main/ipc/agent-runtime/wiki-commands.test.ts src/main/agent-runtime/bridge-wiki-tools.test.ts
pnpm typecheck
```

- [ ] **Step 2: 修编译与测试**
- [ ] **Step 3: Commit** `test(wiki): fix regressions after phase-2 topic editing`

**手测清单（执行者必做，写进 PR）：**

1. 编辑主题树：给「学习资料」加小类「行业报告归档」→ 上传一份行业报告 → 能被自动分进去（验证 §18「用户新增小类后下一份上传可被分进去」）
2. 把「做事记录」改名为「工作产出」→ 左栏、面包屑、已归档文件的展示同步变；无孤儿节点
3. 删除有 3 个文件的小类 → 必须选去向；点取消 → 树和文件都不变
4. 全库重新编目 → 主区只列出「建议变更」项 → 接受一条 → 该文件立刻出现在新小类下
5. 编目 running 期间上传新文件 → 文件留在待整理，不丢；编目结束后自动归档恢复
6. 接受候选前先删掉目标小类 → 该条报错留在列表，其余可正常接受
7. 在「灵感随手记录」新建笔记 → 列表出现新行 → 打开能编辑 → 磁盘 `userData/wiki-notes/` 下有 md
8. 多选 3 份调研文件 → 生成综述 → 预览 → 接受 → 综述是目录里的一份普通文件（不是摘要页），能打开
9. 清理扫描 → 每行显示 `大类 / 小类` → 批量「移到临时存放」生效；临时存放里的老文件建议删除
10. 关闭向量后搜索 → 结果区显示「向量检索已关闭，仅全文检索」；重建索引后开启 → 语义相近词能命中

---

## Spec coverage（二期）

| Spec | Task |
|---|---|
| §8.1 九种 mutation + FileDisposition | 1 |
| §8.2 规则表（删最后一个、重名、去向强制、合并、排序） | 1 |
| §8.1 单事务 + 级联 `UPDATE wiki_sources` | 2 |
| §8.3 编辑器 UI（拖拽、行内改名、去向框、逐条 mutate） | 3 |
| §8.4 mutate 后刷新左栏/选择器/分类提示词 | 3 |
| §9.1 三种 scope + 扫描集边界 + `droppedInvalid` | 4 |
| §9.2 状态机、单批次、部分接受、目标已删的处理 | 4 |
| §7 running 时暂停 organize | 5 |
| §9.3 五个命令 | 6 |
| §9.4 主区候选列表、选择器「让 AI 建议」、小类/全库入口 | 6 |
| §10 新建笔记（安全目录名、不写 wiki_pages） | 7 |
| §11 综述改产资料文件、默认目标目录规则、>40 确认 | 8 |
| §12 清理三规则对齐主题列、「移到临时存放」 | 9 |
| §6.3 二期多选 | 9 |
| §5.1 二期资料层向量 RRF + 显式降级 | 10 |
| §6.2 二期菜单亮灯 | 11 |
| §13 三期图谱 / ERO | **不做** |

## 不做（防止执行时膨胀）

- `wiki:graph:data` 新模型、结构边 / `belongs_to` / `sibling` / `mentioned_in`
- `wiki:ero:extract`、实体侧栏、`graph_extract_cursor`
- AI 自动综述（`wiki:synthesis:auto-run` 保持现状，不扩展到资料层）
- AI 新建大类/小类、AI 写临时存放、主题树自动重构
- 跨用途多重上架、「其他」「未分类」大类
- 聊天消息摄入（含手工收藏对话进 Wiki）
- 音视频自动转录
- 把 `wiki_pages` 重新变成目录节点

## 已知偏离设计文档之处（实施时按本节）

1. **V23 而非纯 V22**：设计 §2.1 说「一次 schema，三期共用」，但 V22 未包含资料向量表（当前 `SCHEMA_VERSION = 22`）。二期新增 V23 只建 `wiki_source_embeddings` 派生表，不动既有列，不影响三期的 `source_id` 列（V22 已加）。
2. **`wiki:search` 返回形状**：一期 `searchSources` 返回裸数组，二期为承载 `mode` / `degradeReason` 改为对象。属破坏性变更，Task 10 内一次改完所有消费点（含 `wiki-tools.ts` 的 `wiki_search` 工具与 `WikiTab` 的 `searchResults` 状态）。
3. **`accept` 双路径**：设计 §11 说 `accept()` 不再写 `wiki_pages`。实现上保留旧 `accept()` 给存量 `wiki_syntheses`（其 `source_page_ids` 指向历史页），新增 `acceptAsSource()` 承担二期语义。UI 只暴露后者。
4. **单文件「让 AI 建议」不占 run 槽**：设计 §9.1 把 `scope=source` 归入路径 ③ 的候选态。实现上采纳建议后走 `onConfirm` 直写并立即 `discard` 该批次，避免一次单文件建议长期占用「同时只允许一个 run」的槽位。行为对用户无差别，但状态机更干净。
5. **`topicCountKey` 两处实现**：renderer 侧已在 `WikiLeftNav.tsx` 导出，runtime 侧 Task 1 再实现一份（agent-runtime 不应依赖 renderer）。两处必须同为 `JSON.stringify` 两列数组，各留断言测试。

## 一期已提前解决的项（原计划中已移除）

- 清理 stale 判据已改看 `wiki_sources.last_used` / `use_count`，不再 join 页面（`wiki-cleanup.ts:72-83`）
- `wiki:cleanup:scan` 已返回 `topicCategory` / `topicSubtopic`
- `CleanupView` 已按 `大类 / 小类` 展示，临时存放只显示大类名
- `topicCountKey` 已在 renderer 侧落地，二期直接复用
