# Wiki 资料库 P0（引用优先）Implementation Plan

> **For agentic workers:** 按 Task 顺序实施，每个 Task 走「先写失败测试 → 跑失败 → 实现 → 跑通 → 提交」。
> 规格：`docs/design/记忆设计/2026-08-29-wiki-vault-ref-first-design.md`（v1.1 已确认）
> 用户手册（已按新设计更新）：`docs/guide/wiki-user-guide.md`
> 前置设计：`docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md`（v4.1，一/二/三期已落地）

**Goal:** 把 Wiki 从「AI 自动按用途归档的目录」改成「引用优先、人主导分类的资料库」：新资料 100% 进收件箱且不写分类，链接默认只存引用不抓取，用户主动才保存网页正文，左栏收敛为 6 个口语化分区，行内交互收敛为「整行预览 + 一个 ⋯」。

**Architecture:** 三条相对独立的改造线。**(1) 入库线**——`WikiOrganizer` 默认不再调分类器，改走「抽取正文 → 建 source 但不写主题两列 → 建索引 → 标记 inbox done」，收件箱因此变成资料的真实落点而非中转站。**(2) 存储语义线**——V25 给 `wiki_sources` 加 `origin_url` 与 `storage_mode`，让「url 引用 / 已保存网页 / 迁入文件」在数据层可区分，UI 不再靠正则猜。**(3) 展示线**——新增「导航分区 ↔ 旧主题字段」映射层，DB 继续存旧六大类，左栏与列表显示新名称；`归档` 复用既有 `archived_at`，不新造大类。

**Tech Stack:** TypeScript、SQLite（`MIGRATIONS` 数组迁移）、`packages/agent-runtime`（wiki 运行时）、Electron 单通道 IPC `agent-runtime:command`、React + `apps/windows` renderer、Vitest + @testing-library/react

---

## 0. 实施前必读：已核对的现状

以下均为**当前代码实测事实**（非设计文档转述），实施时以此为准，勿凭记忆改写签名。

### 0.1 版本与迁移

- `SCHEMA_VERSION = 24`（`packages/agent-runtime/src/storage/schema.ts:9`）。P2 计划写的「V23」已被 V23（`wiki_inbox.last_outcome`）与 V24（`wiki_source_embeddings`）占用，**本计划新增的是 V25**。
- 迁移机制：`export const MIGRATIONS: ReadonlyArray<readonly [number, string]>`（`schema.ts:152`），`[版本号, SQL]` 元组按升序追加，`LocalDatabase` 自动跑 `version > current` 的项。

### 0.2 `wiki_sources` 实际列

```
id, agent_id, user_id, title, source_path, content_md, content_hash, mime_type,
media_type CHECK(document|image|audio|video), extracted_text, media_meta,
preview_path, origin_context, archived_at, created_at,          -- V16 建表
topic_category, topic_subtopic, last_used, use_count            -- V22 追加
```

**没有** `origin_url`，**没有** `storage_mode`。URL 目前只存在 `wiki_inbox.source_url`；归档时被拼成 `origin_context = "原文链接: {url}"`（`wiki-repo.ts:318-321`），前端再用正则 `parseOriginalUrlFromContext()` 反解（`wikiSourcePreview.ts`）。这是本计划要消除的脆弱点。

### 0.3 自动分类的真实位置

链路：调用方 → `WikiIngestHook`（只写 `wiki_inbox`，`status='pending'`，**入库处不分类**）→ `bridge.startWikiOrganizePolling()` 每 30s 轮询（`bridge.ts:1832-1852`）→ `WikiOrganizeQueue.enqueue` → `WikiOrganizer.organizeBatch()` → `classifyBatch()`（`wiki-organizer.ts:93`）→ `repo.archiveInboxItem(item, category, subtopic)`。

**关键函数**（`wiki-repo.ts:313-340`）——它把「建 source」和「写主题」绑成一个事务，这是 P0 必须拆开的点：

```ts
archiveInboxItem(item: WikiInboxItem, category: string, subtopic: string | null, title?: string): WikiSource {
  const valid = validateTopicAssignment(tree, category, subtopic, { allowParking: true });
  if (!valid.ok) throw new Error(valid.reason);
  return withTransaction(this.db, () => {
    const source = this.createSource({ /* … origin_context = `原文链接: ${item.source_url}` … */ });
    const updated = this.updateSourceTopic(item.agent_id, item.user_id, source.id, category, subtopic);
    this.indexSource(source.id);
    this.markInboxOrganized(item.id, source.id);
    return updated;
  });
}
```

