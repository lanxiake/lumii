# Wiki 知识图谱三期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将知识图谱从「页面+双链」改为「资料+用途结构+实体关系」，实现按资料抽取实体、用途树图层、以及实体-资料关联。

**Architecture:** 新图模型包含 `category` / `subtopic` / `source` / `entity` 四类节点，`belongs_to` / `sibling` / `relation` / `mentioned_in` / `wikilink` 五类边。ERO 抽取改为扫描 `wiki_sources.extracted_text` 并写 `source_id`。图层控制：结构 / 实体关系 / 历史页双链（默认关）。实体侧栏改为「出现于哪些资料」。

**Tech Stack:** TypeScript、SQLite、xyflow（保留）、dagre（保留）、Vitest、React、既有任务中心机制

**Spec:** `docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md` §13（知识图谱）、§14（端到端流程）、§18 三期成功标准

## Global Constraints

- 只做三期。不改一/二期已有功能（主题树编辑、重编目、综述、清理）
- 图层三选一：结构（树+资料）/ 实体关系 / 全部；历史页双链可选，默认关
- `belongs_to` / `sibling` / `mentioned_in` **不落库**，全部现推
- `sibling` 边：该小类 source ≤ 8 才画完全图，> 8 不画（防边爆炸）
- ERO 抽取**仅用户手动触发**，归档成功后绝不自动抽取
- 抽取增量：`graph_extract_cursor` 记 `sourceId` + `content_hash`，正文未变则跳过
- 按文件失败跳过，不回滚已成功实体
- `topic_path` 禁止拼接：一律 `topic_category` + `topic_subtopic` 两列
- 节点上限只约束 `source` + `entity`；`category` / `subtopic` 是分组容器不计数
- 不引入双时态、实体模糊合并、多跳问答
- 用户可见文案中文；提交 Conventional Commit，如 `feat(wiki): ...`
- 验证：`pnpm --filter ./packages/agent-runtime test` + `pnpm --filter ./apps/windows test` + `pnpm typecheck`

---

## 现状与差距

| 项 | 现状 | 三期目标 |
|---|---|---|
| 图数据源 | `wiki_pages` + `wiki_links` 双链 | `wiki_sources` + 用途树现推结构 |
| 节点类型 | `page` / `entity` | `category` / `subtopic` / `source` / `entity` |
| 边类型 | `wikilink` / `relation` | + `belongs_to` / `sibling` / `mentioned_in` |
| 入参中心 | `centerPageId` / `category`(旧枚举) | `centerSourceId` / `category` / `subtopic` / `layers` |
| ERO 抽取源 | `wiki_pages` 最近 N 页 | `wiki_sources.extracted_text` 按目录或 id |
| ERO 归属列 | 写 `page_id` / `source_page_id` | 写 `source_id` |
| 增量 | 无 | `graph_extract_cursor` + `content_hash` |
| 实体侧栏 | 「打开关联页面」 | 「出现于哪些资料」→ 打开原文件 |

Schema 无需变更（V22 已加齐 `source_id`；当前 `SCHEMA_VERSION = 24`）。

---

## File Map

| 文件 | 职责 |
|---|---|
| `packages/agent-runtime/src/wiki/wiki-graph.ts` | 新图模型与子图构建（重写） |
| `packages/agent-runtime/src/wiki/wiki-graph.test.ts` | 新模型断言 |
| `packages/agent-runtime/src/wiki/wiki-ero.ts` | `upsertEntity` / `addObservation` / `upsertRelation` 支持 `sourceId`；新增按 source 反查 |
| `packages/agent-runtime/src/wiki/wiki-ero.test.ts` | source 归属断言 |
| `packages/agent-runtime/src/wiki/wiki-ero-extractor.ts` | `extractFromSources`：按目录/id 抽取，增量游标 |
| `packages/agent-runtime/src/wiki/wiki-ero-extractor.test.ts` | 增量跳过、按文件失败隔离 |
| `packages/agent-runtime/src/wiki/wiki-repo.ts` | `getGraphExtractCursor` / `setGraphExtractCursor` |
| `packages/agent-runtime/src/wiki/index.ts` | 导出新类型 |
| `apps/windows/src/shared/agent-runtime-commands.ts` | `wiki:graph:data` 入参与返回扩展；`wiki:ero:extract` 入参扩展 |
| `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts` | handler 改造 |
| `apps/windows/src/main/ipc/agent-runtime/wiki-commands.test.ts` | handler 测试 |
| `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts` | 新入参封装 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiGraphView.tsx` | 新图层、新节点渲染、实体侧栏改造 |
| `apps/windows/src/test/components/WikiGraphView.test.tsx` | 交互测试 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx` | 图谱入参接线（当前小类为中心） |

