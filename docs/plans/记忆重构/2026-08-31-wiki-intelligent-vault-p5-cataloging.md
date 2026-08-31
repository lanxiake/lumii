# Wiki 智能资料库 P5（智能全库编目）Implementation Plan

> **For agentic workers:** 按 Task 顺序实施，每个 Task 走「先写失败测试 → 跑失败 → 实现 → 跑通 → 提交」。
> 规格：`docs/design/记忆设计/2026-08-31-wiki-intelligent-vault-design.md` v1.1 §5.1–5.5、§5.9、§6.4
> 前置：**P1 已落地**（树 v2、小类可选、`wiki-taxonomy-prompt.ts`）、**P4 已落地**（`getOrBuildSummary`）

**Goal:** 把「全库重新编目」从名义上的全库（实际 8 条一批、批次互不可见）升级为真正的全库视野：两轮制「结构优先、正文按需」+ 目录锚点样例 + 按目录聚簇切批 + 断点续跑。500 份资料的 LLM 调用从 42 次降到约 19 次，同时因为拿到全局结构视野而更准。

**Architecture:** 复用现有 `wiki:reclassify:*` 状态机与 review 安全网，替换其内部算法。**(1) 盘点线**——新建 `LibraryInventory` 构造器，纯 DB + 文件系统，输出「树 + 每叶子计数 + 每目录 3 条锚点样例 + 按目录聚簇的文件清单（不含正文）」。**(2) 两轮线**——轮 1 结构轮（40–60 条/批，只给文件名+相对路径+当前目录，模型可输出 `needContent`）；轮 2 内容轮（仅 `needContent` 集合，补 P4 摘要，12 条/批）。**(3) 无正文线**——图片/音视频走 §6.4 专用判据（路径语义 + EXIF + 同目录邻居已定分类），全在轮 1 内解决，不进轮 2。

**Tech Stack:** TypeScript、SQLite、`packages/agent-runtime`、Electron IPC、React、Vitest

---

## 0. 实施前必读：现有状态机

### 0.1 `WikiReclassifier` 现状（已读代码确认）

`packages/agent-runtime/src/wiki/wiki-reclassifier.ts`：

```ts
export const RECLASSIFY_BATCH_SIZE = 8;    // L~35
export const RECLASSIFY_TEXT_CHARS = 300;  // L36

interface ReclassifyPromptItem {           // L39-45
  readonly id: string;
  readonly title: string;
  readonly text: string | null;
  readonly fromCategory: string;
  readonly fromSubtopic: string;
}

function corpusOf(source: WikiSource): string | null {   // L180
  return source.extracted_text ?? source.title;
}

export class WikiReclassifier {            // L184
  constructor(
    private readonly repo: WikiRepo,
    private readonly callLLM: (prompt: string) => Promise<string>,
    private readonly newId: () => string = generateWikiId,
  ) {}
  get(agentId, userId): WikiReclassifyRun | null   // L192
  // run / apply / ignore / discard / persist / static isRunning
}
```

**已确认的根因**（设计 §1.4）：`buildReclassifyPrompt` 只接收本批 items + 完整树，**没有全库目录树、没有占用统计、没有跨批记忆**。批次间互相不可见。

run 循环内（L~264）构造 prompt items 时 `text: corpusOf(s)`，即每条都带正文（截 300 字）——这正是 v1.1 要改掉的成本点。

`ReclassifyPromptItem.fromCategory` / `fromSubtopic` 当前是 `string`（非 nullable），run 里用 `s.topic_category!` / `s.topic_subtopic!` 强断言——**P1 小类可选后必须改为 nullable**（见 Task 2）。

### 0.2 现有互斥

`WikiOrganizer` 三处检查 `WikiReclassifier.isRunning`，running 期间自动归档暂停。P6 的增量自动分类需要加入同一互斥。

### 0.3 可复用的全库视野积木

