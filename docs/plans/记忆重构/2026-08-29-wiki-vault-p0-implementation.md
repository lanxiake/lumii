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

---

### Task 4: 分区映射纯函数（D1/D3/D4）

**Files:**
- Create: `packages/agent-runtime/src/wiki/wiki-nav-map.ts`
- Create: `packages/agent-runtime/src/wiki/wiki-nav-map.test.ts`
- Modify: `packages/agent-runtime/src/wiki/index.ts`

放在 agent-runtime 而非 renderer：分类建议提示词（`wiki:organize:suggest`）与未来 `wiki/` 目录 slug 都要用同一份映射，不能只活在 UI 里。

**Interfaces:**

```ts
export type WikiNavId = "inbox" | "work" | "study" | "life" | "favorites" | "archive";

export interface WikiNavSection {
  readonly id: WikiNavId;
  readonly label: string;
  /** 归入本分区的旧大类；inbox 与 archive 为空（它们由 NULL / archived_at 判定） */
  readonly legacyCategories: readonly string[];
  /** 磁盘目录名（P1 用；P0 只做常量登记） */
  readonly folderSlug: string;
  /** 一句话边界，写进分类建议提示词与 UI tooltip */
  readonly hint: string;
}

/** 顺序即左栏顺序 */
export const WIKI_NAV_SECTIONS: readonly WikiNavSection[];

/** 旧大类 → 分区；未映射的自定义大类归 work（不吞掉，避免用户新建大类后文件消失） */
export function navIdFromLegacyCategory(category: string | null): WikiNavId;

/** 分区 → 该分区涵盖的旧大类；inbox/archive 返回空数组 */
export function legacyCategoriesForNav(navId: WikiNavId): readonly string[];

/** 「移到…」确定时用哪个旧大类落库：取该分区首个旧大类 */
export function primaryLegacyCategoryForNav(navId: WikiNavId): string | null;

export function navLabel(navId: WikiNavId): string;
```

**映射表（D1：只映射一级）：**

| navId | label | legacyCategories | folderSlug |
|---|---|---|---|
| `inbox` | 收件箱 | —（主题两列 NULL） | `00-收件箱` |
| `work` | 工作 | 做事记录, 计划与复盘 | `01-工作` |
| `study` | 学习 | 学习资料 | `02-学习` |
| `life` | 生活 | 证件凭据, 随笔创作 | `03-生活` |
| `favorites` | 收藏 | 模板参考 | `04-收藏` |
| `archive` | 归档 | —（`archived_at IS NOT NULL`） | `05-归档` |

`临时存放` **不**映射到任何分区（D4，由收件箱视图的筛选芯片承接）——`navIdFromLegacyCategory(PARKING_CATEGORY)` 必须显式返回 `"inbox"`，让它至少可见。

- [ ] **Step 1: 写失败测试**

```ts
it("六大类各自落到正确分区", () => {
  expect(navIdFromLegacyCategory("做事记录")).toBe("work");
  expect(navIdFromLegacyCategory("计划与复盘")).toBe("work");
  expect(navIdFromLegacyCategory("学习资料")).toBe("study");
  expect(navIdFromLegacyCategory("证件凭据")).toBe("life");
  expect(navIdFromLegacyCategory("随笔创作")).toBe("life");
  expect(navIdFromLegacyCategory("模板参考")).toBe("favorites");
});

it("主题为空归收件箱，临时存放也归收件箱（不失踪）", () => {
  expect(navIdFromLegacyCategory(null)).toBe("inbox");
  expect(navIdFromLegacyCategory(PARKING_CATEGORY)).toBe("inbox");
});

it("用户自建大类兜底到工作，不被吞掉", () => {
  expect(navIdFromLegacyCategory("外部协作")).toBe("work");
});

it("往返一致：分区的每个旧大类都能映射回该分区", () => {
  for (const sec of WIKI_NAV_SECTIONS) {
    for (const legacy of sec.legacyCategories) {
      expect(navIdFromLegacyCategory(legacy)).toBe(sec.id);
    }
  }
});

it("inbox 与 archive 没有可写入的旧大类", () => {
  expect(primaryLegacyCategoryForNav("inbox")).toBeNull();
  expect(primaryLegacyCategoryForNav("archive")).toBeNull();
  expect(primaryLegacyCategoryForNav("work")).toBe("做事记录");
});

it("六个分区顺序与设计 §3.1 一致", () => {
  expect(WIKI_NAV_SECTIONS.map((s) => s.label)).toEqual(["收件箱","工作","学习","生活","收藏","归档"]);
});
```

- [ ] **Step 2: 跑失败** `pnpm --filter ./packages/agent-runtime exec vitest run src/wiki/wiki-nav-map.test.ts`
- [ ] **Step 3: 实现**（纯常量 + 查表，不碰 DB）
- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit** `feat(wiki): map legacy topic categories to nav sections`

---

### Task 5: 左栏 6 分区 + WikiTab 接线（设计 §5.1）

**Files:**
- Create: `apps/windows/src/renderer/pages/MemoriesPage/components/wikiNavSections.ts`
- Modify: `.../components/WikiLeftNav.tsx`
- Modify: `.../components/WikiTab.tsx`、`WikiTab.css`
- Modify: `apps/windows/src/test/components/WikiTab.test.tsx`
- Modify: `.../hooks/business/useWikiPage/useWikiPage.ts`

**Interfaces:**