目前**没有任何配置开关**能关掉自动分类，轮询对每条 pending 无条件分类。

### 0.4 「收件箱」在数据层已有对应物

`listSourcesByTopic(agentId, userId, filter)`（`wiki-repo.ts:571-608`）已支持 `unfiled: true` → `topic_category IS NULL AND topic_subtopic IS NULL`，即设计里的收件箱资料态。**注意该查询硬编码 `archived_at IS NULL`**，所以「归档」分区需要新增过滤开关（见 D3）。

`updateSourceTopic`（`wiki-repo.ts:614-635`）先过 `validateTopicAssignment(tree, category, subtopic, { allowParking: true })`，**不接受 `category = null`**——「退回收件箱」需要新增能力。

### 0.5 前端现状与草稿计划的差异

| 草稿计划的说法 | 实测 |
|---|---|
| 新建 `WikiMovePicker.tsx` | 已有 `WikiTopicPicker.tsx`（159 行，两步选择 + AI 建议 props），应改造而非新建 |
| 新建 `wikiCategoryNav.ts` | `WikiNav` 联合类型与 `topicCountKey()` 已定义在 `WikiLeftNav.tsx:5-24` |
| 「⋯ 收纳高级功能」 | `WikiMoreMenu.tsx` 已有 `MENU_ITEMS` 6 项（重编目/编辑主题树/历史页面/清理/综述/重建索引），只缺「知识图谱」 |
| 「行尾仅 ⋯ 菜单」 | `WikiFileList.tsx` 现为 3–4 个平铺按钮（详情/打开/移动/存到临时存放），且**整行不可点**（只有标题按钮触发 `onPreview`）；**当前没有任何行内 ⋯ 菜单组件** |
| `wiki-ingest.ts` | 不存在，实际是 `wiki-ingest-hook.ts` |
| 「P0 不改 schema」 | **本计划改**，见 D2 的理由 |

`WikiTab.tsx` 1216 行，`listSources({})` 全量拉取后在 renderer 用 `useMemo` 切片（`WikiTab.tsx:166, 209-252`）。

### 0.6 网页抓取能力

`packages/agent-runtime/src/tools/built-in/web-fetch-tool.ts` 已有完整 HTML → Markdown 实现，但 `htmlToMarkdown(html)` 在 **89 行是模块私有函数，未导出**；`validateUrl()` / `withTimeout()` 已从 `web-shared.ts` 导出。`WikiContentExtractor` 只处理本地文件与图片，**无任何网络路径**。

---

## 1. 关键设计决定（先读完再动手）

设计文档在几处留了实现自由度，或与代码现状冲突。以下 8 条是本计划的拍板结果，Task 内不再重复论证。

### D1：不做「小类改名」，P0 只映射大类

设计 §3.2 给出新小类表（工作 = 文档·会议·汇报·整合长文）。但 DB 里的实际小类是 `项目/任务资料`、`会议聊天记录`、`汇报总结文稿`……**两套小类不是同一集合，无法一对一映射**。硬造映射会出现两个恶性后果：

1. 「文档」到底对应 `项目/任务资料` 还是 `规则制度文档`？任选其一都会让存量文件显示成错的小类。
2. 主题树是**用户可编辑的 JSON**（`wiki_index_meta.topic_categories`，`wiki-topic-mutate.ts` 已支持增删改），用户改过名之后写死的映射表立刻失效。

**决定：P0 只在一级做映射，小类一律显示 DB 里的真名。** 设计 §3.2 那张稀疏小类表作为 **P1 的一次性主题树迁移目标**（用已有的 `planTopicMutation` / `mergeSubtopic` 达成），不在 P0 用「显示名」伪装。

用户可感知的影响：点「工作」后小类芯片显示 `项目/任务资料 · 会议聊天记录 · 汇报总结文稿 · …`，比设计稿的 4 个多。可接受——设计目标是「一级少而宽」，一级已达标。

### D2：P0 必须改 schema（V25），不用启发式认链接

