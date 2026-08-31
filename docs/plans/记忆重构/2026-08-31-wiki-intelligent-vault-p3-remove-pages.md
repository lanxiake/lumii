# Wiki 智能资料库 P3：移除历史页面 Implementation Plan

> **For agentic workers:** 按 Task 顺序实施，每个 Task 走「先写失败测试 → 跑失败 → 实现 → 跑通 → 提交」。
> 规格：`docs/design/记忆设计/2026-08-31-wiki-intelligent-vault-design.md`（v1.1）§8
> 与 P2（移除综述）无强依赖，可并行；与 P1（分类体系切换）无强依赖，可并行。

**Goal:** 彻底移除「历史页面」全链路（`wiki_pages` 及其 5 张关联表），存量内容直接随表 DROP，不做迁移补偿（用户已确认）。图谱三期收敛到 structure+entities 两层，ERO 的 wikilink 引导路径删除，`wiki:export`/`wiki:vector:rebuild` 从页面维度切到资料维度。

**Tech Stack:** 同 P0/P1。

---

## 0. 实施前必读：已核实事实

> 已用 grep + 直读文件核实（非转述），行号可直接使用；施工时若代码已变动以实际内容为准。

- **表定义（`packages/agent-runtime/src/storage/schema.ts`）**：`wiki_pages`（471-485，V16，含 `status` 列由 V18 追加于 599-600）、`wiki_page_revisions`（491-502，V16）、`wiki_pages_fts`（523-526，V16 虚表）、`wiki_links`（574-585，V18）、`wiki_page_attachments`（587-597，V18）、`wiki_page_embeddings`（684-695，V20，`PRIMARY KEY REFERENCES wiki_pages(id) ON DELETE CASCADE`）。**六表跨 V16/V18/V20 三个迁移版本引入**，DROP 顺序需注意外键依赖（`wiki_page_attachments`/`wiki_page_embeddings` 引用 `wiki_pages.id`，`wiki_page_revisions` 同样引用，`wiki_links` 无外键约束）：应先 DROP 引用方，最后 DROP `wiki_pages` 本体。
- 依赖页面的模块：`wiki-page-status.ts`（整模块）、`wiki-concept-candidate.ts`（confirm 落页面）。
- **`wiki-graph.ts`（已核实行号）**：`WikiGraphLayer` 类型定义于 15 行（`"structure" | "entities" | "history"`）；`WikiGraphBuildOptions.centerPageId` 于 49 行；`DEFAULT_LAYERS`（139 行）现为 `["structure", "entities"]`——**history 已不在默认层，只在显式传 centerPageId 时才触发**（152-157 行：`buildSubgraph` 检测 `options.centerPageId` 存在则调 `buildFromCenter`，且报错文案「图谱需要 centerPageId 或 category」印证两条路径二选一）；`buildFromCenter` 方法体 385-392 起，内部 `this.repo.findPageById(centerPageId)`，找不到抛错「中心页不存在」。删除时需同步改这条报错逻辑（category 路径变成唯一入口，报错文案要简化）。
- **`wiki-ero.ts`**：`bootstrapEroFromWikilinks` 函数体位于 373 行起（完全基于 `wiki_links`，写 `page_id`，与三期 `wiki:ero:extract` 走 `source_id` 平行独立）。**该函数在两处被 re-export**：`packages/agent-runtime/src/wiki/index.ts:77` 与顶层 `packages/agent-runtime/src/index.ts:415`——删除函数本体后这两处 re-export 也必须删，否则构建直接报错（未核实是否有其他消费方直接 import 顶层 index 的这个符号，实施前建议先删 re-export 再跑 typecheck 让编译器定位所有调用点）。
- **`wiki-graph.test.ts` 与 `wiki-ero.test.ts` 现有测试直接依赖待删符号**：`wiki-graph.test.ts` 第 51/67/107/168 行均调用 `builder.buildSubgraph(..., { centerPageId: ... })`；`wiki-ero.test.ts` 第 7/82 行 import 并调用 `bootstrapEroFromWikilinks`。这些测试用例需要在 Task 3/4 删除对应功能时**同步删除或改写**，不能留着指向已删符号的测试（否则 CI 直接红）。
- **`wiki-commands.ts` 全部 handler 与行号（已核实，重新 grep 定位，前次记录已漂移）**：
  - page 系列：`handleWikiPageList`(371, 内部 376 行调 `listPages`)、`handleWikiPageGet`(387)、`handleWikiPageUpdate`(405)、`handleWikiPageDelete`(421)。
  - link 系列（**注意区分**，见 Task 2 命名撞车提示）：`handleWikiLinkAdd`(851)、`handleWikiLinkSave`(875，async)——**这两个不删**；`handleWikiLinkBacklinks`(946)、`handleWikiLinkUnresolved`(962)——**这两个要删**。
  - `handleWikiPageRevisions`(976)、`handleWikiPageRollback`(993)。
  - `handleWikiAttachList`(1078)、`handleWikiAttachAdd`(1095)、`handleWikiAttachRemove`(1121，内部 1133 行调 `listPages` 用于校验)。
  - `handleWikiConceptScan`(1150, async)、`handleWikiConceptConfirm`(1168)、`handleWikiConceptReject`(1177)。
  - `handleWikiEroBootstrap` 对应 `wiki:ero:bootstrap` 类型判定于 1382 行（函数名待确认，grep 命中的是类型 Extract 语句行，非函数声明行——实施前用 `grep -n "^export.*handleWikiEro"` 补全函数名）。
  - hybrid 检索：`wiki:search:hybrid` 类型判定于 1471 行，内部 1497 行 `bridge.wikiRepo.listPages(...).slice(0, 200)` 用于页面层混合检索。
  - `handleWikiVectorRebuild` 内部 1541 行调 `listPages` 做页面向量重建（函数声明行未在本次 grep 命中，1541 是函数体内部调用点，实施前定位声明行）。
  - `handleWikiStatusScan`(1553, async)、`handleWikiStatusConfirm`(1572)。
