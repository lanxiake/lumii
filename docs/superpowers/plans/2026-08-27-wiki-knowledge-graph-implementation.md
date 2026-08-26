# Wiki 知识图谱 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Wiki「双链图谱」升级为混合知识图谱：实体+页面节点、关系+双链边、三图层；ERO 空库自动冷启动；AI 定时抽取实体关系。

**Architecture:** 扩展 `WikiGraphBuilder` 输出带 `kind` 的混合图（实体 id 前缀 `entity:`）；IPC `wiki:graph:data` 同步字段；`WikiGraphView` 图层过滤 + 实体侧栏；新增 `wiki-ero-extractor` + 每周 companion cron（与综述 03:00 错峰）。

**Tech Stack:** TypeScript、Vitest、现有 WikiEroRepo / xyflow+dagre、Cron companion 指令。

**Spec:** `docs/superpowers/specs/2026-08-27-wiki-auto-synthesis-and-kg-design.md` §3（本 plan **不**改综述自动成页逻辑）

## Global Constraints

- 扩展现有 `wiki:graph:data`，不新开命令。
- 节点 `kind`: `entity` | `page`；边 `kind`: `relation` | `wikilink`。
- 实体节点 id：`entity:<eroId>`。
- 默认图层「全部」；另有「仅实体关系」「仅页面双链」。
- 菜单文案：「双链图谱」→「知识图谱」。
- ERO 为空时打开图谱自动 `bootstrapEroFromWikilinks`。
- AI 抽取：每轮最多 20 页，单页正文截断约 4k 字符；单页失败跳过。
- 中文 UI；函数级注释；Conventional Commits。
- 不做：实体模糊合并 UI、多跳问答、完整观察编辑器、第三方图库。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/agent-runtime/src/wiki/wiki-graph.ts` | 混合图构建（kind、entity 节点） |
| `packages/agent-runtime/src/wiki/wiki-graph.test.ts` | 混合图单测 |
| `packages/agent-runtime/src/wiki/wiki-ero-extractor.ts` | AI 抽取实体/关系/观察 |
| `packages/agent-runtime/src/wiki/wiki-ero-extractor.test.ts` | 抽取单测 |
| `packages/agent-runtime/src/wiki/index.ts` + `packages/agent-runtime/src/index.ts` | 导出 |
| `apps/windows/src/shared/agent-runtime-commands.ts` | graph 结果类型 + `wiki:ero:extract` |
| `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts` | handlers |
| `apps/windows/src/main/ipc/agent-runtime-ipc.ts` | switch |
| `apps/windows/src/main/app-ui-control/command-allowlist.ts` | allowlist |
| `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts` | 类型与 hook |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiGraphView.tsx` | 图层 UI + 侧栏 |
| `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx` | 文案「知识图谱」 |
| `apps/windows/src/main/seed-cron-jobs.ts` | 每周抽取 cron |
| `apps/windows/src/main/agent-runtime/local-companion-handler.ts` | `__wiki_ero_extract__` |
| `apps/windows/src/main/agent-runtime/bridge.ts` | 注入 extract runner |
| `apps/windows/src/test/components/WikiGraphView.test.tsx` | UI 测（新建或扩展） |

---