草稿计划要求「P0 不改 schema，用 `origin_url` + 启发式区分链接」——**自相矛盾**：`origin_url` 列现在根本不存在（见 §0.2），所谓启发式就是继续用正则从 `origin_context` 抠 URL。而 P0 的核心交互（链接卡片、「保存网页内容」按钮的显示条件、保存后切换为 md 预览）全都依赖「这条是 url 引用还是已保存网页」这个判断。用正则支撑核心交互会长期漏判。

**决定：V25 加两列，一次做对。**

```sql
-- V25: 引用优先存储语义。origin_url 把 URL 从 origin_context 正则里解放出来；
-- storage_mode 区分「只存了引用」与「正文已在库内」，决定详情页给不给「保存网页内容」。
ALTER TABLE wiki_sources ADD COLUMN origin_url TEXT;
ALTER TABLE wiki_sources ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'ref'
  CHECK (storage_mode IN ('ref', 'materialized', 'native'));
CREATE INDEX IF NOT EXISTS idx_wiki_sources_storage
  ON wiki_sources (agent_id, user_id, storage_mode);
```

存量行 `storage_mode` 全默认 `'ref'`（存量确实都是「指向磁盘原文件的引用」，语义正确，无需回填）。`origin_url` 存量为 NULL，读取时用 `origin_url ?? parseOriginalUrlFromContext(origin_context)` 兜底一版，**新写入一律走 `origin_url`**。

### D3：`归档` 复用 `archived_at`，不新造旧大类

设计 §3.4 的映射表里 `归档` 一栏是空的（「P0 可映射到专用 legacy 或 `_archive` 标记」）。代码里已有完整归档能力：`archived_at` 列 + `archiveSources()` / `restoreSources()`（`wiki-repo.ts:790, 802`）+ IPC `wiki:source:archive` / `wiki:source:restore`。

**决定：`归档` = `archived_at IS NOT NULL`。** 「移到归档」调 `wiki:source:archive` 而非 `update-topic`；归档分区无小类（与设计 §3.2「归档：无小类」一致）。需要给 `listSourcesByTopic` 加 `archived?: boolean` 开关（默认 false 保持现状）。

### D4：`临时存放` 归入收件箱视图的筛选标签

设计 §3.1 说「稍后处理」不进主题树、作为列表筛选标签。DB 里 `PARKING_CATEGORY = "临时存放"` 的行（`topic_category = '临时存放'`，`topic_subtopic IS NULL`）在新左栏里无家可归。

**决定：收件箱视图 = 未分类资料 + inbox pending 条目，顶部加一个「稍后处理 (N)」筛选芯片**切到 parking 列表。左栏不占位，`WikiNav` 保留 `{ kind: 'parking' }` 但不再由左栏进入。

### D5：`wiki/` 物理目录与 `.lumii-ref` 留给 P1

设计 §4 的 `.lumii-ref` 侧车文件、§7.1 的 `WikiVaultLayout` / `WikiRefStore` 属分期表 P1（设计 §9）。P0 只落 `storage_mode` 的**数据语义**，不落盘。

实施 P1 时注意架构边界（AGENTS.md 第 3 条）：`resolveActiveWorkspaceDir()` 在 `apps/windows/src/main/workspace-paths.ts:37`（Electron 侧），而 `packages/agent-runtime` **不得依赖 Electron**。所以 `WikiVaultLayout` 放在 agent-runtime 时必须接受注入的 `vaultRoot: string`，由 main 侧算好传入（照 `WikiContentExtractorDeps` 的注入风格）。

### D6：关闭自动分类 = 走一条新的「直入收件箱」路径

不要在 `organizeBatch` 里给 `classifyBatch` 包 `if`——分类结果贯穿 run 明细（`WikiOrganizeRunDetailItem.outcome` 有 `archived|degraded|failed`）、`markInboxAttemptFailed` 的重试退避、任务中心文案。加 `if` 会让这些语义半悬空。

**决定：`organizeBatch` 开头按开关分流到新的 `intakeBatch` 私有路径。** 该路径只做「抽取正文 → `repo.fileInboxItemUnclassified(item)` → 建索引 → 标 organized」，每条 outcome 记 `'inbox'`（新增值），不调 LLM、不写主题两列、不产生退避重试（除落库异常）。