- **`command-allowlist.ts` 实际条目（已核实，按物理行分组）**：39 行 `'wiki:page:list', 'wiki:page:get', 'wiki:page:update', 'wiki:page:delete'`；51 行 `'wiki:link:backlinks', 'wiki:link:unresolved', 'wiki:page:revisions', 'wiki:page:rollback'`（**47 行的 `wiki:link:add`/`wiki:link:save` 不在此列，见 Task 2 撞车提示**）；53-54 行 `'wiki:attach:list', 'wiki:attach:add', 'wiki:attach:remove', 'wiki:export'` + `'wiki:concept:scan', 'wiki:concept:confirm', 'wiki:concept:reject'`（**`wiki:export` 混在 attach 这组里，只删前三个 attach 条目，`wiki:export` 保留但改造，见 Task 5**）；57-59 行 `'wiki:graph:data', 'wiki:status:scan', 'wiki:status:confirm'` + `'wiki:ero:bootstrap', 'wiki:ero:list', 'wiki:ero:extract', 'wiki:ero:entity-sources'` + `'wiki:search:hybrid', 'wiki:vector:rebuild'`（**只删 `wiki:ero:bootstrap` 与 `wiki:search:hybrid`；`wiki:graph:data`/`wiki:ero:list`/`wiki:ero:extract`/`wiki:ero:entity-sources`/`wiki:vector:rebuild` 保留，后两者改造见 Task 5**）。
- CLI `commands.mjs`：`wiki page list/get/update`、`wiki search hybrid`、`wiki ero bootstrap`（未在本次核查中重新定位行号）。
- UI：`WikiPageList.tsx`、历史页视图、`WikiMoreMenu` 「历史页面」项、页面状态 UI、概念候选 UI。

---

## 1. 关键设计决定

### D1：V27 纯删除，不迁移

历史页面存量（早期自动归档摘要页、用户/AI 页面书写）直接 DROP，不迁移进 `wiki_sources`。用户已在设计 §14 确认接受该数据损失。执行前 UI 必须提示 `storage:listBackups` 备份路径。

### D2：图谱三期「以资料为中心建图」替代 `centerPageId`