`WikiNav`（定义在 `WikiLeftNav.tsx:5-14`）**加一个 kind，其余保留**——`graph`/`cleanup`/`synthesis`/`reclassify`/`history`/`parking` 仍需存在，只是改由 ⋯ 菜单或筛选芯片进入：

```ts
export type WikiNav =
  | { kind: 'inbox' } | { kind: 'parking' } | { kind: 'graph' } | { kind: 'history' }
  | { kind: 'cleanup' } | { kind: 'synthesis' } | { kind: 'reclassify' }
  | { kind: 'archive' }                                   // 新增（D3）
  | { kind: 'category'; name: string }                    // name 改存 WikiNavId
  | { kind: 'subtopic'; category: string; subtopic: string }  // category 仍是旧大类真名
```

**注意这里的不对称**（务必按此实现，否则计数与查询会错位）：`{ kind: 'category' }` 的 `name` 存**分区 id**（一个分区可能横跨两个旧大类，存单个旧大类表达不了）；`{ kind: 'subtopic' }` 的 `category` 存**旧大类真名**（小类只属于一个旧大类，D1 不改小类）。

```ts
// WikiLeftNavProps —— 去掉 tree/parkingCount，改传分区计数
interface WikiLeftNavProps {
  active: WikiNav | { kind: 'more' }
  /** key = WikiNavId，值为该分区可见资料数 */
  navCounts: Record<WikiNavId, number>
  /** 收件箱角标：未分类资料 + inbox pending 条目 */
  inboxBadge: number
  moreButtonRef?: React.RefObject<HTMLButtonElement>
  onSelect: (nav: WikiNav) => void
  onOpenMore: () => void
  onOpenSearch: () => void
}
```

左栏结构：6 个分区按钮（`WIKI_NAV_SECTIONS` 顺序，收件箱带角标）→ 分隔线 → 「搜索」→ 底部「⋯ 更多」。**删除**「待整理 / 知识图谱 / 临时存放」三个固定项与整棵用途树渲染（`WikiLeftNav.tsx:88-144`）。小类不再进左栏——改为主列表内的小类芯片行（Task 7）。

`WikiTab` 侧：
- `navCounts` 由现有全量 `sources` 数组 `useMemo` 出来（`navIdFromLegacyCategory(s.topic_category)` 分桶）
- 归档分区按需拉取：`nav.kind === 'archive'` 时调 `listSources({ archived: true })`，结果存独立 state，**不混进 `sources`**（否则其它分区计数会被污染）
- `useWikiPage.listSources` 的 filter 类型加 `archived?: boolean`，透传给 `wiki:source:list`
- 默认落地分区：收件箱（沿用现有 `{ kind: 'inbox' }` 初值）

- [ ] **Step 1: 写失败测试**（`WikiTab.test.tsx`；现有第一个用例断言的是旧用途树，需整体重写）

```tsx
it("左栏只渲染六个分区加搜索，不含旧固定项", async () => {
  render(<WikiTab />)
  for (const label of ['收件箱','工作','学习','生活','收藏','归档','搜索']) {
    expect(await screen.findByRole('button', { name: new RegExp(label) })).toBeInTheDocument()
  }
  expect(screen.queryByRole('button', { name: /待整理/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /知识图谱/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /临时存放/ })).not.toBeInTheDocument()
})

it("旧数据按映射出现在新分区：做事记录 → 工作", async () => {
  const send = mockSendCommand({
    'wiki:source:list': { sources: [
      { id: 's1', title: '周报.docx', topicCategory: '做事记录', topicSubtopic: '汇报总结文稿' },
      { id: 's2', title: '教程.pdf', topicCategory: '学习资料', topicSubtopic: '调研搜集材料' },
    ] },
  })
  render(<WikiTab />)
  await userEvent.click(await screen.findByRole('button', { name: /工作/ }))
  expect(await screen.findByText('周报.docx')).toBeInTheDocument()
  expect(screen.queryByText('教程.pdf')).not.toBeInTheDocument()
})

it("计划与复盘 也归到工作分区", async () => { /* 同上，topicCategory: '计划与复盘' */ })

it("收件箱角标 = 未分类资料 + pending 条目", async () => {
  // sources 里 2 条 topicCategory=null，wiki:inbox:count 返回 1 → 角标 3
  render(<WikiTab />)
  expect(await screen.findByRole('button', { name: /收件箱\s*3/ })).toBeInTheDocument()
})

it("点归档分区时按 archived 过滤重新拉取", async () => {
  const send = mockSendCommand({})
  render(<WikiTab />)
  await userEvent.click(await screen.findByRole('button', { name: /归档/ }))
  await waitFor(() => expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'wiki:source:list', archived: true })))
})
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4:** `pnpm --filter ./apps/windows exec vitest run src/test/components/WikiTab.test.tsx` + typecheck
- [ ] **Step 5: Commit** `feat(wiki-ui): replace topic tree nav with six plain sections`

---

### Task 6: 添加链接 + 保存网页内容（后端，设计 §5.6 / §6.1 / §6.2）

**Files:**
- Create: `packages/agent-runtime/src/wiki/wiki-clip-saver.ts` + `.test.ts`
- Modify: `packages/agent-runtime/src/tools/built-in/web-fetch-tool.ts`（导出 `htmlToMarkdown`）
- Modify: `apps/windows/src/shared/agent-runtime-commands.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts` + `.test.ts`
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts`、`command-allowlist.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge.ts`、`bridge-wiki-tools.ts`

**Interfaces:**