开关：`WikiOrganizerOptions.autoClassify`，**默认 `false`**。保留 `true` 分支与其全部测试，供「⋯ → 收件箱 AI 一键分类」（P3，须预览确认）复用同一批代码。

附带收益：默认路径不再为每批新文件调一次分类 LLM。

### D7：入库时**不**抓 URL 的 og/meta

设计 §7.4 提了「入库时仅拉 meta，不拉正文」的可选项。P0 取**最简**分支（设计原文也标了「P0 最简」）：只显示用户填的标题 + 域名。理由是任何入库期网络请求都会把「粘贴链接」从瞬时操作变成可失败的异步操作，与设计 §2「零决策入库」相悖。

### D8：列表继续在 renderer 切片

`WikiTab` 现在 `listSources({})` 全量拉取再 `useMemo` 分桶。改成按分区走 IPC 过滤更「正确」，但会连带重写 6 处 `useMemo`、左栏计数与既有测试，属于与 P0 目标无关的风险。

**决定：沿用客户端切片，只为「归档」分区新增一次按需拉取**（`listSources({ archived: true })`，因为 §0.4 的查询默认排除归档行，全量拉取里根本没有它们）。**已知债务**：单库资料数超约 2000 条后应改服务端过滤，写入下方 P1+ Backlog。

---

## 2. Global Constraints

- **AI 永不静默改分类**（设计 §1.2 硬性约束）：`autoClassify` 默认 false；`wiki:organize:suggest` 只在用户点击时调用；批量 AI 分类必须预览确认（P3）
- **新资料一律主题两列为 NULL**：任何入库路径都不得写 `topic_category`
- 旧数据只读兼容：存量 `topic_category` 经映射显示在新分区下，**不批量改写 DB**
- 主题一律 `topic_category` + `topic_subtopic` 两列。**禁止** `大类/小类` 拼接串做键或 `split('/')`（小类名含 `/` 与 `&`）
- 沿用二期约束：AI 不得改主题树、不得写 `临时存放`、不得把文件分进 `整合长文`
- 用户可见文案中文；左栏不出现「待整理 / 待补分 / 临时存放 / 用途目录树 / 知识图谱」
- **Hub 内弹层必须 `layer={WIKI_MODAL_LAYER}`**（`wikiModalLayer.ts`，值为 `'aboveHub'`）；本计划新增的移动弹层、保存网页确认框都受此约束
- CSS `z-index` 与 `Modal` 的 `layer` 是两套栈机制，新增浮层要同时对齐（`WikiTab.css` 用 `var(--z-overlay)`）
- 提交用 Conventional Commit：`feat(wiki):` / `feat(wiki-ui):` / `refactor(wiki):`
- 验证：`pnpm --filter ./packages/agent-runtime test` + `pnpm --filter ./apps/windows test` + `pnpm typecheck`

---