`centerPageId` 路径删除后，「以某份资料为中心看关联」改用既有 `category`/`subtopic` 路径起步查询，而非新建等价页面中心逻辑。三期已知偏离（`centerPageId` 不返回实体节点）随之自然消失，无需专门修复。

### D3：ERO 表结构列保留，仅停写

`wiki_entities`/`wiki_observations`/`wiki_relations` 上如有 `page_id`/`source_page_id` 列，**保留列、停止写入**，不做 schema 收缩。理由：这些列可能被历史数据占用且非本次删除清单核心目标，收缩留给未来单独的 ERO 表清理任务，避免本期改动面扩散。

### D4：`wiki:search` 主检索不变

资料层主检索（`wiki:search`，`wiki_sources_fts` + `wiki_source_embeddings`）不在删除范围内，只删 hybrid（页面层）分支。

---

## 2. Task 列表

### Task 1：V27 迁移（纯 DROP）

**测试先行**：迁移测试断言 V27 执行后 6 张表全部不存在（`sqlite_master` 查询），且 `wiki_sources`/`wiki_source_embeddings` 不受影响（行数不变）。

```sql
-- V27: 移除历史页面全链路。存量内容直接丢弃，用户已确认（design v1.1 §14）。
DROP TABLE IF EXISTS wiki_page_embeddings;
DROP TABLE IF EXISTS wiki_page_attachments;
DROP TABLE IF EXISTS wiki_pages_fts;
DROP TABLE IF EXISTS wiki_links;
DROP TABLE IF EXISTS wiki_page_revisions;
DROP TABLE IF EXISTS wiki_pages;
```

执行前置条件：UI 层在触发迁移前一步展示「即将删除历史页面数据，建议先备份」提示 + `storage:listBackups` 入口，用户确认后才真正跑迁移（这一步是产品确认动作，不是数据库事务的一部分）。

**提交点**：`git commit -m "feat(wiki): V27 drop history-page tables"`。

### Task 2：删除页面相关后端模块

- 删除 `wiki-page-status.ts`（+ 对应 `.test.ts`）。
- 删除 `wiki-concept-candidate.ts`（+ 对应 `.test.ts`）。
- **删除 `wiki-repo.ts` 中以下方法（已核实行号）**：`deletePages`(1011)、`listAttachments`(1068)、`findPageById`(1226)、`listRevisions`(1239)、`listPages`(1277)、`deletePage`(1308)、`listBacklinks`(1330)、`listUnresolvedLinks`(1370)、`updatePageStatus`(1801)。grep 未命中 `createPage`/`updatePage`/`rollbackRevision`/attachment 增删——实施时先跑一次 `grep -n "createPage\|updatePage\b\|rollbackRevision\|addAttachment\|removeAttachment" wiki-repo.ts` 补全实际方法名后再删，不要假设上述清单已完整。

每删一个方法先确认无其他模块引用（`grep` 方法名），再删；每个模块删除后跑一次 `tsc --noEmit` 确认无悬挂引用。

**⚠ 命名撞车，勿删错**：`wiki:link:add`（handler 位于 `wiki-commands.ts:851`）与 `wiki:link:save`（`:875`，async）在白名单里与 `wiki:source:clear-topic`/`wiki:vault:ensure-layout` 同组（`command-allowlist.ts:47`）——这两个是 **P0 ref-first 的存链接/保存网页正文功能**，与 `wiki_links` 反链表无关。**真正要删的历史页面反链命令是 `wiki:link:backlinks`（`:946`）与 `wiki:link:unresolved`（`:962`）**，二者在白名单里单独一行（`:51`）。实施前务必先读一遍 `handleWikiLinkAdd`/`handleWikiLinkSave` 函数体确认它们操作的是 `wiki_sources`/vault 而非 `wiki_links` 表，确认后跳过，不要一并删除。

**提交点**：`git commit -m "feat(wiki): remove page-status and concept-candidate modules"`。

### Task 3：图谱收敛到两层

**测试先行**：`wiki-graph.test.ts` 中所有 `layer: 'history'` / `centerPageId` 相关用例改为断言这些选项被拒绝或不再存在于类型定义中；新增/保留用例覆盖 `category`/`subtopic` 起步的资料中心查询。