`packages/agent-runtime/src/wiki-classify-context.ts` 已有但**只接入了文件夹导入路径**：

- `buildDirectoryTreeText` — 从文件路径列表生成 ASCII 目录树
- `buildTopicOccupancySummary` — 每小类计数 + 样例标题
- `buildNavSectionGuide` — 分区说明（P1 拆映射后此函数应删除或重写）

Task 1 应**复用前两个**（可能需要改造签名以支持「每目录 3 条锚点」与「小类为空」），而不是从零写。

---

## 1. 关键设计决定

### D1：轮 1 不带正文，由模型自己声明 needContent

不预判「哪些文件需要正文」——那需要另一套启发式，且会错。让模型看完文件名+路径后自己说「判不了」，是最准且零额外成本的分流方式。

轮 1 输出 schema 每条二选一：
```json
{ "id": "s1", "category": "工作", "subtopic": "例行", "confidence": 0.9, "reason": "路径在 项目/周报 下" }
{ "id": "s2", "needContent": true, "reason": "文件名无语义、路径在根目录" }
```

### D2：锚点样例替代决策账本

v1.0 设计的「最近 60 条决策 ledger」有两个问题：每批重发 60 条、前缀成本随进度线性增长；「上一批把某文件放哪了」对当前批一致性帮助有限。

改为**每叶子 3 条代表性样例**（已决策优先、存量次之），规模恒定 `O(叶子数)` ≈ 10×3 行。已应用的决策自然进入下一批样例池，一致性传导仍成立，且续跑时**从当前库状态重建即可，天然幂等**。

### D3：按目录聚簇切批

现状按 id 顺序切批。改为先按 `source_path` 父目录分组、组内保持原序、再按组拼批（单目录超批容量才切分）。

纯排序改动、零额外成本，但同簇文件同批出现时模型一致性显著上升，降低对锚点的依赖。

### D4：置信阈值 0.6（批量），低于增量的 0.75

批量有人工复核（review + apply），可以放宽；P6 增量无人复核，用 0.75。

`confidence < 0.6` 或 `目标 == 当前` → 不产候选（计入 `unchanged`）。

### D5：`scope='all'` 纳入收件箱

v1.1 关键变化：「整理收件箱」与「重新编目」合并为同一能力。`all` = 全库含未分类，不含 parking 与 archived。

---

## Task 1: LibraryInventory 全局盘点

**Owner:** backend
**Files:** 新建 `packages/agent-runtime/src/wiki/wiki-library-inventory.ts` + test；改造 `wiki-classify-context.ts`

### 1.1 接口

```ts
export const ANCHOR_SAMPLES_PER_LEAF = 3;

export interface InventoryFileRow {
  readonly id: string;
  readonly fileName: string;        // basename(source_path) 或 title
  readonly relPath: string;         // 相对 vaultRoot；无 source_path 时为 ""
  readonly fromCategory: string | null;
  readonly fromSubtopic: string | null;
  readonly mediaType: WikiSource["media_type"];
  readonly hasText: boolean;        // extracted_text/content_md 是否非空
  readonly clusterKey: string;      // 父目录，供 D3 聚簇
}

export interface LeafOccupancy {
  readonly category: string;
  readonly subtopic: string | null;   // null = 该大类「未细分」
  readonly count: number;
  readonly anchors: readonly string[]; // 最多 3 条代表性文件名
}

export interface LibraryInventory {
  readonly tree: WikiTopicTree;
  readonly leaves: readonly LeafOccupancy[];
  readonly inboxCount: number;
  readonly files: readonly InventoryFileRow[];   // 已按 clusterKey 聚簇排序
}

export function buildLibraryInventory(
  repo: WikiRepo,
  agentId: string,
  userId: string,
  scope: { kind: "all" } | { kind: "subtopic"; category: string; subtopic: string | null } | { kind: "source"; sourceId: string },
  vaultRoot: string,
): LibraryInventory;
```