### Task 1: WikiGraphBuilder 混合图数据层

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-graph.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-graph.test.ts`
- Modify: `packages/agent-runtime/src/wiki/index.ts`（若导出新类型）

**Interfaces:**
- Produces:
  ```typescript
  export type WikiGraphNodeKind = "page" | "entity";
  export type WikiGraphEdgeKind = "wikilink" | "relation";

  export interface WikiGraphNode {
    readonly id: string;
    readonly kind: WikiGraphNodeKind;
    readonly title: string;
    readonly path?: string;       // page
    readonly category?: string;   // page
    readonly useCount?: number;   // page
    readonly entityType?: string; // entity
    readonly pageId?: string | null; // entity → 关联页
  }

  export interface WikiGraphEdge {
    readonly id: string;
    readonly kind: WikiGraphEdgeKind;
    readonly source: string;
    readonly target: string;
    readonly label: string;       // 替代/并存 anchorText：wikilink 用锚文本，relation 用类型
    readonly strength?: number;   // relation
    /** @deprecated 兼容：等于 label */
    readonly anchorText?: string;
  }
  ```

- [ ] **Step 1: 写失败单测（混合节点/边）**

```typescript
it("混合图：页面节点 + 实体节点；wikilink 与 relation 边分 kind", () => {
  const repo = tryCreateRepo();
  if (!repo) return;
  const db = repo.database;
  const ero = new WikiEroRepo(db);

  // 建两页并双链（同现有测）
  // ...
  const e1 = ero.upsertEntity({ agentId: "ag", userId: "u", name: "项目X", entityType: "project", pageId: a.id });
  const e2 = ero.upsertEntity({ agentId: "ag", userId: "u", name: "工具Y", entityType: "tool", pageId: null });
  ero.upsertRelation({
    agentId: "ag", userId: "u",
    sourceEntityId: e1.id, targetEntityId: e2.id,
    relationType: "uses", strength: 0.6, sourcePageId: a.id,
  });

  const g = new WikiGraphBuilder(repo).buildSubgraph("ag", "u", {
    centerPageId: a.id,
    radius: 1,
    limit: 50,
    includeEntities: true,
    eroEntities: ero.listEntities("ag", "u"),
    eroRelations: ero.listRelations("ag", "u"),
  });

  const pageNodes = g.nodes.filter((n) => n.kind === "page");
  const entityNodes = g.nodes.filter((n) => n.kind === "entity");
  expect(entityNodes.some((n) => n.id === `entity:${e1.id}`)).toBe(true);
  expect(g.edges.some((e) => e.kind === "wikilink")).toBe(true);
  expect(g.edges.some((e) => e.kind === "relation" && e.label === "uses")).toBe(true);
});
```

更新既有测试：断言 `kind === "page"`、`edge.kind === "wikilink"`，`anchorText` 仍可读（= label）。

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/agent-runtime && pnpm exec vitest run src/wiki/wiki-graph.test.ts`

Expected: FAIL（缺 kind / entity 节点）

- [ ] **Step 3: 实现混合 finalize**

改写 `toNode` → `toPageNode`；新增 `toEntityNode`：

```typescript
function toPageNode(page: WikiPage): WikiGraphNode {
  return {
    id: page.id,
    kind: "page",
    title: page.title,
    path: page.path,
    category: page.category,
    useCount: page.use_count,
  };
}

function toEntityNode(e: { id: string; name: string; entity_type?: string; page_id: string | null }): WikiGraphNode {
  return {
    id: `entity:${e.id}`,
    kind: "entity",
    title: e.name,
    entityType: e.entity_type ?? "concept",
    pageId: e.page_id,
  };
}
```

`finalize` 逻辑：
1. 页面节点：同现有（截断 limit 先作用于 page 集合）。
2. wikilink 边：`kind: "wikilink"`, `label` = `anchor_text`, `anchorText` = 同值。
3. 若 `includeEntities !== false` 且传入 eroEntities：
   - 纳入与当前 kept **页面**相关的实体（`page_id` 在 keptPages 内，或关系两端实体至少一个关联 kept 页）；实体节点不计入与 page 同一 limit 时可另设 `entityLimit` 默认 50，或总节点 `limit` 先保 page 再填 entity——**本 plan 约定：总节点上限仍为 `limit`，优先保留全部 kept pages，剩余名额给 entity**。
4. relation 边：`source`/`target` 用 `entity:<id>`；仅当两端实体节点都在图中；`kind: "relation"`, `label` = relation_type, `strength`。
5. **停止**旧逻辑「把 ERO 边投影成 page→page」（避免与双链重复语义）；关系只连实体节点。