```ts
// wiki-clip-saver.ts —— 注入 fetch，保持 agent-runtime 可测且不依赖 Electron
export interface WikiClipSaverDeps {
  readonly fetchImpl?: typeof fetch;
  /** 落盘；P0 由 main 传入写 outputs 的实现，P1 改写 wiki/ 目录（D5） */
  readonly writeFile: (relPath: string, content: string) => Promise<string>;
  readonly timeoutSeconds?: number;
}

export interface WikiClipResult {
  readonly title: string;
  readonly markdown: string;
  /** writeFile 返回的绝对路径 */
  readonly savedPath: string;
}

export class WikiClipSaver {
  constructor(deps: WikiClipSaverDeps);
  /** 抓取并转 md。非 http(s)、超时、非 2xx 一律抛中文错误（调用方保留 url-ref 供重试） */
  async save(url: string, fallbackTitle: string): Promise<WikiClipResult>;
}
```

IPC：

```ts
{ type: 'wiki:link:add'; agentId?: string; sessionKey?: string; url: string; title?: string }
// result: { sourceId: string; title: string }
// 行为：直接建未分类 source（storage_mode='ref', origin_url=url），不进 inbox 队列、不抓取（D7）
// title 缺省时用 hostname；非 http(s) 抛中文错误

{ type: 'wiki:link:save'; agentId?: string; sourceId: string }
// result: { sourceId: string; savedPath: string; title: string }
// 行为：读 origin_url → clipSaver.save → repo.setSourceStorage(storageMode:'native', …) → indexSource
// origin_url 为空时抛「这条资料没有网址，无法保存网页内容」

{ type: 'wiki:source:clear-topic'; agentId?: string; sourceId: string }
// result: { id: string }
// 行为：repo.clearSourceTopic —— 详情/⋯ 的「退回收件箱」
```

`wiki:link:add` **不走 inbox 队列**：队列的价值是异步抽取正文，而 url-ref 没有正文可抽（D7），过队列只会让「粘贴完立刻看到」变成「等 30s 轮询」。设计 §6.1 的时序图也是 Main 直接写库。

`mapSourceListItem` 与 `wiki:source:get` 的返回都要带 `originUrl` 与 `storageMode`（Task 9 的 UI 依赖）。

Agent 工具（`bridge-wiki-tools.ts`）：新增 `wiki_save_link`，描述里写明**只存链接不下载正文**；正文下载不给 Agent 自主权（设计 §5.4「Agent 侧同理：只建 ref」），需要正文时由用户在 UI 点。

- [ ] **Step 1: 写失败测试**

```ts
// wiki-clip-saver.test.ts
it("抓取 HTML 转 md 并落盘", async () => {
  const saver = new WikiClipSaver({
    fetchImpl: async () => new Response('<html><head><title>示例</title></head><body><h1>标题</h1><p>正文</p></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } }),
    writeFile: async (rel, content) => { written = content; return `/tmp/${rel}` },
  });
  const r = await saver.save('https://example.com/a', '兜底标题');
  expect(r.title).toBe('示例');
  expect(r.markdown).toContain('正文');
  expect(r.savedPath).toMatch(/^\/tmp\//);
});

it("非 http(s) 直接拒绝，不发请求", async () => {
  const fetchImpl = vi.fn();
  const saver = new WikiClipSaver({ fetchImpl, writeFile: async () => '' });
  await expect(saver.save('file:///etc/passwd', 't')).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("非 2xx 抛错且不落盘", async () => {
  const writeFile = vi.fn();
  const saver = new WikiClipSaver({ fetchImpl: async () => new Response('', { status: 404 }), writeFile });
  await expect(saver.save('https://e.com/a', 't')).rejects.toThrow(/404|失败/);
  expect(writeFile).not.toHaveBeenCalled();
});
```