**注意架构约束**：`packages/agent-runtime` 不依赖 Electron，`vaultRoot` 必须由调用方（Electron main）注入。

### 1.2 实现要点

1. `listSources({})`，过滤掉 `archived_at != null` 与 `topic_category = PARKING_CATEGORY`
2. `leaves`：遍历树的每个 (大类, 小类) + 每个大类的「未细分」槽位（`subtopic = null`），计数（可复用 `countSourcesByTopic`，但需支持 subtopic 为 null 的分组）
3. `anchors`：每叶子取最多 3 条——优先取本次 run 已 apply 的（Task 3 回填），其次按 `last_used` / `created_at` 降序取存量
4. `files`：按 `clusterKey`（`dirname(relPath)`，空路径归 `""` 簇）分组，组内保持 `created_at` 序，组间按组大小降序（大簇先编目，早期就把主要模式定下来）

### 1.3 测试

```ts
test('盘点排除 archived 与 parking', () => { /* ... */ });
test('leaves 含每大类的「未细分」槽位', () => {
  // 一份 { category: '工作', subtopic: null } 的资料
  const inv = buildLibraryInventory(...);
  expect(inv.leaves).toContainEqual(expect.objectContaining({ category: '工作', subtopic: null, count: 1 }));
});
test('anchors 每叶子最多 3 条', () => { /* ... */ });
test('files 按目录聚簇：同目录文件相邻', () => { /* ... */ });
test('大簇优先', () => { /* ... */ });
test('scope=subtopic 只含该小类', () => { /* ... */ });
test('inboxCount 统计未分类', () => { /* ... */ });
```

---

## Task 2: 结构轮提示词与解析

**Owner:** backend
**Files:** `packages/agent-runtime/src/wiki/wiki-reclassifier.ts`、新建 `wiki-catalog-prompt.ts` + test

### 2.1 全局印象段

```ts
/** 设计 §5.4。规模恒定 O(叶子数)，不随批次增长。 */
export function buildLibraryImpression(inv: LibraryInventory): string {
  const dirLines = inv.tree.categories.map((c) => {
    const parts = c.subtopics.map((s) => {
      const leaf = inv.leaves.find((l) => l.category === c.name && l.subtopic === s);
      return `${s}(${leaf?.count ?? 0})`;
    });
    const unfiled = inv.leaves.find((l) => l.category === c.name && l.subtopic === null);
    if (unfiled?.count) parts.push(`未细分(${unfiled.count})`);
    return `- ${c.name}：${parts.join("、")}`;
  });

  const anchorLines = inv.leaves
    .filter((l) => l.anchors.length > 0)
    .map((l) => `- ${l.category}/${l.subtopic ?? "未细分"}：${l.anchors.join("、")}`);

  return [
    "## 全库现状（本次编目的完整视野）",
    "### 目录结构（数字为该目录现有文件数）",
    ...dirLines,
    `- 收件箱（未分类）(${inv.inboxCount})`,
    "### 各目录已有样例（据此保持一致）",
    ...anchorLines,
  ].join("\n");
}
```

### 2.2 结构轮 prompt