`WikiGraphBuildOptions` 增加 `includeEntities?: boolean`（默认 true）。

- [ ] **Step 4: 跑通单测**

Run: `cd packages/agent-runtime && pnpm exec vitest run src/wiki/wiki-graph.test.ts`

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/agent-runtime/src/wiki/wiki-graph.ts packages/agent-runtime/src/wiki/wiki-graph.test.ts packages/agent-runtime/src/wiki/index.ts
git commit -m "$(cat <<'EOF'
feat(wiki): 图谱数据层支持实体节点与边 kind

EOF
)"
```

---

### Task 2: IPC / hook 类型 + 打开时自动冷启动

**Files:**
- Modify: `apps/windows/src/shared/agent-runtime-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts`
- Modify: `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.test.ts`（可选）

**Interfaces:**
- Consumes: Task 1 graph shape
- Produces: IPC 返回含 `kind`；`getGraphData` / `WikiGraphDataItem` 同步；可选 `countEntities` 或 bootstrap 返回后 UI 判断

- [ ] **Step 1: 更新命令结果类型**

```typescript
: T extends 'wiki:graph:data' ? {
    nodes: readonly {
      id: string
      kind: 'page' | 'entity'
      title: string
      path?: string
      category?: string
      useCount?: number
      entityType?: string
      pageId?: string | null
    }[]
    edges: readonly {
      id: string
      kind: 'wikilink' | 'relation'
      source: string
      target: string
      label: string
      anchorText?: string
      strength?: number
    }[]
    truncated: boolean
  }
```

`handleWikiGraphData` 映射：builder 已返回新字段则透传；确保传入 `includeEntities: true` 与 ero 列表。

Hook `WikiGraphDataItem` 对齐。

- [ ] **Step 2: 自动冷启动辅助**

在 `handleWikiGraphData` 开头或 UI 调用前：

**推荐 UI 侧（WikiGraphView Task 3）**：load 前若 `ero.list` 实体数为 0 则 `bootstrapEro()`。  
本 Task 可在 hook 增加：

```typescript
const ensureEroBootstrapped = useCallback(async () => {
  const list = await api.sendCommand({ type: 'wiki:ero:list' }) as { entities: unknown[] }
  if ((list?.entities?.length ?? 0) > 0) return { bootstrapped: false }
  return { bootstrapped: true, ...(await bootstrapEro()) }
}, ...)
```

或在 `handleWikiGraphData` 内：entities.length===0 时先 bootstrap 再 build（**更省 UI 往返，推荐**）。

```typescript
let entities = ero.listEntities(...)
let relations = ero.listRelations(...)
if (entities.length === 0) {
  bootstrapEroFromWikilinks(...)
  entities = ero.listEntities(...)
  relations = ero.listRelations(...)
}
```

单测：空 ERO + 有双链页 → graph 含 entity 节点。

- [ ] **Step 3: 提交**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki): graph IPC 返回 kind 并在空 ERO 时自动冷启动

EOF
)"
```

---

### Task 3: WikiGraphView 图层 + 实体侧栏 + 文案