---

### Task 1: ERO 归属列改写 source_id

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-ero.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-ero.test.ts`

**Interfaces:**

```ts
upsertEntity(input: {
  agentId: string; userId: string; name: string;
  entityType?: string; pageId?: string | null;
  sourceId?: string | null;          // 新增
}): WikiEntity

addObservation(input: {
  agentId: string; userId: string; entityId: string; content: string;
  sourcePageId?: string | null;
  sourceId?: string | null;          // 新增
}): WikiObservation

upsertRelation(input: {
  ...; sourcePageId?: string | null;
  sourceId?: string | null;          // 新增
}): WikiRelation

/** 三期新增：某资料抽出的实体（供 mentioned_in 现推） */
listEntitiesBySources(agentId: string, userId: string, sourceIds: readonly string[]):
  readonly { entityId: string; sourceId: string }[]

/** 三期新增：实体出现于哪些资料（实体侧栏） */
listSourceIdsForEntity(agentId: string, userId: string, entityId: string): readonly string[]
```

`listEntitiesBySources` 从 `wiki_observations.source_id` 聚合（观察带 source_id，实体本身可能被多份资料共享），并联 `wiki_entities.source_id` 兜底首次归属。

- [ ] **Step 1: 写失败测试**

在 `wiki-ero.test.ts` 追加：

```ts
it("upsertEntity 可绑定 sourceId", () => {
  const e = ero.upsertEntity({ agentId: "ag", userId: "u", name: "Lumii", sourceId: "s1" });
  expect(e.source_id).toBe("s1");
});

it("观察带 sourceId 时可按资料反查实体", () => {
  const e = ero.upsertEntity({ agentId: "ag", userId: "u", name: "Lumii", sourceId: "s1" });
  ero.addObservation({ agentId: "ag", userId: "u", entityId: e.id, content: "本地优先", sourceId: "s1" });
  expect(ero.listEntitiesBySources("ag", "u", ["s1"])).toEqual([{ entityId: e.id, sourceId: "s1" }]);
});