```ts
// wiki-commands.test.ts
it("link:add 建出未分类的 url 引用，不抓取", async () => {
  const r = await handleWikiLinkAdd(bridge, { type: 'wiki:link:add', url: 'https://e.com/a', title: '示例文章' } as never)
  const s = bridge.wikiRepo.findSourceById(r.sourceId)!
  expect(s.topic_category).toBeNull()
  expect(s.origin_url).toBe('https://e.com/a')
  expect(s.storage_mode).toBe('ref')
  expect(s.extracted_text).toBeFalsy()
})

it("link:add 缺 title 时用域名兜底；非法 url 拒绝", async () => {
  const r = await handleWikiLinkAdd(bridge, { type: 'wiki:link:add', url: 'https://example.com/x' } as never)
  expect(bridge.wikiRepo.findSourceById(r.sourceId)!.title).toContain('example.com')
  await expect(handleWikiLinkAdd(bridge, { type: 'wiki:link:add', url: 'notaurl' } as never)).rejects.toThrow()
})

it("link:save 把 ref 变 native 并写入正文", async () => {
  const added = await handleWikiLinkAdd(bridge, { type: 'wiki:link:add', url: 'https://e.com/a' } as never)
  await handleWikiLinkSave(bridge, { type: 'wiki:link:save', sourceId: added.sourceId } as never)
  const s = bridge.wikiRepo.findSourceById(added.sourceId)!
  expect(s.storage_mode).toBe('native')
  expect(s.extracted_text).toBeTruthy()
  expect(s.origin_url).toBe('https://e.com/a')
})

it("对无 origin_url 的资料调 link:save 报中文错误", async () => {
  const s = bridge.wikiRepo.createSource({ agentId: 'assistant', userId: 'local-user', title: 'a.pdf' })
  await expect(handleWikiLinkSave(bridge, { type: 'wiki:link:save', sourceId: s.id } as never))
    .rejects.toThrow(/网址/)
})
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**

`htmlToMarkdown`（`web-fetch-tool.ts:89`）改为 `export function`，从 `wiki-clip-saver.ts` 导入复用；`validateUrl` / `withTimeout` 从 `web-shared.ts` 取。落盘路径 P0 沿用 `outputs/wiki-clips/<id>-<slug>.md`（`sanitizeFilenameSegment` + `resolveUniqueFilename` 已在 `wiki-exporter.ts` 导出），P1 迁 `wiki/`。四个新命令记得同步 `agent-runtime-ipc.ts` 的 switch 与 `command-allowlist.ts`。

- [ ] **Step 4: 测试通过 + typecheck**
- [ ] **Step 5: Commit** `feat(wiki): add url references and on-demand page clipping`

---

### Task 7: 列表整行可点 + 行尾仅 ⋯（设计 §5.2）

**Files:**
- Create: `.../components/WikiFileRowMenu.tsx` + `apps/windows/src/test/components/WikiFileRowMenu.test.tsx`
- Modify: `.../components/WikiFileList.tsx`
- Modify: `apps/windows/src/test/components/WikiFileList.test.tsx`
- Modify: `.../components/WikiTab.tsx`、`WikiTab.css`

**现状**：`WikiFileList` 每行是 3–4 个平铺按钮（详情 / 打开 / 移动 / 存到临时存放），整行不可点，且**没有任何行内菜单组件可复用**。

**Interfaces:**

```tsx
interface WikiFileRowMenuProps {
  readonly item: WikiSourceListItem
  readonly onMove: () => void
  /** 仅 storageMode==='ref' 且有 originUrl 时给 */
  readonly onSaveWebPage?: () => void
  /** 仅 storageMode==='ref' 且有 sourcePath 时给（P2 实现，P0 传 undefined 即隐藏） */
  readonly onMaterialize?: () => void
  readonly onPark?: () => void
  readonly onBackToInbox?: () => void
  readonly onOpenOriginal?: () => void
  readonly onDelete: () => void
}
```

菜单项顺序（设计 §5.2）：移到… · 保存网页内容 · 迁入 wiki · 稍后处理 · 退回收件箱 · 打开原文件 · 删除。传 `undefined` 的项不渲染。

`WikiFileListProps` 变更：
- **新增** `onPreview` 语义提升为整行点击（`<li>` 上挂 `onClick` + `role="button"` + `tabIndex={0}` + Enter/Space 键盘处理，满足 AGENTS.md 第 4 条可访问性）
- **删除** 平铺的 `onOpen` / `onMove` / `onPark` 按钮渲染，改由 `WikiFileRowMenu` 承接（props 本身保留，因为 CleanupView 等调用点还在用）
- 行内 ⋯ 按钮 `stopPropagation`，避免打开菜单同时开抽屉
- 副标题：链接类显示域名（`new URL(originUrl).hostname`），文件类显示小类 + 相对时间
- 角标：`storageMode==='ref' && originUrl` → 「链接」；`storageMode==='ref' && sourcePath` → 「引用」。小字弱化，不抢眼
- 保留 `selectable` / `headerActions`（二期已有，收件箱批量移动 P1 要用）

**小类芯片行**（替代被删掉的左栏小类）：分区视图顶部渲染该分区涵盖的旧大类下所有小类芯片，点击切到 `{ kind: 'subtopic', category: 旧大类真名, subtopic }`。芯片按 `(旧大类, 小类)` 生成，跨两个旧大类的分区（工作/生活）芯片会来自两棵子树——**芯片上不显示旧大类名**，只显示小类名；同名小类（如两个大类都有 `整合长文`）需合并显示为一个芯片并同时过滤两个 `(category, subtopic)` 组合。

- [ ] **Step 1: 写失败测试**

```tsx
// WikiFileList.test.tsx
it("点整行触发预览，不再有平铺的详情/打开/移动按钮", async () => {
  const onPreview = vi.fn()
  render(<WikiFileList items={[fileItem]} emptyHint="" onPreview={onPreview} {...cbs} />)
  await userEvent.click(screen.getByRole('button', { name: /Q3报告\.pdf/ }))
  expect(onPreview).toHaveBeenCalledWith(fileItem)
  expect(screen.queryByRole('button', { name: '详情' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '打开' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '移动' })).not.toBeInTheDocument()
})

it("键盘 Enter 也能打开预览", async () => {
  const onPreview = vi.fn()
  render(<WikiFileList items={[fileItem]} emptyHint="" onPreview={onPreview} {...cbs} />)
  screen.getByRole('button', { name: /Q3报告\.pdf/ }).focus()
  await userEvent.keyboard('{Enter}')
  expect(onPreview).toHaveBeenCalled()
})

it("点 ⋯ 不触发整行预览", async () => {
  const onPreview = vi.fn()
  render(<WikiFileList items={[fileItem]} emptyHint="" onPreview={onPreview} {...cbs} />)
  await userEvent.click(screen.getByLabelText('更多操作 Q3报告.pdf'))
  expect(onPreview).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '移到…' })).toBeInTheDocument()
})