```ts
export const STRUCTURE_BATCH_SIZE = 50;   // 每条只一行，可放 40–60
export const CONTENT_BATCH_SIZE = 12;

export function buildStructurePrompt(
  tree: WikiTopicTree,
  impression: string,
  batch: readonly InventoryFileRow[],
): string {
  const items = batch.map((f, i) =>
    `${i + 1}. [id=${f.id}] ${f.fileName}${f.relPath ? `  路径: ${f.relPath}` : ""}` +
    `  当前: ${f.fromCategory ?? "收件箱"}${f.fromSubtopic ? ` / ${f.fromSubtopic}` : ""}` +
    (f.hasText ? "" : `  (${f.mediaType}，无正文)`)
  ).join("\n");

  return [
    buildTaxonomyGuide(tree),      // P1 的单一真源
    "",
    impression,
    "",
    "## 本批文件（只给了文件名和路径，没有正文）",
    items,
    "",
    "## 本批规则",
    "- 优先把同一文件夹下的文件归到同一处",
    "- 文件夹路径往往已经表达了用户的意图，优先采信",
    "- 光看文件名和路径判不了的，输出 needContent: true，不要硬猜",
    "- 无正文的图片/音视频：靠路径语义 + 同目录已定分类判断；判不了就 needContent（但它没有正文可读，等价于留收件箱并说明原因）",
    "",
    "## 输出 JSON",
    '{"items":[{"id":"...","category":"工作","subtopic":"例行","confidence":0.9,"reason":"..."},{"id":"...","needContent":true,"reason":"..."}]}',
  ].join("\n");
}
```

### 2.3 解析

复用现有 `extractJsonPayload` / `scanBalancedJson`（`wiki-classifier.ts` 已有，健壮处理 `<think>` 块与代码围栏）。

```ts
export interface StructureDecision {
  readonly id: string;
  readonly category: string | null;
  readonly subtopic: string | null;
  readonly confidence: number;
  readonly reason: string;
  readonly needContent: boolean;
}

export function parseStructureResponse(
  raw: string,
  batch: readonly InventoryFileRow[],
  tree: WikiTopicTree,
): { decisions: StructureDecision[]; droppedInvalid: number };
```

校验：`validateTopicAssignment`（P1 已支持 subtopic 可空）；id 不在本批 → drop 并计数；`needContent` 与 category 同时给出时以 category 为准。

### 2.4 测试

```ts
test('全局印象含每叶子计数与未细分槽位', () => { /* ... */ });
test('全局印象规模不随批次增长', () => { /* 断言行数 == 叶子数 + 固定头部 */ });
test('结构轮 prompt 不含正文', () => {
  const p = buildStructurePrompt(tree, imp, batch);
  expect(p).not.toContain(longTextFixture.slice(0, 50));
});
test('结构轮 prompt 标注无正文资料的 mediaType', () => { /* ... */ });
test('解析 needContent 条目', () => { /* ... */ });
test('解析 subtopic 留空的条目', () => { /* category 有、subtopic null → 合法 */ });
test('drop 不在本批的 id', () => { /* ... */ });
test('drop 非法 subtopic 组合', () => { /* ... */ });
test('容忍 <think> 块与代码围栏', () => { /* ... */ });
```

---

## Task 3: 两轮 run 循环 + 断点续跑

**Owner:** backend
**Files:** `packages/agent-runtime/src/wiki/wiki-reclassifier.ts`、`wiki-reclassifier.test.ts`

### 3.1 候选结构扩展

```ts
export interface WikiReclassifyCandidate {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly fromCategory: string | null;    // ← 改 nullable（收件箱）
  readonly fromSubtopic: string | null;    // ← 改 nullable（未细分）
  readonly toCategory: string;
  readonly toSubtopic: string | null;      // ← 可空
  readonly reason: string;
  readonly confidence: number;
  readonly decidedBy: "structure" | "content";   // 新增
  readonly renameTitle?: string;                 // P7 填充，本期留字段
}
```

### 3.2 run 循环