## 3. File Map

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/agent-runtime/src/storage/schema.ts` | V25：`origin_url` + `storage_mode` | 改 |
| `packages/agent-runtime/src/storage/schema-wiki.test.ts` | V25 断言 | 改 |
| `packages/agent-runtime/src/wiki/wiki-nav-map.ts` | 分区 ↔ 旧大类映射（纯函数，无 DB） | **新建** |
| `packages/agent-runtime/src/wiki/wiki-nav-map.test.ts` | 映射往返 + 未知大类兜底 | **新建** |
| `packages/agent-runtime/src/wiki/wiki-repo.ts` | `fileInboxItemUnclassified`、`clearSourceTopic`、`setSourceStorage`、`listSourcesByTopic` 加 `archived`、`createSource` 收 `originUrl`/`storageMode` | 改 |
| `packages/agent-runtime/src/wiki/wiki-repo.test.ts` | 上述方法单测 | 改 |
| `packages/agent-runtime/src/wiki/wiki-organizer.ts` | `autoClassify` 开关 + `intakeBatch` 路径 | 改 |
| `packages/agent-runtime/src/wiki/wiki-organizer.test.ts` | 默认不分类、开关打开仍分类 | 改 |
| `packages/agent-runtime/src/wiki/types.ts` | `WikiStorageMode`、`WikiOrganizeRunDetailItem.outcome` 加 `'inbox'` | 改 |
| `packages/agent-runtime/src/wiki/wiki-clip-saver.ts` | URL → Markdown（复用 web-fetch 的提取） | **新建** |
| `packages/agent-runtime/src/wiki/wiki-clip-saver.test.ts` | 抓取成功/失败/非法 URL | **新建** |
| `packages/agent-runtime/src/tools/built-in/web-fetch-tool.ts` | 导出 `htmlToMarkdown` | 改 |
| `packages/agent-runtime/src/wiki/index.ts` | 导出新模块 | 改 |
| `apps/windows/src/shared/agent-runtime-commands.ts` | `wiki:link:add`、`wiki:link:save`、`wiki:source:clear-topic` | 改 |
| `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts` | 对应 handler + `mapSourceListItem` 带新字段 | 改 |
| `apps/windows/src/main/ipc/agent-runtime/wiki-commands.test.ts` | handler 单测 | 改 |
| `apps/windows/src/main/ipc/agent-runtime-ipc.ts` | switch 分派 | 改 |
| `apps/windows/src/main/app-ui-control/command-allowlist.ts` | 白名单 | 改 |
| `apps/windows/src/main/agent-runtime/bridge.ts` | organizer 传 `autoClassify: false`、注入 clip saver | 改 |
| `apps/windows/src/main/agent-runtime/bridge-wiki-tools.ts` | 「保存链接」vs「保存网页内容」工具分流 | 改 |
| `.../hooks/business/useWikiPage/useWikiPage.ts` | `addLink` / `saveLink` / `clearSourceTopic` / `listSources` 带 archived | 改 |
| `.../MemoriesPage/components/wikiNavSections.ts` | renderer 侧分区常量 + 图标 + 分桶谓词 | **新建** |
| `.../MemoriesPage/components/WikiLeftNav.tsx` | 重写为 6 分区 + 搜索；`WikiNav` 加 `{ kind: 'archive' }` | 改 |
| `.../MemoriesPage/components/WikiFileRowMenu.tsx` | 行内 ⋯ 菜单（新组件） | **新建** |
| `.../MemoriesPage/components/WikiFileList.tsx` | 整行可点 + 行尾仅 ⋯ | 改 |
| `.../MemoriesPage/components/WikiTopicPicker.tsx` | 一级改显示分区名；归档分支无小类 | 改 |
| `.../MemoriesPage/components/WikiSourceDetailDrawer.tsx` | 链接卡片 + 「保存网页内容」底栏 | 改 |
| `.../MemoriesPage/components/WikiAddLinkModal.tsx` | 粘贴 URL + 标题 | **新建** |
| `.../MemoriesPage/components/WikiMoreMenu.tsx` | 补「知识图谱」项 | 改 |
| `.../MemoriesPage/components/WikiInboxPanel.tsx` | 合并未分类资料 + 稍后处理芯片 | 改 |
| `.../MemoriesPage/components/WikiTab.tsx` | 新 IA 组装、添加入口、归档按需拉取 | 改 |
| `.../MemoriesPage/components/WikiTab.css` | 左栏与行样式 | 改 |
| `apps/windows/src/test/components/*.test.tsx` | 见各 Task | 改/新建 |
| `docs/test/lumii-cli/wiki-vault-p0-test-cases.md` | CLI 用例 | **新建** |

---

## 4. Task 依赖

```
Task 1 (V25 schema)
  └─ Task 2 (repo：不分类落库 / 清分类 / archived 过滤 / storage 字段)
       ├─ Task 3 (organizer 默认不分类)          ← 后端行为闭环，可独立手测
       └─ Task 6 (link:add / link:save IPC)
Task 4 (wiki-nav-map 纯函数)                     ← 无依赖，可并行
  └─ Task 5 (左栏 6 分区 + WikiTab 接线)
       ├─ Task 7 (列表整行可点 + 行内 ⋯)
       ├─ Task 8 (移到… 弹层 + 归档分支)
       └─ Task 9 (详情链接卡片 + 保存网页)        ← 依赖 Task 6 的 IPC
Task 10 (⋯ 补图谱 + 收件箱合并 + 全量回归)        ← 依赖 5–9
```

Task 1–3 与 Task 4 可并行分给不同执行者。**Task 5、7、8、9、10 都改 `WikiTab.tsx`，必须串行。**

---

### Task 1: V25 —— `origin_url` + `storage_mode`（D2）

**Files:**
- Modify: `packages/agent-runtime/src/storage/schema.ts`
- Modify: `packages/agent-runtime/src/storage/schema-wiki.test.ts`
- Modify: `packages/agent-runtime/src/wiki/types.ts`

**Interfaces:**

```ts
// types.ts
/** ref=只存引用（本地文件 / 未保存的 URL）；materialized=文件已复制进 wiki；native=正文在库内（笔记/已保存网页/整合长文） */
export type WikiStorageMode = "ref" | "materialized" | "native";
```

`WikiSource` 行类型加 `readonly origin_url: string | null` 与 `readonly storage_mode: WikiStorageMode`。

- [ ] **Step 1: 写失败测试**（`schema-wiki.test.ts`）

```ts
it("V25 给 wiki_sources 加 origin_url 与 storage_mode，默认 ref", () => {
  const db = createMigratedTestDb();
  expect(SCHEMA_VERSION).toBe(25);
  const cols = db.prepare<{ name: string }>("PRAGMA table_info(wiki_sources)").all().map((c) => c.name);
  expect(cols).toContain("origin_url");
  expect(cols).toContain("storage_mode");
  db.prepare("INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at) VALUES ('s1','ag','u','t','2026-08-29')").run();
  expect(db.prepare<{ storage_mode: string }>("SELECT storage_mode FROM wiki_sources WHERE id='s1'").get()?.storage_mode).toBe("ref");
});