it("实体可反查出现于哪些资料（去重）", () => {
  const e = ero.upsertEntity({ agentId: "ag", userId: "u", name: "Lumii", sourceId: "s1" });
  ero.addObservation({ agentId: "ag", userId: "u", entityId: e.id, content: "a", sourceId: "s1" });
  ero.addObservation({ agentId: "ag", userId: "u", entityId: e.id, content: "b", sourceId: "s2" });
  ero.addObservation({ agentId: "ag", userId: "u", entityId: e.id, content: "c", sourceId: "s1" });
  expect([...ero.listSourceIdsForEntity("ag", "u", e.id)].sort()).toEqual(["s1", "s2"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
pnpm --filter ./packages/agent-runtime exec vitest run src/wiki/wiki-ero.test.ts
```

- [ ] **Step 3: 实现**

三个写方法的 INSERT / UPDATE 都补 `source_id` 列。`upsertEntity` 命中已存在实体时：`source_id` 为空则回填，非空则保留（首次归属不被覆盖）。

`WikiEntity` / `WikiObservation` / `WikiRelation` 类型加 `readonly source_id: string | null`。

`listEntitiesBySources` 用 `IN (...)` 占位符，空数组直接返回 `[]`（防 `IN ()` 语法错）。

- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit** `feat(wiki): attach ERO records to source rows`

---

### Task 2: 增量抽取游标

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.test.ts`

**Interfaces:**

```ts
export const GRAPH_EXTRACT_CURSOR_META_KEY = "graph_extract_cursor";

/** sourceId → 上次抽取时的 content_hash（正文未变则跳过） */
export type WikiGraphExtractCursor = Record<string, string>;

getGraphExtractCursor(agentId: string, userId: string): WikiGraphExtractCursor
setGraphExtractCursor(agentId: string, userId: string, cursor: WikiGraphExtractCursor): void
```

存储键 `graph_extract_cursor:${agentId}:${userId}`，与 `reclassify_run` 同一套 `wiki_index_meta` 机制。

- [ ] **Step 1: 写失败测试**

```ts
it("图谱抽取游标空库返回空对象", () => {
  expect(repo.getGraphExtractCursor("ag", "u")).toEqual({});
});

it("图谱抽取游标可往返且按归属隔离", () => {
  repo.setGraphExtractCursor("ag", "u", { s1: "h1" });
  expect(repo.getGraphExtractCursor("ag", "u")).toEqual({ s1: "h1" });
  expect(repo.getGraphExtractCursor("ag2", "u")).toEqual({});
});

it("游标 JSON 损坏时退化为空对象而非抛错", () => {
  repo.setIndexMeta(`${GRAPH_EXTRACT_CURSOR_META_KEY}:ag:u`, "{ not json");
  expect(repo.getGraphExtractCursor("ag", "u")).toEqual({});
});
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**

`getGraphExtractCursor` 用 try/catch 包 `JSON.parse`，并校验解析结果是非数组对象、值为 string，否则返回 `{}`。理由：游标是纯派生数据，损坏时重抽一遍即可，绝不能让图谱视图整体报错。

- [ ] **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(wiki): persist graph extract cursor per owner`

---

### Task 3: 按资料抽取实体

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-ero-extractor.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-ero-extractor.test.ts`

**Interfaces:**

```ts
export interface WikiEroExtractSourceScope {
  readonly category?: string;
  readonly subtopic?: string;
  readonly sourceIds?: readonly string[];
}

export interface WikiEroExtractSourceResult {
  readonly sourcesScanned: number;
  readonly sourcesSkipped: number;      // 正文未变
  readonly sourcesFailed: number;
  readonly entitiesUpserted: number;
  readonly observationsAdded: number;
  readonly relationsUpserted: number;
  readonly errors: readonly { readonly sourceId: string; readonly title: string; readonly message: string }[];
}

extractFromSources(
  agentId: string,
  userId: string,
  scope: WikiEroExtractSourceScope,
  onProgress?: (done: number, total: number) => void,
): Promise<WikiEroExtractSourceResult>
```

`extractRecent`（按页面）**保留不删**，服务历史页面图层。

- [ ] **Step 1: 写失败测试**

```ts
it("按小类抽取：写 source_id，返回统计", async () => {
  // 建 2 条带 extracted_text 的 source 在「学习资料/调研搜集材料」
  // mock LLM 返回实体+观察+关系 JSON
  // 断言 sourcesScanned=2，entitiesUpserted>0
  // 断言 wiki_observations.source_id 命中这两条 source
});

it("正文未变的资料第二次抽取被跳过", async () => {
  const first = await extractor.extractFromSources("ag", "u", { sourceIds: ["s1"] });
  expect(first.sourcesScanned).toBe(1);
  const second = await extractor.extractFromSources("ag", "u", { sourceIds: ["s1"] });
  expect(second.sourcesScanned).toBe(0);
  expect(second.sourcesSkipped).toBe(1);
});

it("正文变化后重新抽取", async () => {
  // 改 extracted_text + content_hash → 再抽 sourcesScanned=1
});

it("单个资料 LLM 失败不影响其余，也不回滚已成功实体", async () => {
  // LLM 对 s1 抛错、对 s2 正常
  // 断言 sourcesFailed=1、errors[0].sourceId==='s1'
  // 断言 s2 的实体已落库
  // 断言 s1 不进游标（下次仍会重试）
});

it("无 extracted_text 的资料用 title + media_meta 兜底", async () => {
  // 音视频场景
});
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**

取件：`scope.sourceIds` 优先，否则 `repo.listSourcesByTopic(agentId, userId, { category, subtopic })`。两者都空则抛「请先选择要抽取的目录或文件」。

逐条处理（**串行**，与 organizer 一致避免 LLM 配额争抢）：

```ts
const cursor = this.repo.getGraphExtractCursor(agentId, userId);
const nextCursor = { ...cursor };
for (const [i, source] of sources.entries()) {
  const hash = source.content_hash ?? hashOf(source.extracted_text ?? source.title);
  if (cursor[source.id] === hash) { skipped += 1; onProgress?.(i + 1, sources.length); continue; }
  try {
    // 语料：extracted_text ?? (title + media_meta)，截断到 EXTRACT_CHAR_LIMIT
    // 复用既有 buildEroExtractPrompt / parseEroExtractResponse
    // upsertEntity / addObservation / upsertRelation 全部传 sourceId: source.id
    nextCursor[source.id] = hash;   // 仅成功才进游标
  } catch (err) {
    failed += 1; errors.push({ sourceId: source.id, title: source.title, message: String(err) });
  }
  onProgress?.(i + 1, sources.length);
}
this.repo.setGraphExtractCursor(agentId, userId, nextCursor);
```

游标写入放在循环外一次落库；**失败项不写游标**，保证下次重试。

- [ ] **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(wiki): extract entities from sources with incremental cursor`

---

### Task 4: 新图模型 — 节点与边类型

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-graph.ts`（大幅重写）
- Modify: `packages/agent-runtime/src/wiki/wiki-graph.test.ts`
- Modify: `packages/agent-runtime/src/wiki/index.ts`

**Interfaces:**

```ts
export type WikiGraphNodeKind = "category" | "subtopic" | "source" | "entity";
export type WikiGraphEdgeKind = "belongs_to" | "sibling" | "relation" | "mentioned_in" | "wikilink";

export interface WikiGraphNode {
  readonly id: string;
  readonly kind: WikiGraphNodeKind;
  readonly title: string;
  // kind='category': id=category name, title=category name
  // kind='subtopic': id=subtopicNodeId(category, subtopic), title=subtopic
  // kind='source': id=sourceId, title=source.title, sourceId, path?, mediaType, useCount
  // kind='entity': id=`entity:${entityId}`, title=entity name, entityType, sourceIds?
  readonly path?: string;          // source / subtopic 路径（展示 breadcrumb）
  readonly category?: string;      // source / subtopic 所属大类
  readonly subtopic?: string;      // source 所属小类
  readonly mediaType?: string;     // source
  readonly useCount?: number;      // source
  readonly entityType?: string;    // entity
  readonly entityId?: string;      // entity，原始 ID
  readonly sourceId?: string;      // source
  readonly sourceIds?: string[];   // entity，出现于哪些资料
}

export interface WikiGraphEdge {
  readonly id: string;
  readonly kind: WikiGraphEdgeKind;
  readonly source: string;
  readonly target: string;
  readonly label: string;
  readonly strength?: number;
}

export interface WikiGraphData {
  readonly nodes: readonly WikiGraphNode[];
  readonly edges: readonly WikiGraphEdge[];
  readonly truncated: boolean;
}

export type WikiGraphLayer = "structure" | "entities" | "history";

export interface WikiGraphBuildOptions {
  readonly centerSourceId?: string;     // 与 category/subtopic 至少一项
  readonly category?: string;
  readonly subtopic?: string;
  readonly radius?: 0 | 1;              // 默认 1：当前小类 + 同大类其他小类
  readonly limit?: number;              // 默认 50，只限 source + entity
  readonly layers?: readonly WikiGraphLayer[];  // 默认 ['structure', 'entities']
}
```

删除旧的 `centerPageId` / `eroEntities` / `eroRelations` / `includeEntities` 参数。

- [ ] **Step 1: 写失败测试**（先改期望，再改实现）

```ts
it("结构层：大类节点 + 小类节点 + 资料节点 + belongs_to 边", () => {
  // 预置：主题树有「做事记录」→「会议聊天记录」
  // createSource 3 条在该小类
  // buildSubgraph({ category: '做事记录', layers: ['structure'] })
  // 断言 nodes 含 kind='category' 的 id='做事记录'、kind='subtopic' 的 id=subtopicNodeId('做事记录','会议聊天记录')、kind='source' × 3
  // 断言 edges 含 kind='belongs_to' × 3，source=sourceId → target=subtopicNodeId(...)
  // 以及一条 'subtopic'→'category'
});

it("sibling 边：同小类 ≤8 条资料画完全图，>8 不画", () => {
  // 场景 A：5 条 → 边数 5×4/2 = 10
  // 场景 B：10 条 → sibling 边数 0
});

it("实体层：entity 节点 + relation 边 + mentioned_in 边", () => {
  // 预置：1 个 entity 绑 source_id='s1'
  // layers=['entities']
  // 断言 nodes 含 kind='entity'、edges 含 kind='mentioned_in' source='entity:e1' target='s1'
});

it("limit 只约束 source+entity，category/subtopic 不计数", () => {
  // 1 大类 5 小类 60 条资料 → limit=50 → truncated=true，但仍保留 category+subtopic 容器节点
});

it("历史层：page + wikilink（可选，默认不启用）", () => {
  // savePage 建一条旧页
  // layers=['history']
  // 断言 nodes kind='page'（旧数据结构映射）
});
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现新 WikiGraphBuilder**

核心逻辑：

**A. 取资料节点**：
- `centerSourceId` 指定：radius=1 → 该 source 所在小类 + 同大类其他小类的 sources；radius=0 → 仅该小类
- `category` / `subtopic` 指定：按 `listSourcesByTopic`
- 按 `use_count DESC`, `last_used DESC` 排序后截取 limit（**仅限 source**）

**B. 生成结构边（layers 含 'structure'）**：
- `belongs_to`：每个 source → 其 subtopic 节点；每个 subtopic → 其 category 节点
- `sibling`：同一 subtopic 下 source ≤ 8 时，两两连边（完全图）

**C. 生成实体边（layers 含 'entities'）**：
- `relation`：`ero.listRelations` 按 source_id 范围过滤，取两端都在已选 source 内的关系
- `mentioned_in`：`ero.listEntitiesBySources` 聚合当前 sources 的实体 → 每个 entity 连到其出现的 source（多对多）
- entity 节点占用剩余名额（`limit - sourceNodes.length`）

**D. 历史层（layers 含 'history'）**：
- 旧逻辑 `listPages` / `listOutboundLinks` 生成 page 节点与 wikilink 边（兼容）
- page 不占 limit 名额（独立子图）

`WikiGraphNode` ID 规范：
- category: `category name`（大类名本身无歧义）
- subtopic: `JSON.stringify([category, subtopic])`（小类名可含 `/`，用 JSON 避免拼接歧义，与 topicCountKey 一致）
- source: `source.id`
- entity: `entity:${entity.id}`

- [ ] **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(wiki): build topic-source hybrid graph with layer control`

另导出：

```ts
/** 小类节点 ID：JSON 两列序列化，小类名含 / 也不歧义 */
export function subtopicNodeId(category: string, subtopic: string): string;
/** 反解小类节点 ID，非法输入返回 null */
export function parseSubtopicNodeId(id: string): { category: string; subtopic: string } | null;
```

---

### Task 5: IPC 命令改造

**Files:**
- Modify: `apps/windows/src/shared/agent-runtime-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.test.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts`（若 switch 需调整）
- Modify: `apps/windows/src/main/app-ui-control/command-allowlist.ts`（若命令名变动）

**Interfaces:**

```ts
// 改：wiki:graph:data
{
  type: 'wiki:graph:data';
  agentId?: string;
  userId?: string;
  centerSourceId?: string;
  category?: string;
  subtopic?: string;
  radius?: 0 | 1;
  limit?: number;
  layers?: Array<'structure' | 'entities' | 'history'>;
}
// result: { nodes, edges, truncated }  ← 节点/边新增 kind 值

// 改：wiki:ero:extract 增加 scope
{
  type: 'wiki:ero:extract';
  agentId?: string;
  userId?: string;
  category?: string;
  subtopic?: string;
  sourceIds?: string[];
  // 无 scope 参数时保持旧行为（按页面 extractRecent），供历史页面图层用
  target?: 'sources' | 'pages';   // 默认 'sources'
}
// result: {
//   sourcesScanned, sourcesSkipped, sourcesFailed,
//   entitiesUpserted, observationsAdded, relationsUpserted,
//   errors: Array<{ sourceId, title, message }>
// }

// 新增：实体出现于哪些资料（实体侧栏）
{ type: 'wiki:ero:entity-sources'; agentId?: string; userId?: string; entityId: string }
// result: { sources: Array<{ id, title, sourcePath, topicCategory, topicSubtopic, mediaType }> }
```

`wiki:graph:data` handler 去掉「ERO 为空时自动 bootstrapEroFromWikilinks」——三期抽取只手动触发，自动 bootstrap 会在用途图上凭空造出双链派生的实体。`bootstrapEroFromWikilinks` 保留为 `wiki:ero:bootstrap` 显式命令（服务历史页面）。

中心缺省（spec §13.3）：`centerSourceId` / `category` / `subtopic` 全空时，取主题树第一个大类（默认「做事记录」），不抛错。

- [ ] **Step 1: 写失败测试**

```ts
it("graph:data 按小类返回结构子图", async () => {
  // 建 source 在「学习资料/调研搜集材料」
  // 断言返回 nodes 含 category/subtopic/source 三类 kind
});

it("graph:data 无中心参数时缺省到主题树第一个大类", async () => {
  // 断言不抛错，nodes 含 kind='category' 且 title 是默认树首个大类
});

it("graph:data 不再自动 bootstrap ERO", async () => {
  // 调用后断言 wiki_entities 行数仍为 0
});

it("ero:extract 按小类抽取并返回统计", async () => { ... });

it("ero:entity-sources 返回该实体出现的资料及其主题", async () => { ... });
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现 handlers**

`resolveAgentIdForWiki(bridge, undefined, command.agentId)` + `LOCAL_USER_ID` 缺省，与既有 wiki handler 一致。

`ero:extract` 的 `errors` 里的 `message` 须是中文可读文案，不要直接 `String(err)` 暴露堆栈。

- [ ] **Step 4: `pnpm --filter ./apps/windows exec vitest run src/main/ipc/agent-runtime/wiki-commands.test.ts` + typecheck**
- [ ] **Step 5: Commit** `feat(wiki): add source-scoped graph and ERO extract commands`

---

### Task 6: useWikiPage 封装

**Files:**
- Modify: `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts`
- Modify: `apps/windows/src/renderer/hooks/business/useWikiPage/index.ts`

**Interfaces:**

```ts
export type WikiGraphLayer = 'structure' | 'entities' | 'history';

export interface WikiGraphQuery {
  centerSourceId?: string;
  category?: string;
  subtopic?: string;
  radius?: 0 | 1;
  limit?: number;
  layers?: WikiGraphLayer[];
}

export interface WikiEntitySourceRef {
  id: string; title: string; sourcePath: string | null;
  topicCategory: string | null; topicSubtopic: string | null; mediaType: string;
}

// hook 增加/改造：
getGraphData(query: WikiGraphQuery): Promise<WikiGraphData>
extractEroFromSources(scope: { category?: string; subtopic?: string; sourceIds?: string[] }):
  Promise<WikiEroExtractSourceResult>
listEntitySources(entityId: string): Promise<WikiEntitySourceRef[]>
```

`openSource(sourceId)` 已在一期存在，图谱点 source 节点直接复用。

- [ ] **Step 1–4:** hook 无独立单测则由 WikiGraphView 测试覆盖
- [ ] **Step 5: Commit** `feat(wiki-ui): expose source graph queries in useWikiPage`

---

### Task 7: WikiGraphView 重构

**Files:**
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiGraphView.tsx`
- Modify: `apps/windows/src/test/components/WikiGraphView.test.tsx`
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx`（接线当前导航态作为图谱中心）

**Interfaces:**

WikiGraphView prop 改动：

```tsx
interface WikiGraphViewProps {
  currentNav: WikiNav;              // 当前导航态（小类/大类/parking 等）
  getGraphData: (query: WikiGraphQuery) => Promise<WikiGraphData>;
  extractEroFromSources: (scope: ...) => Promise<WikiEroExtractSourceResult>;
  listEntitySources: (entityId: string) => Promise<WikiEntitySourceRef[]>;
  openSource: (sourceId: string) => Promise<void>;
  onNavigateTo: (nav: WikiNav) => void;  // 点 subtopic 容器 / 实体侧栏资料跳转
  runLongTask: <R>(title: string, fn: () => Promise<R>) => Promise<R>;
}
```

删除旧的 `getGraphData(centerPageId, category)` / `onOpenPage` / `bootstrapEro` / `listEntityObservations` prop。

**内部状态：**

```tsx
type [graphLayer, setGraphLayer] = useState<WikiGraphLayer | 'all'>('all');  // 默认全部，不是结构
type [showHistory, setShowHistory] = useState(false);  // 历史页双链开关，默认关
```

**图层计算**（替代旧的 `filterGraph`）：

```ts
const layers: WikiGraphLayer[] = (() => {
  if (graphLayer === 'all') return ['structure', 'entities'];
  if (graphLayer === 'structure') return ['structure'];
  if (graphLayer === 'entities') return ['entities'];
  if (graphLayer === 'history') return ['history'];  // 可与其他图层共存
})();
if (showHistory && !layers.includes('history')) layers.push('history');
```

**查询构造**：

```ts
useEffect(() => {
  const query: WikiGraphQuery = {
    radius: 1,
    limit: 50,
    layers,
  };
  if (currentNav.kind === 'subtopic') {
    query.category = currentNav.category;
    query.subtopic = currentNav.subtopic;
  } else if (currentNav.kind === 'category') {
    query.category = currentNav.name;
  }
  // kind='inbox'/'parking'/'history' 则 query 无中心参数，后端缺省到默认大类
  fetchGraph(query);
}, [currentNav, graphLayer, showHistory]);
```

**节点渲染样式**（复用既有 xyflow Node 组件或内联样式）：

| kind | 样式 |
|---|---|
| `category` | 方形容器（xyflow parent node），蓝色边框粗 2px，无 handle |
| `subtopic` | 嵌套容器（parent），灰色虚线边框，左上角 chevron 图标可点 |
| `source` | 小圆角矩形，左边框彩色条（按 mediaType），右上角打开图标 |
| `entity` | 圆角矩形，粉色边框，右下角实体类型 badge（person/project/tool/concept） |

**边渲染**：

| kind | 样式 |
|---|---|
| `belongs_to` | 直线，蓝色，无箭头（树结构） |
| `sibling` | 虚线，浅灰色，无箭头 |
| `relation` | 有向箭头，主色，label 居中，粗细按 strength（0.3→1px, 0.7→2px, 1.0→3px） |
| `mentioned_in` | 虚线箭头，紫色，entity → source |
| `wikilink` | 有向箭头，绿色（保留旧样式） |

**布局**：`dagre` LR（左→右），category / subtopic 用 xyflow 的 parent node 自动分组。

**交互**：

- 点 `kind='source'` → `openSource(node.sourceId)`，失败 toast 中文「无法打开原文件」
- 点 `kind='entity'` → 设 `selectedEntity`，右侧栏展开
- 点 `kind='subtopic'` 容器 → `onNavigateTo({ kind: 'subtopic', category: node.category, subtopic: node.subtopic })`
- 点 `kind='category'` 容器 → `onNavigateTo({ kind: 'category', name: node.title })`

**实体侧栏改造**：

- 标题：实体名 + 类型 badge
- 删除「打开关联页面」按钮（pageId 已废弃）
- 增加「出现于以下资料」section：
  - `listEntitySources(entityId)` 拉取列表
  - 每行：文件名 + 大类/小类 tag + 打开按钮 → `openSource(source.id)`

**顶栏按钮**：

- 图层 segmented control：结构 / 实体关系 / 全部
- 历史页双链 checkbox，初始关闭，label「包含历史页面」
- 「从本目录抽取实体」→ `extractEroFromSources({ category: currentNav.category, subtopic: currentNav.subtopic })`，走 `runLongTask`

**空状态**：

- 无资料：「暂无资料可显示知识图谱，请先上传或归档文件」
- 有资料但切到实体层且无实体：「尚未抽取实体关系，请点击顶栏「抽取实体」按钮」

- [ ] **Step 1: 组件测试**

```tsx
it("结构图层：渲染大类、小类、资料节点及 belongs_to 边", () => {
  // mock getGraphData 返回 kind='category'/subtopic/source 节点
  // 断言 ReactFlow 收到正确节点数据
});

it("点 subtopic 容器调用 onNavigateTo", () => {
  // 模拟点击 subtopic 节点
  // 断言 onNavigateTo 被调用 { kind: 'subtopic', category: '...', subtopic: '...' }
});

it("点 source 节点调用 openSource", () => { ... });

it("实体侧栏：显示出现资料列表，点打开调用 openSource", () => { ... });

it("历史页双链开关默认关闭", () => {
  // 初始渲染断言 layers 不含 'history'
});
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现 UI**

xyflow parent node 示例（category 容器）：

```tsx
const categoryNode: Node = {
  id: node.id,
  type: 'group',  // xyflow 内建分组类型
  data: { label: node.title },
  style: { border: '2px solid #3b82f6', borderRadius: '8px', padding: '16px' },
};
```

dagre 布局参数：`{ rankdir: 'LR', ranksep: 80, nodesep: 40 }`。

实体侧栏用 `Sheet` 或 `Drawer` 组件（项目内已有），挂在 `ReactFlow` 同级 DOM。

- [ ] **Step 4:** `pnpm --filter ./apps/windows test` 中 WikiGraphView 测试
- [ ] **Step 5: Commit** `feat(wiki-ui): render topic-source graph with entity sidebar`

---

### Task 8: WikiTab 接线与回归

**Files:**
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx`
- Modify: `apps/windows/src/test/components/WikiTab.test.tsx`

**Interfaces:**

WikiTab 传给 WikiGraphView 的 prop：

```tsx
<WikiGraphView
  currentNav={selectedNav}
  getGraphData={wikiPage.getGraphData}
  extractEroFromSources={async (scope) => {
    const result = await taskCenter.wrapAsync('graph', '抽取实体关系', () =>
      wikiPage.extractEroFromSources(scope)
    );
    return result;
  }}
  listEntitySources={wikiPage.listEntitySources}
  openSource={wikiPage.openSource}
  onNavigateTo={setSelectedNav}
  runLongTask={(title, fn) => taskCenter.wrapAsync('graph', title, fn)}
/>
```

`selectedNav` 缺省值改为 `{ kind: 'category', name: '做事记录' }`（而非旧的 'graph' 或 'sources'）。

**手测清单（写进 PR）：**

1. 进入 Wiki → 知识图谱，初始显示「做事记录」大类的全部小类及资料
2. 点某小类容器，左栏切换到该小类，图谱重新以该小类为中心
3. 点资料节点，能打开原文件（失败时 toast 中文）
4. 切换图层到「仅结构」，实体节点消失、relation 边消失
5. 切换图层到「仅实体关系」，category/subtopic 容器消失，只剩 entity 节点
6. 点「从本目录抽取实体」，任务 pill 显示「抽取实体关系 N/M」，完成后图谱出现 entity 节点
7. 点 entity 节点，右侧栏显示「出现于以下资料」，点打开能跳回资料
8. 勾选「包含历史页面」，旧 wiki_pages 节点出现（灰色背景区分）
9. 历史页面开关默认关闭，普通用户看不到旧数据

- [ ] **Step 1: 测试**

```tsx
it("WikiTab 初始渲染传正确 prop 给 WikiGraphView", () => {
  // 断言 currentNav 有默认值、getGraphData / openSource 等 prop 存在
});
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全量 Wiki 测试**

```powershell
pnpm --filter ./packages/agent-runtime exec vitest run src/wiki
pnpm --filter ./apps/windows exec vitest run src/test/components src/main/ipc/agent-runtime/wiki-commands.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit** `test(wiki): update graph view integration tests for phase 3`

---

## Spec coverage（三期）

| Spec | Task |
|---|---|
| ERO 挂资料（source_id） | 1 |
| 增量游标防重抽 | 2 |
| 按资料抽取实体 | 3 |
| 新图模型（4 类节点 5 类边） | 4 |
| 图层控制（结构/实体/历史） | 4+7 |
| 命令入参改造（centerSourceId / category / subtopic / layers） | 5 |
| 实体侧栏改为「出现于哪些资料」 | 7 |
| 点 source 打开原文件 | 7 |
| 点 subtopic 切到列表 | 7 |
| 历史页双链默认关 | 7 |
| sibling 边 ≤8 画全图 | 4 |

## 不做（防止执行时膨胀）

- 实体模糊合并
- 双时态建模
- 多跳问答
- 自动抽取（归档后）
- 图谱可视化编辑（移动节点改主题、合并实体）
- 向量相似度连边
- 跨域混合检索（Wiki / 记忆 / MemPalace）
- 音视频自动转录

---

## 后续可选优化（不在三期范围）

- `belongs_to` / `sibling` 边落库加速：当前每次现推，性能瓶颈在 SQL 连接；可预计算存 `wiki_structure_edges` 表
- 实体去重建议：同名不同类型的实体（Lumii 项目 vs Lumii 公司）聚合展示、候选合并
- 观察软退役 UI：实体侧栏增加「已过时观察」折叠区
- 图谱导出为 Markdown / GraphML
- 跨大类跳数扩圈：radius=2 时跨越大类边界，通过同名实体桥接