```ts
async run(agentId, userId, scope, opts: { vaultRoot: string }): Promise<WikiReclassifyRun> {
  // Pass A 盘点
  const inv = buildLibraryInventory(this.repo, agentId, userId, scope, opts.vaultRoot);

  // Pass B 结构轮
  const needContent: InventoryFileRow[] = [];
  for (const batch of chunk(inv.files, STRUCTURE_BATCH_SIZE)) {
    const impression = buildLibraryImpression(inv);   // 每批重建，含已 apply 的锚点
    const raw = await this.callLLM(buildStructurePrompt(inv.tree, impression, batch));
    const { decisions, droppedInvalid } = parseStructureResponse(raw, batch, inv.tree);
    for (const d of decisions) {
      if (d.needContent) { needContent.push(rowOf(batch, d.id)); continue; }
      this.collectCandidate(d, "structure");   // 含 confidence < 0.6 / 目标==当前 的过滤
    }
    this.persistProgress(run, { pass: "structure", done: ..., total: ... });
  }

  // Pass C 内容轮（仅 needContent 且 hasText）
  const withText = needContent.filter((f) => f.hasText);
  for (const batch of chunk(withText, CONTENT_BATCH_SIZE)) {
    const summaries = await Promise.all(batch.map((f) =>
      this.summarizer.getOrBuildSummary(this.repo.findSourceById(f.id), { allowLlm: true })
    ));
    const raw = await this.callLLM(buildContentPrompt(inv.tree, impression, batch, summaries));
    // ... 同上，decidedBy: "content"
  }

  // 无正文且 needContent 的：留收件箱，写 reason，不产候选
  return this.toReview(run);
}
```

### 3.3 断点续跑

`failed` 语义升级：run 中途失败时**保留已产候选**并记录 `resumeCursor: { pass, batchIndex }`。续跑时：
- 锚点样例从当前库状态重建（幂等，不需要重放历史）
- 已产候选保留在 review，不重复生成（按 `sourceId` 去重）

### 3.4 测试

```ts
test('两轮：结构轮判定的不进内容轮', async () => {
  const callLLM = vi.fn()
    .mockResolvedValueOnce(structureResponseAllDecided)
    .mockResolvedValueOnce('should not be called');
  await reclassifier.run(...);
  expect(callLLM).toHaveBeenCalledTimes(1);
});

test('needContent 进内容轮并补摘要', async () => { /* ... */ });
test('无正文的 needContent 不进内容轮，留收件箱且有 reason', async () => { /* ... */ });
test('confidence < 0.6 不产候选', async () => { /* ... */ });
test('目标 == 当前不产候选', async () => { /* ... */ });
test('候选 fromCategory 可为 null（收件箱资料）', async () => { /* ... */ });
test('候选 toSubtopic 可为 null（只定大类）', async () => { /* ... */ });
test('decidedBy 正确标记来源', async () => { /* ... */ });
test('调用数符合预期：50 份文件 + 全部结构轮判定 = 1 次', async () => { /* ... */ });
test('断点续跑：已产候选不重复生成', async () => { /* ... */ });
test('running 时再次 run 被拒', async () => { /* 沿用现有互斥 */ });
```

---

## Task 4: apply 支持空小类与 vault sync

**Owner:** backend
**Files:** `packages/agent-runtime/src/wiki/wiki-reclassifier.ts`、`wiki-repo.ts`

### 4.1 实现

`apply` 逐条：
```ts
this.repo.updateSourceTopic(agentId, userId, c.sourceId, c.toCategory, c.toSubtopic);  // toSubtopic 可 null
// vault sync：移动物理文件到 大类/ 或 大类/小类/
```

依赖 P1 的 `updateSourceTopic` 已接受 `subtopic = null`、`vaultDirSegmentsForSource` 已支持一段路径。

失败隔离沿用现有 `applyError`（单条失败不中断整批）。

### 4.2 测试

```ts
test('apply 只定大类的候选：文件落 大类/ 根', async () => { /* ... */ });
test('apply 单条失败不中断整批', async () => { /* ... */ });
test('apply 后锚点样例更新（下一批看到新决策）', async () => { /* ... */ });
```

---

## Task 5: IPC 与预估调用数

**Owner:** backend
**Files:** `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`、`command-allowlist.ts`

### 5.1 `wiki:reclassify:run` 入参扩展

```ts
{ scope: 'all' | 'subtopic' | 'source', category?, subtopic?, sourceId?, allowRename?: boolean }
```

`allowRename` 默认 `false`（P7 才真正使用，本期只透传占位）。