it("storage_mode 只接受三个枚举值", () => {
  const db = createMigratedTestDb();
  expect(() => db.prepare(
    "INSERT INTO wiki_sources (id, agent_id, user_id, title, created_at, storage_mode) VALUES ('s2','ag','u','t','2026-08-29','bogus')",
  ).run()).toThrow();
});
```

- [ ] **Step 2: 跑失败** `pnpm --filter ./packages/agent-runtime exec vitest run src/storage/schema-wiki.test.ts`
- [ ] **Step 3: 实现** —— 在 `MIGRATIONS` 末尾追加 `[25, ...]`，SQL 见 D2；`SCHEMA_VERSION` 改 25。存量不回填（默认值语义已正确）。
- [ ] **Step 4: 测试通过 + `pnpm typecheck`**
- [ ] **Step 5: Commit** `feat(wiki): add origin_url and storage_mode to wiki sources`

---

### Task 2: Repo —— 不分类落库、清分类、归档过滤（D2/D3/D6）

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-repo.test.ts`

**Interfaces:**

```ts
/**
 * 把收件箱条目落成「未分类资料」：建 source（不写主题两列）→ 建索引 → 标 organized。
 * 与 archiveInboxItem 的唯一区别是不调 updateSourceTopic，因此不需要主题树校验。
 * URL 类条目（item_type='search' 或有 source_url）写 origin_url + storage_mode='ref'。
 */
fileInboxItemUnclassified(item: WikiInboxItem, title?: string): WikiSource

/** 退回收件箱：主题两列置 NULL。绕过 validateTopicAssignment（它不接受 null） */
clearSourceTopic(agentId: string, userId: string, sourceId: string): WikiSource

/** 保存网页/迁入后更新存储态与正文；originUrl 传 undefined 表示不动该列 */
setSourceStorage(params: {
  readonly sourceId: string; readonly agentId: string; readonly userId: string;
  readonly storageMode: WikiStorageMode;
  readonly sourcePath?: string; readonly contentMd?: string;
  readonly extractedText?: string; readonly originUrl?: string;
}): WikiSource
```

`createSource` 的入参加可选 `originUrl?: string` 与 `storageMode?: WikiStorageMode`（默认 `'ref'`）。

`listSourcesByTopic` 的 filter 加 `readonly archived?: boolean`：为 `true` 时把硬编码的 `archived_at IS NULL` 换成 `archived_at IS NOT NULL`，**且忽略 category/subtopic/unfiled/parking 分支**（归档是扁平列表，无小类，见 D3）。

- [ ] **Step 1: 写失败测试**（`wiki-repo.test.ts`）