**Files:**
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiGraphView.tsx`
- Modify: `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx`（左栏「图谱」旁文案若写死「双链」则改）
- Modify: `WikiTab.css`（侧栏/图层 chips）
- Create/Modify: `apps/windows/src/test/components/WikiGraphView.test.tsx`

**Interfaces:**
- Consumes: Task 2 `WikiGraphDataItem` with kind
- Produces: layer filter UI；实体点击不直接 `onOpenPage(entityId)`

- [ ] **Step 1: 写 UI 测**

```tsx
it('标题为知识图谱；图层可过滤仅实体关系', async () => {
  const getGraphData = vi.fn(async () => ({
    nodes: [
      { id: 'p1', kind: 'page', title: '页A', path: 'sources/a', category: 'sources', useCount: 0 },
      { id: 'entity:e1', kind: 'entity', title: '实体E', entityType: 'concept', pageId: 'p1' },
    ],
    edges: [
      { id: 'l1', kind: 'wikilink', source: 'p1', target: 'p1', label: '自链', anchorText: '自链' },
      { id: 'r1', kind: 'relation', source: 'entity:e1', target: 'entity:e1', label: 'related_to', strength: 0.5 },
    ],
    truncated: false,
  }))
  render(<WikiGraphView pages={[]} getGraphData={getGraphData} onOpenPage={vi.fn()} bootstrapEro={vi.fn()} />)
  expect(screen.getByText('知识图谱')).toBeTruthy()
  // 选择分类并加载后点「仅实体关系」——断言 wikilink 边不在文档或节点过滤（按实现可测 state）
})
```

- [ ] **Step 2: 实现图层与节点渲染**

状态：`layer: 'all' | 'entities' | 'pages'`。

过滤：

```typescript
function filterGraph(g: WikiGraphDataItem, layer: Layer) {
  if (layer === 'all') return g
  if (layer === 'entities') {
    const nodes = g.nodes.filter((n) => n.kind === 'entity')
    const ids = new Set(nodes.map((n) => n.id))
    const edges = g.edges.filter((e) => e.kind === 'relation' && ids.has(e.source) && ids.has(e.target))
    return { ...g, nodes, edges }
  }
  // pages
  const nodes = g.nodes.filter((n) => n.kind === 'page')
  const ids = new Set(nodes.map((n) => n.id))
  const edges = g.edges.filter((e) => e.kind === 'wikilink' && ids.has(e.source) && ids.has(e.target))
  return { ...g, nodes, edges }
}
```

- 节点类型：`wikiPage` / `wikiEntity`（不同左边框色）。
- `onNodeClick`：若 `kind==='page'` → `onOpenPage(id)`；若 entity → 设 `selectedEntity`，侧栏显示 title、entityType、观察（需 `listObservations`——若无 IPC，本轮侧栏先显示 title/type +「打开关联页」按钮当 `pageId` 存在；观察可后续 `wiki:ero:list` 已有 entities 时暂不拉观察，或扩展 list 返回）。

**观察侧栏本轮最小：** 显示实体名、类型；若有 `pageId` 显示按钮「打开关联页面」。完整观察列表：若 `WikiEroRepo` 已有 `listObservations(entityId)`，加 IPC `wiki:ero:observations` **可选**；无则侧栏不写观察（spec 允许只读摘要——可显示「暂无观察」）。

检查 `listObservations`：若已有按 entity 查询方法则接上；否则 Task 3 侧栏不做观察正文。

- 标题：`知识图谱`；保留「重建双链引导」按钮。
- WikiTab 左栏若为「图谱」可改为「知识图谱」。

- [ ] **Step 3: 跑 UI 测并提交**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki): 知识图谱图层与实体节点 UI

EOF
)"
```

---

### Task 4: AI ERO 抽取 + 每周 cron

**Files:**
- Create: `packages/agent-runtime/src/wiki/wiki-ero-extractor.ts`
- Create: `packages/agent-runtime/src/wiki/wiki-ero-extractor.test.ts`
- Modify: `packages/agent-runtime/src/wiki/index.ts`, `packages/agent-runtime/src/index.ts`
- Modify: `apps/windows/src/shared/agent-runtime-commands.ts`（`wiki:ero:extract`）
- Modify: `wiki-commands.ts`, `agent-runtime-ipc.ts`, `command-allowlist.ts`
- Modify: `seed-cron-jobs.ts`, `local-companion-handler.ts`, `bridge.ts`
- Modify: `useWikiPage.ts`（可选手动「抽取实体」按钮挂 GraphView）