it("链接类显示域名与「链接」角标", () => {
  render(<WikiFileList items={[{ ...urlItem, originUrl: 'https://zhuanlan.zhihu.com/p/1', storageMode: 'ref' }]} emptyHint="" {...cbs} />)
  expect(screen.getByText('zhuanlan.zhihu.com')).toBeInTheDocument()
  expect(screen.getByText('链接')).toBeInTheDocument()
})
```

```tsx
// WikiFileRowMenu.test.tsx
it("未保存的链接才有「保存网页内容」", async () => {
  render(<WikiFileRowMenu item={urlRefItem} onSaveWebPage={vi.fn()} {...req} />)
  expect(screen.getByRole('button', { name: '保存网页内容' })).toBeInTheDocument()
})

it("已保存网页不显示「保存网页内容」", () => {
  render(<WikiFileRowMenu item={nativeItem} {...req} />)   // onSaveWebPage 不传
  expect(screen.queryByRole('button', { name: '保存网页内容' })).not.toBeInTheDocument()
})
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**（⋯ 菜单沿用 `WikiMoreMenu.tsx:71-83` 的 outside-click `mousedown` 关闭写法，保持一致）
- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit** `feat(wiki-ui): make rows preview-first with a single overflow menu`

---

### Task 8: 「移到…」弹层（设计 §5.5）

**Files:**
- Modify: `.../components/WikiTopicPicker.tsx`
- Modify: `apps/windows/src/test/components/WikiTopicPicker.test.tsx`
- Modify: `.../components/WikiTab.tsx`

**现状**：`WikiTopicPicker` 已是两步选择（大类网格 → 小类网格）+ 可选 AI 建议 props，且已排除 `PARKING_CATEGORY`。P0 **改造而非新建**（草稿计划的 `WikiMovePicker.tsx` 作废）。

**改动：**
1. 第一步的芯片从「旧六大类」换成 **5 个分区**（工作/学习/生活/收藏/归档；无收件箱——移动的目的就是离开收件箱）
2. 选分区后，小类候选 = 该分区涵盖旧大类下的**真实小类**（D1）；跨两个旧大类时合并展示，每个候选内部记住自己的旧大类
3. **归档分区无小类**，选中即可确定（走 `wiki:source:archive`，见下）
4. AI 建议保持灰色小字一行、不预选（设计 §5.5）
5. 弹层必须 `layer={WIKI_MODAL_LAYER}`（现有代码已在 `WikiTopicPicker.tsx:70` 用了，别丢）

```ts
interface WikiTopicPickerProps {
  open: boolean
  tree: WikiTopicTree | null
  title?: string                        // 默认改成「移到…」
  itemTitle?: string
  /** 归档走 archive 命令而非 update-topic，故单独回调（D3） */
  onConfirmArchive?: () => void
  onConfirm: (category: string, subtopic: string) => void   // category 仍是旧大类真名
  onCancel: () => void
  // 既有 AI 建议 props 不变
  onRequestSuggestion?: () => void
  suggestion?: { category: string; subtopic: string; reason: string } | null
  suggestionState?: 'idle' | 'loading' | 'failed'
  onAdoptSuggestion?: () => void
}
```

`onConfirm` 仍回传**旧大类真名**——这样 `WikiTab` 的 `handleConfirmPicker`（`WikiTab.tsx:363-379`）与 `updateSourceTopic` 完全不用改，映射只发生在 Picker 内部。

- [ ] **Step 1: 写失败测试**