```ts
it("fileInboxItemUnclassified 建出主题为空的资料并标记 inbox 已处理", () => {
  const repo = new WikiRepo(createMigratedTestDb());
  const item = repo.ingestToInbox({ agentId: "ag", userId: "u", itemType: "upload",
    sourcePath: "/tmp/a.pdf", title: "Q3报告.pdf", contentHash: "h1" });
  const [taken] = repo.takeInboxBatch("ag", "u", "upload", 10);
  const s = repo.fileInboxItemUnclassified(taken!);
  expect(s.topic_category).toBeNull();
  expect(s.topic_subtopic).toBeNull();
  expect(s.storage_mode).toBe("ref");
  expect(repo.listSourcesByTopic("ag", "u", { unfiled: true }).map((x) => x.id)).toContain(s.id);
  expect(repo.findInboxById(item.id)!.status).toBe("organized");
});

it("URL 条目落库时写 origin_url，不再只塞 origin_context", () => {
  const repo = new WikiRepo(createMigratedTestDb());
  repo.ingestToInbox({ agentId: "ag", userId: "u", itemType: "search",
    sourcePath: "https://example.com/a", sourceUrl: "https://example.com/a", title: "示例文章", contentHash: "h2" });
  const [taken] = repo.takeInboxBatch("ag", "u", "search", 10);
  const s = repo.fileInboxItemUnclassified(taken!);
  expect(s.origin_url).toBe("https://example.com/a");
  expect(s.storage_mode).toBe("ref");
});

it("clearSourceTopic 把已分类资料退回收件箱", () => {
  const repo = new WikiRepo(createMigratedTestDb());
  const s = repo.createSource({ agentId: "ag", userId: "u", title: "a.md" });
  repo.updateSourceTopic("ag", "u", s.id, "做事记录", "汇报总结文稿");
  const back = repo.clearSourceTopic("ag", "u", s.id);
  expect(back.topic_category).toBeNull();
  expect(repo.listSourcesByTopic("ag", "u", { unfiled: true })).toHaveLength(1);
});

it("archived 过滤只返回已归档，且不受 category 影响", () => {
  const repo = new WikiRepo(createMigratedTestDb());
  const a = repo.createSource({ agentId: "ag", userId: "u", title: "旧项目.docx" });
  repo.updateSourceTopic("ag", "u", a.id, "做事记录", "汇报总结文稿");
  const b = repo.createSource({ agentId: "ag", userId: "u", title: "在用.docx" });
  repo.archiveSources("ag", "u", [a.id]);
  expect(repo.listSourcesByTopic("ag", "u", { archived: true }).map((x) => x.id)).toEqual([a.id]);
  expect(repo.listSourcesByTopic("ag", "u", {}).map((x) => x.id)).toEqual([b.id]);
});

it("setSourceStorage 保存网页后转 native 并写正文", () => {
  const repo = new WikiRepo(createMigratedTestDb());
  const s = repo.createSource({ agentId: "ag", userId: "u", title: "示例文章", originUrl: "https://e.com/a" });
  const after = repo.setSourceStorage({ sourceId: s.id, agentId: "ag", userId: "u",
    storageMode: "native", sourcePath: "/w/wiki/04/a.md", contentMd: "# 标题\n正文", extractedText: "标题 正文" });
  expect(after.storage_mode).toBe("native");
  expect(after.extracted_text).toContain("正文");
  expect(after.origin_url).toBe("https://e.com/a");   // 溯源保留
});
```

- [ ] **Step 2: 跑失败** `pnpm --filter ./packages/agent-runtime exec vitest run src/wiki/wiki-repo.test.ts`
- [ ] **Step 3: 实现**

`fileInboxItemUnclassified` 照 `archiveInboxItem`（`wiki-repo.ts:313`）的事务结构，去掉 `validateTopicAssignment` 与 `updateSourceTopic`，并把 URL 同时写进 `origin_url`（`origin_context` 仍写「原文链接: …」保持旧前端兜底可用）。`setSourceStorage` 用动态 `SET` 片段，只更新传入字段；`WHERE id=? AND agent_id=? AND user_id=?`（照 `updateSourceTopic` 的越权防护）。改 `listSourcesByTopic` 时注意 `archived` 分支要**早于** parking/unfiled 判断。

- [ ] **Step 4: 测试通过 + typecheck**
- [ ] **Step 5: Commit** `feat(wiki): file inbox items without classification and track storage mode`

---

### Task 3: Organizer 默认不再自动分类（D6）