**Interfaces:**
- Produces:
  ```typescript
  export class WikiEroExtractor {
    constructor(repo: WikiRepo, ero: WikiEroRepo, callLLM: (prompt: string) => Promise<string>);
    /** 对最近更新页抽取；默认 maxPages=20, maxCharsPerPage=4000 */
    extractRecent(agentId, userId, options?: { maxPages?: number; maxCharsPerPage?: number }): Promise<{
      pagesProcessed: number;
      entitiesUpserted: number;
      relationsUpserted: number;
      observationsAdded: number;
      errors: readonly string[];
    }>;
  }
  ```

- [ ] **Step 1: 写抽取失败单测（mock LLM）**

```typescript
it("解析 LLM JSON 并 upsert 实体关系；绑定同名页面 page_id", async () => {
  const repo = new WikiRepo(createMigratedTestDb());
  const page = repo.savePage({ agentId: "ag", userId: "u", path: "sources/x", title: "Lumii", contentMd: "Lumii 使用 TypeScript", editor: "ai" });
  const ero = new WikiEroRepo(repo.database);
  const extractor = new WikiEroExtractor(repo, ero, async () =>
    JSON.stringify({
      entities: [{ name: "Lumii", type: "project" }, { name: "TypeScript", type: "tool" }],
      relations: [{ source: "Lumii", target: "TypeScript", type: "uses", strength: 0.5 }],
      observations: [{ entity: "Lumii", content: "桌面宠物应用" }],
    }),
  );
  const r = await extractor.extractRecent("ag", "u", { maxPages: 5 });
  expect(r.entitiesUpserted).toBeGreaterThanOrEqual(2);
  const entities = ero.listEntities("ag", "u");
  expect(entities.find((e) => e.name === "Lumii")?.page_id).toBe(page.id);
});
```

- [ ] **Step 2: 实现 extractor**

Prompt 要求仅 JSON：

```json
{
  "entities": [{"name":"...","type":"person|project|tool|concept|other"}],
  "relations": [{"source":"...","target":"...","type":"...","strength":0.4}],
  "observations": [{"entity":"...","content":"..."}]
}
```

流程：
1. `listPages` 按 `updated_at` 降序取 maxPages。
2. 每页：截断 content_md 到 4k；callLLM；parse（复用 classifier 的 `extractJsonPayload` 若可 import）。
3. upsertEntity：name 匹配已有 page title（同 agent/user）则 `pageId`。
4. upsertRelation：strength 默认 0.4；名称 → entity id map。
5. addObservation：可选一句。
6. 单页 try/catch，errors push。

- [ ] **Step 3: IPC `wiki:ero:extract` + companion cron**

Command → `{ pagesProcessed, entitiesUpserted, relationsUpserted, observationsAdded, errors }`。

Seed job：

```typescript
{
  id: 'wiki-ero-extract',
  name: 'Wiki 实体关系抽取',
  taskText: '__wiki_ero_extract__',
  agentId: null,
  scheduleType: 'cron',
  scheduleExpr: '0 4 * * 0', // 每周日 04:00，错开综述 03:00
  notifyTargets: 'silent',
}
```

Companion + bridge 注入同综述模式。

GraphView 可选按钮「抽取实体关系」调用 hook。

- [ ] **Step 4: 跑测并提交**

```bash
git commit -m "$(cat <<'EOF'
feat(wiki): AI 抽取 ERO 并播种每周 cron

EOF
)"
```

---

## Spec Coverage（§3）

| Spec | Task |
|---|---|
| 混合节点/边 + kind | Task 1 |
| 扩展 wiki:graph:data | Task 2 |
| entity: 前缀 | Task 1 |
| 三图层 + 文案 | Task 3 |
| 空 ERO 自动 bootstrap | Task 2 |
| AI 抽取 20 页 / 4k | Task 4 |
| 错峰 cron | Task 4 |
| 非目标 | 不实现 |

## Plan Self-Review

- 路径/上限与 spec 一致；停止旧「ERO 边投影到 page」以免与双链重复。
- `anchorText` 保留作兼容别名。
- 观察侧栏：有 list API 则接，否则最小实体信息。