- `WikiGraphLayer` 类型删除 `'history'`，只剩 `'structure' | 'entities'`。
- `WikiGraphBuildOptions.centerPageId` 字段删除；`buildFromCenter` 方法删除或改造为基于资料 `category`/`subtopic` 起步（D2）。
- `page` 节点类型、`wikilink` 边类型从图谱构建逻辑中删除。
- `layers` 参数缺省值改为 `['structure', 'entities']`。

**提交点**：`git commit -m "feat(wiki): collapse graph to structure+entities layers"`。

### Task 4：ERO 移除 wikilink 引导路径

**测试先行**：`wiki-ero.test.ts` 中 `bootstrapEroFromWikilinks` 相关用例删除；确认 `wiki:ero:extract`（source_id 路径）用例不受影响、仍全绿。

- 删除 `bootstrapEroFromWikilinks` 函数本体。
- 删除 IPC `wiki:ero:bootstrap` handler、command-allowlist 条目、CLI `wiki ero bootstrap` 子命令。
- ERO 三表 `page_id`/`source_page_id` 列按 D3 保留不动。

**提交点**：`git commit -m "feat(wiki): remove wikilink-based ERO bootstrap path"`。

### Task 5：`wiki:export` / `wiki:vector:rebuild` 切到资料维度

**测试先行**：`wiki-commands.test.ts` 中导出用例改为断言产出的是资料列表而非页面列表；向量重建用例断言只处理 `wiki_source_embeddings`，不再涉及页面向量表（该表已在 Task 1 删除，若原代码仍引用会直接报错，测试即可捕获）。

- `handleWikiExport`：`listPages` 调用替换为 `listSources`；导出文件结构从「页面 md」改为「资料标题+摘要+原文/引用链接」。
- `handleWikiVectorRebuild`：删除页面向量分支，只保留资料向量重建（`WikiSourceVectorIndex.rebuild`）。

**提交点**：`git commit -m "feat(wiki): switch export and vector-rebuild to source dimension"`。

### Task 6：删除 IPC handlers / CLI / 白名单条目

删除清单（以 facts-removal 报告核实后的实际清单为准执行）：

- IPC handlers：page list/get/update/delete、link backlinks/unresolved、page revisions/rollback、concept scan/confirm/reject、status scan/confirm、attach list/add/remove、search:hybrid。
- `command-allowlist.ts`：对应条目全部移除。
- CLI `commands.mjs`：`wiki page *`、`wiki search hybrid`、`wiki ero bootstrap` 子命令删除；测试文档 `docs/test/lumii-cli/` 同步更新。

**提交点**：`git commit -m "feat(wiki): remove page/link/concept/status/attach IPC and CLI surface"`。

### Task 7：前端删除与改造

- 删除 `WikiPageList.tsx`、历史页视图组件、页面状态 UI、概念候选 UI。
- `WikiMoreMenu.tsx`：`MENU_ITEMS` 删除「历史页面」项。
- `WikiGraphView.tsx`：图层选择器删除「历史」选项。
- 检查 `WikiTab.tsx` 中是否有历史页 tab/路由分支，一并删除。

**提交点**：`git commit -m "feat(wiki): remove history-page UI surface"`。

### Task 8：全量验证

- `pnpm --filter agent-runtime test` 全绿。
- `pnpm --filter windows typecheck` 无历史页面相关悬挂引用。
- 手动过一遍：图谱视图只剩两层选择、资料中心查询可用；导出产出资料清单；重建索引不报错。

---

## 3. 风险

| 项 | 处理 |
|---|---|
| 存量页面数据丢失不可逆 | Task 1 执行前 UI 强制展示备份提示；V27 单独成版本，与 P1（V26）解耦，用户可分别决策执行时机 |
| 图谱 `centerPageId` 调用方遗漏 | Task 3 前先全代码库 grep `centerPageId`，确认所有调用点（含前端）一并改造 |
| ERO 表列停写后残留脏数据 | D3 明确不做 schema 收缩，风险接受，留档给未来任务 |