```tsx
it("第一步显示五个分区，不含收件箱与临时存放", () => {
  render(<WikiTopicPicker open tree={DEFAULT_TREE} {...cbs} />)
  for (const l of ['工作','学习','生活','收藏','归档']) expect(screen.getByRole('button', { name: l })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '收件箱' })).not.toBeInTheDocument()
  expect(screen.queryByText('临时存放')).not.toBeInTheDocument()
})

it("选「工作」后合并展示 做事记录 与 计划与复盘 的小类", async () => {
  render(<WikiTopicPicker open tree={DEFAULT_TREE} {...cbs} />)
  await userEvent.click(screen.getByRole('button', { name: '工作' }))
  expect(screen.getByRole('button', { name: '汇报总结文稿' })).toBeInTheDocument()   // 做事记录
  expect(screen.getByRole('button', { name: '目标规划方案' })).toBeInTheDocument()   // 计划与复盘
})

it("确定时回传该小类真实所属的旧大类", async () => {
  const onConfirm = vi.fn()
  render(<WikiTopicPicker open tree={DEFAULT_TREE} onConfirm={onConfirm} {...cbs} />)
  await userEvent.click(screen.getByRole('button', { name: '工作' }))
  await userEvent.click(screen.getByRole('button', { name: '目标规划方案' }))
  await userEvent.click(screen.getByRole('button', { name: '确定' }))
  expect(onConfirm).toHaveBeenCalledWith('计划与复盘', '目标规划方案')
})

it("选「收藏」回传 模板参考", async () => { /* → onConfirm('模板参考', '各类文档模板') */ })

it("归档分区无小类，确定走 onConfirmArchive", async () => {
  const onConfirmArchive = vi.fn(); const onConfirm = vi.fn()
  render(<WikiTopicPicker open tree={DEFAULT_TREE} onConfirm={onConfirm} onConfirmArchive={onConfirmArchive} {...cbs} />)
  await userEvent.click(screen.getByRole('button', { name: '归档' }))
  await userEvent.click(screen.getByRole('button', { name: '确定' }))
  expect(onConfirmArchive).toHaveBeenCalled()
  expect(onConfirm).not.toHaveBeenCalled()
})

it("AI 建议只是一行灰字，不预选任何小类", () => {
  render(<WikiTopicPicker open tree={DEFAULT_TREE} suggestion={{ category: '模板参考', subtopic: '各类文档模板', reason: '链接类' }} {...cbs} />)
  expect(screen.getByText(/建议/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '各类文档模板' })).not.toHaveAttribute('aria-pressed', 'true')
})
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**（`WikiTab` 的 `PickerTarget` 联合类型不变；只在 `handleConfirmPicker` 旁加 archive 分支）
- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit** `feat(wiki-ui): move dialog picks nav sections instead of legacy categories`

---

### Task 9: 详情抽屉链接卡片 + 保存网页（设计 §5.3 / §5.6）

**Files:**
- Modify: `.../components/WikiSourceDetailDrawer.tsx`
- Modify: `.../components/wikiSourcePreview.ts`
- Create: `.../components/WikiAddLinkModal.tsx` + 测试
- Modify: `apps/windows/src/test/components/WikiSourceDetailDrawer.test.tsx`（不存在则新建）
- Modify: `.../components/WikiTab.tsx`、`.../useWikiPage.ts`

**现状**：抽屉已能按 `resolvePreviewMode()` 分 `'web' | 'file' | 'text-only'`，已有 `在浏览器打开`，已用 `<webview>` 内嵌网页。**缺**「保存网页内容」，且 URL 靠 `parseOriginalUrlFromContext()` 正则反解。

**改动：**
1. `resolveSourceUrl()` 改为优先读 `originUrl` 字段，正则仅作存量兜底（D2）
2. `storageMode === 'ref' && originUrl` → 渲染**链接卡片**：标题 + 域名 + 说明「仅保存了链接；需要离线阅读请点下方保存」+ 文字链「在浏览器打开」
3. 底栏最多 3 个按钮（设计 §5.3）：**移到…** · **保存网页内容**（仅 url-ref）· **迁入 wiki**（仅 file-ref，P0 不实现则不渲染）
4. 「打开原文件 / 打开链接」降为正文区文字链，**不占底栏**
5. 保存中：按钮 loading 且禁用；成功 → 重新 `getSource` 刷新为 md 预览；失败 → toast + 保留 url-ref 可重试（设计 §5.6）
6. `WikiAddLinkModal`：URL（必填、trim、http(s) 校验）+ 标题（可选）→ 调 `addLink` → toast「已加入收件箱」→ 刷新列表。`layer={WIKI_MODAL_LAYER}`

- [ ] **Step 1: 写失败测试**

```tsx
it("未保存的链接显示链接卡片与保存按钮，不渲染 webview", async () => {
  render(<WikiSourceDetailDrawer sourceId="s1" {...cbs} />)   // getSource → storageMode:'ref', originUrl:'https://e.com/a'
  expect(await screen.findByText(/仅保存了链接/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '保存网页内容' })).toBeInTheDocument()
  expect(document.querySelector('webview')).toBeNull()
})

it("点保存网页内容调 wiki:link:save 并刷新为正文", async () => {
  const send = mockSendCommand({ 'wiki:link:save': { sourceId: 's1', savedPath: '/w/a.md', title: '示例' } })
  render(<WikiSourceDetailDrawer sourceId="s1" {...cbs} />)
  await userEvent.click(await screen.findByRole('button', { name: '保存网页内容' }))
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'wiki:link:save', sourceId: 's1' })))
  expect(await screen.findByText(/正文/)).toBeInTheDocument()
})

it("保存失败时保留链接卡片并可重试", async () => {
  const send = mockSendCommand({ 'wiki:link:save': () => { throw new Error('抓取失败') } })
  render(<WikiSourceDetailDrawer sourceId="s1" {...cbs} />)
  await userEvent.click(await screen.findByRole('button', { name: '保存网页内容' }))
  expect(await screen.findByText(/失败/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '保存网页内容' })).toBeEnabled()
})

it("已保存网页不再显示保存按钮", async () => { /* storageMode:'native' */ })

it("本地文件引用底栏无「保存网页内容」", async () => { /* storageMode:'ref', sourcePath 有值、originUrl 空 */ })

it("添加链接弹层校验非法 URL 且不发命令", async () => {
  const onAdd = vi.fn()
  render(<WikiAddLinkModal open onAdd={onAdd} {...cbs} />)
  await userEvent.type(screen.getByLabelText(/网址/), 'notaurl')
  await userEvent.click(screen.getByRole('button', { name: '添加' }))
  expect(onAdd).not.toHaveBeenCalled()
  expect(screen.getByText(/网址/)).toBeInTheDocument()
})
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**（`WikiTab` 顶部加「+ 添加文件」「+ 添加链接」两个入口，设计 §5.4）
- [ ] **Step 4: 测试通过 + typecheck**
- [ ] **Step 5: Commit** `feat(wiki-ui): preview links as cards with opt-in page saving`

---

### Task 10: ⋯ 补图谱 + 收件箱合并 + 全量回归

**Files:**
- Modify: `.../components/WikiMoreMenu.tsx` + `WikiMoreMenu.test.tsx`
- Modify: `.../components/WikiInboxPanel.tsx` + 测试
- Modify: `.../components/wikiStatusLabels.ts`
- Modify: `.../components/WikiTab.tsx`
- Create: `docs/test/lumii-cli/wiki-vault-p0-test-cases.md`