`vaultRoot` 由 handler 从 `workspace-paths.ts` 计算后注入（架构约束：agent-runtime 不依赖 Electron）。

### 5.2 新增 `wiki:reclassify:estimate`

run 前给 UI 显示预估：

```ts
// 出参 { fileCount, structureCalls, estimatedContentCalls, note }
// structureCalls = ceil(fileCount / 50)
// estimatedContentCalls = ceil(fileCount * 0.2 / 12)   // 经验 20% 需正文
```

加入白名单。

### 5.3 测试

```ts
test('estimate: 500 份 → 结构轮 10 次、内容轮约 9 次', () => { /* ... */ });
test('run 注入 vaultRoot', () => { /* ... */ });
```

---

## Task 6: 前端预览与确认

**Owner:** frontend
**Files:** `apps/windows/src/renderer/pages/MemoriesPage/components/WikiReclassifyView.tsx`、`WikiMoreMenu.tsx`

### 6.1 实现

- `WikiMoreMenu` 「全库重新编目」→ 确认弹窗：显示 `estimate` 结果（「将对 N 份资料编目，预计 M 次模型调用」）+ 「同时建议重命名低信息文件名」复选框（默认不勾，P7 生效）
- `WikiReclassifyView` 候选行：`当前位置 → 目标位置`（收件箱显示为「收件箱」，空小类显示为「未细分」）、低置信标记、`decidedBy` 来源标记（结构/内容）
- 进度显示区分两轮（「结构轮 3/10」「内容轮 1/9」）

### 6.2 测试

```ts
test('确认弹窗显示预估调用数', () => { /* ... */ });
test('候选行显示收件箱 → 工作/例行', () => { /* ... */ });
test('候选行显示 工作/例行 → 工作（未细分）', () => { /* ... */ });
test('低置信候选有视觉标记', () => { /* ... */ });
```

---

## 7. 验收

- [ ] `pnpm test` 全绿、`pnpm build` 通过
- [ ] 构造 500 份 fixture（含 100 份收件箱、含图片、含深层目录）跑一次 `all`：
  - [ ] LLM 调用总数 ≤ 25（对照设计 §5.3 的 ≈19）
  - [ ] 结构轮 prompt 中无正文内容
  - [ ] 同目录文件的决策一致（抽查 3 个目录）
- [ ] 手动：收件箱资料被纳入编目（`scope='all'`）
- [ ] 手动：一份深层目录文件（`工作/项目/2026Q3/xx.md`）在结构轮即被正确判定，未进内容轮
- [ ] 手动：一份 `IMG_20260812.jpg` 靠同目录邻居分类成功；判不了时留收件箱并有 reason
- [ ] 手动：run 中途 kill → 重启后候选保留、可续跑
- [ ] 手动：apply 后磁盘文件落到正确目录（含只定大类的落 `大类/` 根）

---

## 8. 风险

| 项 | 处理 |
|---|---|
| 结构轮批次过大导致模型输出截断 | `STRUCTURE_BATCH_SIZE` 设 50 且可配；解析失败时自动对半拆批重试一次 |
| 模型滥用 needContent（全标 true 退化为单轮） | 记录 needContent 比例，> 50% 时在 run 结果里告警；prompt 明确「路径有语义就不要标」 |
| 锚点样例偏置（早期错误决策被后续模仿） | 锚点优先取存量已有（用户历史行为），已 apply 的决策才追加；review 阶段人工把关 |
| 大簇优先导致小簇缺乏上下文 | 小簇文件的锚点仍来自全库，不受簇序影响 |
| 无正文资料永久滞留收件箱 | §6.4 多信号判据 + 明确 reason；本期接受「判不了就留着」，不硬猜 |
| 续跑时库状态已变（用户手动改过） | 锚点从当前状态重建即为最新；候选按 sourceId 去重，冲突时以最新库状态为准 |