**Files:**
- Modify: `packages/agent-runtime/src/wiki/wiki-organizer.ts`
- Modify: `packages/agent-runtime/src/wiki/wiki-organizer.test.ts`
- Modify: `packages/agent-runtime/src/wiki/types.ts`（`WikiOrganizeRunDetailItem.outcome` 加 `'inbox'`）
- Modify: `apps/windows/src/main/agent-runtime/bridge.ts`

**Interfaces:**

```ts
export interface WikiOrganizerOptions {
  /**
   * 是否让 AI 自动写主题两列。默认 false —— 设计 §1.2「新资料 100% 先进收件箱」。
   * 为 true 时走原分类路径（供 P3「收件箱 AI 一键分类」复用，须由用户显式触发）。
   */
  readonly autoClassify?: boolean;
}
```

`WikiOrganizer` 构造函数末位加 `options: WikiOrganizerOptions = {}`。`organizeBatch` 保留名字与返回类型（`bridge.ts` 轮询与任务中心均依赖），开头分流：

```ts
if (!this.options.autoClassify) return this.intakeBatch(agentId, userId, itemType, batchSize);
```

`intakeBatch` 行为：`takeInboxBatch` → 抽取正文（复用现有 extractor 逻辑）→ 逐条 `repo.fileInboxItemUnclassified` → 明细 `outcome: 'inbox'`、`path: ''`；落库异常才 `markInboxAttemptFailed`。终态 `status: 'succeeded'`，`result_summary` 形如 `3 项已收进收件箱`。**不调 `classifyBatch`，不写 degraded。**

- [ ] **Step 1: 写失败测试**

```ts
it("默认不调分类器，资料进收件箱且主题为空", async () => {
  const callLLM = vi.fn();
  const organizer = new WikiOrganizer(repo, callLLM, extractor);   // 无 options
  hook.ingestUpload("ag", "u", "/tmp/a.pdf", "Q3报告.pdf");
  const run = await organizer.organizeBatch("ag", "u", "upload");
  expect(callLLM).not.toHaveBeenCalled();
  expect(run!.status).toBe("succeeded");
  expect(repo.listSourcesByTopic("ag", "u", { unfiled: true })).toHaveLength(1);
  expect(JSON.parse(run!.result_detail!).items[0].outcome).toBe("inbox");
});

it("autoClassify 打开时仍走原分类路径", async () => {
  const organizer = new WikiOrganizer(repo, fakeClassifyLLM, extractor, { autoClassify: true });
  hook.ingestUpload("ag", "u", "/tmp/a.pdf", "会议纪要.docx");
  const run = await organizer.organizeBatch("ag", "u", "upload");
  expect(repo.listSourcesByTopic("ag", "u", { unfiled: true })).toHaveLength(0);
  expect(run!.status).toBe("succeeded");
});

it("不分类路径仍抽取正文并建索引", async () => {
  const organizer = new WikiOrganizer(repo, vi.fn(), extractor);
  hook.ingestUpload("ag", "u", "/tmp/a.txt", "笔记.txt");
  await organizer.organizeBatch("ag", "u", "upload");
  const [s] = repo.listSourcesByTopic("ag", "u", { unfiled: true });
  expect(s!.extracted_text).toBeTruthy();
  expect(repo.searchSources("ag", "u", "笔记").length).toBeGreaterThan(0);
});

it("重新编目 running 时依然不取件（沿用二期约束）", async () => {
  repo.setReclassifyRun("ag", "u", { runId: "r1", status: "running" } as never);
  hook.ingestUpload("ag", "u", "/tmp/a.pdf", "a.pdf");
  expect(await new WikiOrganizer(repo, vi.fn(), extractor).organizeBatch("ag", "u", "upload")).toBeNull();
});
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现** —— `bridge.ts` 构造 organizer 处显式传 `{ autoClassify: false }`（写死注释指向设计 §1.2，避免以后有人「顺手」打开）。检查 `useWikiTaskCenter` / 任务中心对 `archive` 任务的文案，`'inbox'` outcome 要有对应中文（「已收进收件箱」）。
- [ ] **Step 4: 测试通过**（同时跑 `wiki-organize-queue.test.ts`，它可能断言了 organized 计数）
- [ ] **Step 5: Commit** `feat(wiki): stop auto-classifying new sources by default`