**改动：**
1. `WikiMoreMenu` 的 `MENU_ITEMS` **补「知识图谱」**（现有 6 项已含重编目/编辑主题树/历史页面/清理/综述/重建索引），props 加 `onGraph: () => void`；左栏图谱入口已在 Task 5 删除
2. `WikiInboxPanel` 合并三段为一个列表：inbox pending 条目 + 未分类资料（原「待补分」）；顶部加「稍后处理 (N)」筛选芯片（D4），点击切 `{ kind: 'parking' }`
3. 全局文案：「待整理」「待补分」→「收件箱」（`wikiStatusLabels.ts` 与各组件 copy）
4. 任务中心：`'inbox'` outcome 的中文文案（「已收进收件箱」）

- [ ] **Step 1: 写失败测试**

```tsx
it("⋯ 菜单含知识图谱，左栏不含", async () => {
  render(<WikiTab />)
  expect(screen.queryByRole('button', { name: /知识图谱/ })).not.toBeInTheDocument()
  await userEvent.click(await screen.findByRole('button', { name: /更多/ }))
  expect(screen.getByRole('button', { name: /知识图谱/ })).toBeInTheDocument()
})

it("收件箱同时列出待处理条目与未分类资料", async () => {
  render(<WikiTab />)   // inbox:list 1 条 pending + source:list 含 1 条 topicCategory:null
  expect(await screen.findByText('待处理.pdf')).toBeInTheDocument()
  expect(await screen.findByText('未分类.pdf')).toBeInTheDocument()
})

it("收件箱有稍后处理筛选芯片", async () => {
  render(<WikiTab />)
  expect(await screen.findByRole('button', { name: /稍后处理/ })).toBeInTheDocument()
})

it("界面不再出现「待整理」「待补分」字样", async () => {
  render(<WikiTab />)
  await screen.findByRole('button', { name: /收件箱/ })
  expect(screen.queryByText(/待整理/)).not.toBeInTheDocument()
  expect(screen.queryByText(/待补分/)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全量回归**

```powershell
pnpm --filter ./packages/agent-runtime exec vitest run src/wiki src/storage/schema-wiki.test.ts
pnpm --filter ./apps/windows exec vitest run src/test/components src/main/ipc/agent-runtime/wiki-commands.test.ts src/main/agent-runtime/bridge-wiki-tools.test.ts
pnpm typecheck
pnpm --filter ./apps/windows lint
```

预期需要连带修的红灯：`WikiTab.test.tsx`（旧左栏断言，Task 5 已重写）、`WikiFileList.test.tsx`（平铺按钮断言）、`WikiTopicPicker.test.tsx`（六大类断言）、`wiki-organize-queue.test.ts`（organized 计数）、`bridge-wiki-tools.test.ts`（新增工具）。

- [ ] **Step 5: Commit** `test(wiki): fix regressions after ref-first p0 redesign`

---

## 5. 手测清单（执行者必做，结论写进 PR）

前 7 条对应设计 §10 的确认项，后 5 条是回归。

1. 上传 PDF → 出现在**收件箱**，主题为空；等两轮轮询（≥60s）仍在收件箱，**没被 AI 分走**
2. 添加链接（知乎/微信文章）→ 收件箱出现一行，副标题是域名，角标「链接」；抽屉只有链接卡片**无正文**
3. 该链接点「保存网页内容」→ 几秒后抽屉变 Markdown 正文；再打开 ⋯，「保存网页内容」**已消失**
4. 保存网页时断网 → 报错 toast，链接卡片仍在，可重试
5. ⋯ → 移到… → 工作 → 汇报总结文稿 → 确定 → 该条出现在「工作」分区；DB 里 `topic_category` 是 `做事记录`（映射生效）
6. 移到… → 归档 → 确定 → 条目从原分区消失，出现在「归档」分区
7. 存量数据：一条 `计划与复盘` 的旧文件 → 在「工作」分区可见；一条 `模板参考` → 在「收藏」可见
8. 整行点击开抽屉；点行尾 ⋯ **不**开抽屉；键盘 Tab 到行后 Enter 能开
9. 抽屉与「移到…」弹层在设置 Hub 内**不被菜单遮挡**（`WIKI_MODAL_LAYER` 生效）
10. ⋯ → 知识图谱 / 清理 / 综述 / 编辑主题树 / 重建索引 / 全库重编目 六项仍可正常进入
11. 收件箱里「稍后处理」芯片能切到 `临时存放` 的旧文件（不失踪，D4）
12. 搜索仍能命中已保存网页的正文（`indexSource` 在 `link:save` 后被调用）

---

## 6. P1+ Backlog（本计划不实施）

| 项 | 说明 | 期 |
|---|---|---|
| `wiki/` 物理目录 + `.lumii-ref` | `WikiVaultLayout` / `WikiRefStore`；注意 agent-runtime 不得依赖 Electron，root 需注入（D5） | P1 |
| `resolveWikiDir()` | 照 `workspace-paths.ts` 既有 helper 模式加 `{workspace}/wiki` | P1 |
| 主题树一次性迁移到稀疏小类 | 用 `planTopicMutation` / `mergeSubtopic` 把小类收敛为设计 §3.2 那张表（D1 的后续） | P1 |
| `wiki:link:save` 落盘改写 `wiki/` | P0 写 `outputs/wiki-clips/` | P1 |
| 收件箱多选 + 批量移到… | `WikiFileList` 的 `selectable`/`headerActions` 已就绪 | P1 |
| `wiki:source:materialize` | file-ref 复制进 wiki（**复制**，原文件保留） | P2 |
| 失效 ref 检测 | 复用 `wiki-cleanup.ts` 的 `broken_source` 规则 | P2 |
| 列表改服务端过滤 | D8 的已知债务，超约 2000 条资料后必须做 | P2 |
| 批量 AI 分类（预览确认） | 复用 `autoClassify: true` 分支 | P3 |
| 「记住这类放这里」 | 设计 §3.3 明确标 P2 先不做 | P3 |
| 定期整理提醒 | maintenance scan | P3 |

---

## 7. Spec coverage

| 设计条目 | Task |
|---|---|
| §1.2 入库不写分类 / AI 不静默改分类 | 2, 3 |
| §3.1 一级 6 分区 + 磁盘路径登记 | 4, 5 |
| §3.2 小类 | **部分**——见偏离 1 |
| §3.3 低置信度留收件箱 / 建议可忽略 | 8（建议一行不预选）；阈值属 P3 |
| §3.4 旧六大类映射共存 | 4, 5 |
| §4.1 三态 `storage_mode` | 1, 2 |
| §4.2 `.lumii-ref` 文件 | **不做**（P1，D5） |
| §4.3 类型分流（url→ref / 保存→native） | 2, 6 |
| §4.4 目录布局 | **不做**（P1，仅登记 `folderSlug`） |
| §5.1 左栏 7 项 / 高级功能进 ⋯ | 5, 10 |
| §5.2 整行点击 + 行尾仅 ⋯ | 7 |
| §5.3 详情抽屉 + 底栏最多 3 键 | 9 |
| §5.4 添加文件 / 添加链接两入口 | 9 |
| §5.5 移到… 一步确定 | 8 |
| §5.6 保存网页内容（含失败保留 ref） | 6, 9 |
| §5.7 搜索 | 沿用现有 `wiki:search` |
| §5.8 刻意不做的功能下沉 | 10 |
| §6.1–6.4 四条流程 | 2, 6, 9 |
| §7.1 `WikiClipSaver` | 6 |
| §7.1 `WikiVaultLayout`/`WikiRefStore`/`WikiMaterializer` | **不做**（P1/P2） |
| §7.2 入库总线不 enqueue 自动分类 | 3 |
| §7.3 `wiki:link:save` | 6 |
| §7.3 `wiki:vault:ensure-layout` / `materialize` | **不做**（P1/P2） |
| §7.4 链接预览取最简分支 | D7 |
| §8 与现有实现的五项调整 | 2, 3, 6, 10 |

---

## 8. 已知偏离设计文档之处（实施时按本节）

1. **小类不改名**（D1）。设计 §3.2 的「文档/会议/汇报」等新小类名与 DB 现存小类不是同一集合，无法一对一映射；且主题树用户可编辑，写死映射会失效。P0 只映射一级，小类显示真名；§3.2 那张表作为 P1 主题树迁移的目标。
2. **P0 改 schema（V25）**（D2）。草稿计划的「不改 schema + 启发式认链接」不可行——`origin_url` 列本就不存在，且 P0 核心交互依赖「ref / native」的确定判断。
3. **`归档` 用 `archived_at` 而非新大类**（D3）。设计 §3.4 该格留空；代码已有完整归档能力，复用比新造旧大类干净。副作用：`listSourcesByTopic` 需加 `archived` 开关，且归档分区无小类（与 §3.2「归档无小类」一致）。
4. **`临时存放` 收进收件箱视图**（D4）。设计 §3.1 说它作为筛选标签、不占左栏，但没说存量数据从哪看。P0 让 `navIdFromLegacyCategory(临时存放) === 'inbox'` 并加筛选芯片，保证不失踪。
5. **关闭自动分类走独立 `intakeBatch` 路径**（D6），不给 `classifyBatch` 包 `if`。原分类路径与其测试全部保留，供 P3 批量 AI 分类复用。`WikiOrganizeRunDetailItem.outcome` 因此新增 `'inbox'` 值。
6. **入库不拉 og/meta**（D7）。设计 §7.4 的两个分支里取「P0 最简」，避免把粘贴链接变成可失败的异步操作。
7. **`wiki:link:add` 不过 inbox 队列**。队列只为异步抽正文而存在，url-ref 无正文可抽；设计 §6.1 时序图也是 Main 直接写库。
8. **列表继续在 renderer 切片**（D8），只给归档分区加按需拉取。改服务端过滤与 P0 目标无关，风险不划算，已登记为 P2 债务。
9. **`WikiNav` 的 `category` 存分区 id、`subtopic` 的 `category` 存旧大类真名**（Task 5）。不对称是因为一个分区可横跨两个旧大类，而小类只属于一个。实现时勿统一，否则计数与查询错位。

---

## 相关文档

- 设计：[2026-08-29-wiki-vault-ref-first-design.md](../../design/记忆设计/2026-08-29-wiki-vault-ref-first-design.md)
- 前置设计：[2026-08-27-wiki-topic-hierarchy-redesign.md](../../design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md)
- 用户手册：[wiki-user-guide.md](../../guide/wiki-user-guide.md)
- 上一期计划：[2026-08-27-wiki-topic-hierarchy-p2-implementation.md](./2026-08-27-wiki-topic-hierarchy-p2-implementation.md)、[2026-08-28-wiki-graph-phase3-implementation.md](./2026-08-28-wiki-graph-phase3-implementation.md)
