# Lumii Wiki 知识库设计（MVP + 扩展）

> 日期：2026-08-24
> 状态：设计定稿（可实施）
> 前置调研：[2026-08-23-memory-wiki-knowledge-base-design.md](./2026-08-23-memory-wiki-knowledge-base-design.md)
> 关联设计：[2026-08-24-memory-design.md](./2026-08-24-memory-design.md)
> 定调：轻度保守 + 实用主义。先交付可编辑、可搜索、可导出的本地知识库；AI 编译和图谱只在其确有价值时追加。

---

## 0. 结论摘要

| 问题 | 决定 | 原因 | 阶段 |
|---|---|---|---|
| Wiki 真相源 | SQLite 单库，Markdown 是导出格式 | 现有 `LocalDatabase` 已有迁移、备份、损坏恢复；避免同时维护文件树与索引的一致性 | MVP |
| 索引 | `wiki_pages` 为真相数据，FTS5 是可重建派生索引 | 一份用户数据、一条写路径；FTS 损坏可重建 | MVP |
| 页面组织 | `path` 字段构成虚拟文件树 | 不需要文件系统监听、文件冲突或 Markdown 双写 | MVP |
| 编辑 | 直接编辑 Markdown 内容 | 复用 `@uiw/react-md-editor`，用户始终看得到真实内容 | MVP |
| 链接 | 支持 `[[Page Title]]` 子集 + 反链 | 足够建立关联，解析规则简单 | MVP |
| 搜索 | FTS5 BM25 + 路径/标题/摘要 | 零新依赖，先验证中文检索质量 | MVP |
| 资料导入 | 先从现有上传/任务产物中手动创建 Wiki 页 | 不建立第二套文件摄入管线 | MVP |
| Markdown 导出 | 批量导出当前 Wiki | 用户数据可带走，未来可导入 Obsidian | MVP |
| AI 编译 | 仅手动触发，生成候选修订 + diff + 用户确认 | 禁止 AI 静默覆盖用户内容 | 扩展 1 |
| 图谱/ERO | 不进入 MVP | 页面链接和反链先提供足够的导航价值 | 扩展 2 |
| 向量检索 | 不进入 MVP；独立引入时才做 | MemPalace 向量能力不能复用 | 扩展 3 |

**最重要的边界**：这不是文件管理器、不是 Obsidian 克隆、也不是 MCP 服务。MVP 是 Lumii 内建的本地 Markdown 知识页管理功能：创建、编辑、搜索、链接、反链、导出。

---

## 1. 目标与非目标

### 1.1 目标

用户能在 Lumii 内：

1. 新建并编辑一个 Markdown 知识页。
2. 用路径把页面组织成虚拟目录，例如 `项目/Lumii/架构`。
3. 搜索标题和正文，并从结果直接跳到页面。
4. 用 `[[页面标题]]` 建立页面间引用，查看引用当前页的反链。
5. 导出全部页面为标准 Markdown 文件，避免知识被锁进应用。

### 1.2 非目标

MVP 明确不做：

- 本地 Markdown 文件夹作为实时真相源或双向同步。
- PDF、Word、网页的自动批量摄入、OCR 和格式转换。
- LLM 自动总结、自动改写、自动归档或自动更新页面。
- 多人协作、云同步、Git 同步、权限系统。
- ERO 图谱、时间知识图谱、知识问答代理、向量检索。
- 拖拽排序、复杂标签体系、块级 ID、可视化画布。

这些能力的共同问题是：要么已有其他系统更适合做，要么会先引入一致性、审核、可解释性和维护成本，无法改善 MVP 的基本可用性。

---

## 2. 现有基础（已核实）

| 已有资产 | 可复用方式 |
|---|---|
| `LocalDatabase`（`node:sqlite` / `better-sqlite3` 回退） | 为 Wiki 表和 FTS5 建 schema migration；已有备份、轮转、损坏恢复 |
| `MIGRATIONS` 元组数组 | 追加新 schema 版本；多语句 SQL 由 `db.exec()` 执行 |
| `MemoriesPage` | 新增 `wiki` Tab，不额外创建路由和设置入口 |
| `@uiw/react-md-editor` | 编辑和预览 Wiki Markdown，复用主题 hook |
| `FileTree.tsx` | 复用其树的交互与样式思路，但不复用依赖真实文件系统的加载逻辑 |
| `agent-runtime:command` | 作为现有 SQLite 业务数据的 IPC 通道，新增 `wiki:*` 命令族 |
| `@xyflow/react` + dagre | 图谱阶段若有明确需求可直接使用，MVP 不调用 |

现有上传文件已落到 `cwd/uploads/YYYY-MM-DD/`，任务产物会在 `cwd/outputs/` 被扫描注册。MVP 不改变两条流程；用户要把一份资料沉淀到 Wiki 时，先从 Wiki 中创建页面并粘贴/整理必要内容即可。这样避免再建一条隐式的"文件变更即自动入库"链路。

---

## 3. 存储与数据模型

### 3.1 真相源决策

选择 **SQLite 单库 + Markdown 导出**，不选择文件树真相源或混合双真相源。

理由：

- Lumii 当前全部工作记忆已经在 SQLite，`LocalDatabase` 提供了完整的迁移和恢复机制。
- "Markdown 为真相源 + SQLite 可重建索引"在纯文件 Wiki 中成立；但 Lumii 若让 SQLite 同时保存页面、监听 Markdown 文件、再维护索引，就会产生三个可变副本，增加冲突与恢复规则。
- 用户可通过导出获得标准 Markdown，数据可迁移性足够；等真正需要 Obsidian 双向同步时，再把导出目录升级为显式同步边界，而不是先承诺一个没有使用场景的双向系统。

这里的"索引可重建"保留为：`wiki_pages` 是页面数据真相，`wiki_pages_fts` 和 `wiki_links` 是派生数据，可以删除并从页面内容全量重建。

### 3.2 MVP 表

新增一个独立 schema 迁移版本（在记忆 FTS 迁移之后递增；实际实施时以当时的 `SCHEMA_VERSION` 为准，不能假设版本号仍为 15）：

```sql
CREATE TABLE IF NOT EXISTS wiki_pages (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  content_md TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, user_id, path)
);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_owner_path
  ON wiki_pages(agent_id, user_id, path);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_owner_title
  ON wiki_pages(agent_id, user_id, title);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts USING fts5(
  title, content_md,
  content='wiki_pages', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS wiki_links (
  source_page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  target_page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_page_id, target_page_id)
);

CREATE INDEX IF NOT EXISTS idx_wiki_links_target
  ON wiki_links(target_page_id);

CREATE TABLE IF NOT EXISTS wiki_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### 字段语义

- `path`：用户可见的虚拟完整路径，末段默认可由 `title` 生成，但允许用户改名。不能以 title 当身份，因为重名和改名都不可避免。
- `title`：显示标题与 wikilink 解析候选。不同目录允许重名，跨目录链接有歧义时要求用户选择，而不是按字典序猜测。
- `content_md`：用户编辑的完整 Markdown。页面数据只保存在这里，不另存 HTML、摘要或 LLM 产物。
- `agent_id`、`user_id`：与现有 `agent_memories` 隔离范围保持一致。每条查询必须带这两个条件，避免跨 Agent 泄漏。
- `wiki_pages_fts`：仅检索派生数据。触发器同步，支持全量重建。
- `wiki_links`：从正文中解析出的派生边。它不储存用户原文，页面更新后可重建。
- `wiki_index_meta`：记录索引版本和最近重建时间，用于显示健康状态和未来迁移判断，不记录页面真相。

### 3.3 FTS5 同步与重建

FTS5 使用外部内容表，触发器负责新增、修改、删除时的同步：

```sql
CREATE TRIGGER IF NOT EXISTS wiki_pages_ai AFTER INSERT ON wiki_pages BEGIN
  INSERT INTO wiki_pages_fts(rowid, title, content_md)
  VALUES (new.rowid, new.title, new.content_md);
END;

CREATE TRIGGER IF NOT EXISTS wiki_pages_ad AFTER DELETE ON wiki_pages BEGIN
  INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, title, content_md)
  VALUES ('delete', old.rowid, old.title, old.content_md);
END;

CREATE TRIGGER IF NOT EXISTS wiki_pages_au AFTER UPDATE ON wiki_pages BEGIN
  INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, title, content_md)
  VALUES ('delete', old.rowid, old.title, old.content_md);
  INSERT INTO wiki_pages_fts(rowid, title, content_md)
  VALUES (new.rowid, new.title, new.content_md);
END;
```

`rebuildWikiIndex()` 在单个事务中完成：清空 FTS 与 links，从 `wiki_pages` 回填 FTS，重新解析每页正文并写入 links，最后更新 `wiki_index_meta`。

**中文检索必须在实现前实测。** `unicode61` 对中文的实际匹配粒度不是完整中文分词。用当前项目典型的中文及中英混合标题/正文建立最小金标查询集，检查标题命中、短语命中、搜索排序三项。如果不满足基本可用性，再决定采用 `LIKE` 补召回还是引入中文分词；在数据前不预设新依赖。

### 3.4 `[[wikilink]]` 解析规则

MVP 支持唯一、可预测的 Obsidian 子集：

```text
[[页面标题]]
[[目录/页面标题]]
```

不支持 alias、heading 锚点、block ID、嵌入式 transclusion、复杂 frontmatter。

解析规则：

1. `[[目录/页面标题]]` 直接用规范化 path 匹配当前 `(agent_id, user_id)` 范围内页面。
2. `[[页面标题]]` 在当前目录寻找同 title 页面；若没有，查全库唯一 title。
3. 若匹配到多页，则不写入 `wiki_links`，并在编辑器的非阻塞提示中列出候选路径，由用户改成带路径的链接。
4. 未找到页面同样不写边，但保留原 Markdown 文本。这允许先写链接、后建页面。
5. 页面标题或路径变化后，**不自动修改其他页面正文**。这是用户内容，不能为维持索引而静默改写。受影响链接在后续更新/重建时显示为未解析即可。

链接的语义来自 Markdown 原文；`wiki_links` 只是反链和未来图谱的缓存。因此解析失败永不破坏已有内容。

---

## 4. MVP 服务、IPC 与界面

### 4.1 运行时边界

通用 Wiki 仓储和链接解析放在 `packages/agent-runtime/src/wiki/`，因为它们只依赖 SQLite 和 TypeScript：

```text
packages/agent-runtime/src/wiki/
  wiki-repo.ts          CRUD、搜索、反链、导出数据读取
  wikilink-parser.ts    解析 [[...]] 并解析目标页
  wiki-index.ts         rebuildWikiIndex()
  types.ts              WikiPage、WikiSearchResult 等共享类型
```

不要在第一版拆出 service、factory 或接口层。`WikiRepo` 与现有 `AgentMemoryRepo` 一样直接接收数据库适配器即可。

Electron IPC 分派和文件导出窗口放 `apps/windows/src/main`。不把 Electron 或文件系统依赖放进 `packages/agent-runtime`。

### 4.2 IPC 命令

复用已有 `agent-runtime:command` 单通道，不新增裸 `ipcMain.handle`。命令命名遵循 `<域>:<动作>`：

```text
wiki:list
wiki:get
wiki:create
wiki:update
wiki:delete
wiki:search
wiki:backlinks
wiki:export
wiki:rebuildIndex
```

每个命令在以下位置同步声明和实现：

1. `apps/windows/src/shared/agent-runtime-commands.ts`：请求与结果的判别联合类型。
2. `apps/windows/src/main/ipc/agent-runtime/agent-commands.ts`：调用 `WikiRepo`。
3. `apps/windows/src/main/ipc/agent-runtime-ipc.ts`：现有分派白名单。
4. `apps/windows/src/preload/api/agent-runtime-api.ts` 与 `preload/index.ts`：暴露安全、窄化的 API 类型。
5. renderer 的 Wiki hook：调用方只看到所需方法，不传数据库或任意 SQL。

`wiki:export` 的语义是：renderer 请求导出，main 通过系统目录选择器要求用户指定目录，然后用安全的路径拼接写入 `.md` 文件。`path` 必须规范化并拒绝空段、`..`、绝对路径和平台分隔符逃逸，不能直接把数据库 path 拼到目标目录上。导出失败应逐页返回失败列表，不能静默跳过。

### 4.3 MemoriesPage 的 Wiki Tab

在 `apps/windows/src/renderer/pages/MemoriesPage/MemoriesPage.tsx` 的 `MemoryTab` 增加 `'wiki'`，放在现有 AI 记忆与用户记忆附近。MVP 是三栏以内的工作区，而不是独立卡片堆叠：

```text
+-------------------+------------------------------+---------------------+
| 搜索 / 虚拟目录   | Markdown 编辑器 / 预览        | 反链                |
| 新建页面          | 标题、路径、保存              | 引用当前页的页面    |
| 页面列表          |                              |                     |
+-------------------+------------------------------+---------------------+
```

界面行为：

- 左侧：搜索框、"新建页面"按钮、按 `/` 切分的虚拟目录树。只维护已加载页面的本地树，不调用真实文件 API。
- 中间：标题与路径输入、`MDEditor`、保存状态。标题和路径为空或冲突时禁止保存并给出具体错误。
- 右侧：当前页反链。点击反链打开对应页面；无反链显示空状态。
- 顶部：导出、重建索引两个明确命令。重建显示进行中、成功、失败状态；不在后台自动执行。
- 窄窗口：右侧反链折叠到编辑器下方，不能覆盖编辑区。
- 首次打开：没有页面时显示空状态和新建页面按钮，不生成示例内容或假数据。

编辑器继续用 `useDataThemeColorMode` 同步主题。按钮复用现有 `Button`、`Tooltip` 与 `lucide-react` 图标，不手绘 SVG。需要新增的 CSS 应限制在 `MemoriesPage` 作用域，遵循页面既有颜色和间距令牌。

### 4.4 用户操作流

**新建页面**：点击新建 → 输入标题/可选路径 → 编辑 Markdown → 保存 → 同一事务更新页面、FTS 和反链缓存 → 树与反链刷新。

**检索页面**：输入关键词 → `wiki:search` 返回 path、title、`snippet()` 结果、更新时间 → 点击结果打开页面。搜索结果不直接显示整页正文。

**建立关联**：正文输入 `[[架构设计]]` → 保存后解析链接 → 若唯一匹配，当前页进入目标页反链列表；若不唯一或不存在，保留文本，给出可处理提示。

**导出**：选择目标目录 → 目录下按 wiki `path` 生成 Markdown 文件 → 写入导出 manifest（导出时间、成功/失败页面数），不把它回写为产品数据。

### 4.5 删除语义

页面删除是唯一会直接删除用户 Wiki 内容的操作，因此：

- UI 必须二次确认，并明确显示标题和受影响的反链数。
- 删除页后，`wiki_links` 由外键级联删除；其他页面中的 `[[...]]` 文本**保留**，成为未解析链接。
- 不做软删除/回收站。现有本地数据库已有备份与恢复能力；在没有真实"恢复"交互需求前，再建一套删除历史是过度设计。

---

## 5. 与记忆、文件和 MemPalace 的边界

| 系统 | 职责 | Wiki 与其关系 |
|---|---|---|
| `agent_memories` | AI 从对话中抽取的用户画像、偏好、工作上下文 | 独立。MVP 不自动将 Wiki 回写成记忆，也不从记忆自动生成 Wiki 页 |
| `user-memory.md` | 用户/反馈类个人记忆的可读 Markdown 载体 | 独立。Wiki 不替代个人画像文件 |
| 上传与任务产物 | 原始文件与执行输出 | 仍按原有流程保存；MVP 不自动导入或监听 |
| MemPalace | 独立插件提供的向量记忆能力 | 不依赖，不调用，不共享向量索引 |

这条边界避免最常见的错误：把"用户自己要保存和维护的知识"与"模型应在何时注入的短记忆"混为一个库。它们查询模式、更新频率、用户预期和数据生命周期都不同。

未来可以提供**用户主动操作**：从某个 Wiki 页面创建一条记忆候选，或在聊天中引用一个 Wiki 页。但在没有确定交互和评估注入质量前，不做自动闭环。

---

## 6. 扩展 1：受控的 AI 编译

当 MVP 的编辑、搜索、链接、导出稳定后，再增加把用户选定的资料整理为 Wiki 候选的能力。采用 Karpathy DKR 的"摄入时编译，而不是每次查询时临时总结"理念，但收窄为可预测的单次任务。

### 6.1 触发与输入

- 仅用户显式点击"从资料生成候选"或"更新此页候选"触发。
- 输入是用户选择的一个上传文件、任务产物，或当前 Wiki 页面；不在每次上传后后台自动运行。
- 运行前保存源快照 hash 和来源元数据。mtime 不能作为唯一变更依据。

### 6.2 管线

```text
选择资料
  -> Triage：检索相关 Wiki 页，分类 new / update / disputed / no_material
  -> Compile：生成候选页面或候选修订，并附来源片段
  -> Review：用户查看 diff，逐项接受或拒绝
  -> Apply：只写入被接受的变更
  -> Log：记录本次操作和结果
```

约束：

- AI **绝不直接覆写** `wiki_pages.content_md`。
- `disputed` 是候选状态和提示，不删除双方内容，不替用户判定真伪。
- `no_material` 同样写入日志，避免"为何没生成"变成黑箱。
- 首版不做 Cascade 全库自动改写。页面关联较多时，全自动级联的误改成本远高于收益；先在候选结果中列出可能受影响页，交给用户选择。

### 6.3 最小新增数据

```sql
CREATE TABLE wiki_compile_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  summary TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE wiki_compile_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES wiki_compile_runs(id) ON DELETE CASCADE,
  target_page_id TEXT REFERENCES wiki_pages(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'disputed', 'no_material')),
  proposed_title TEXT,
  proposed_path TEXT,
  proposed_content_md TEXT,
  source_excerpt TEXT,
  created_at TEXT NOT NULL
);
```

不创建长期 queue 框架、worker pool 或通用 job 基础设施。已有 LLM 编排与串行队列模式能先承载一次一个编译任务；只有需要并发、断点恢复或计划任务时，再抽出队列。

---

## 7. 扩展 2：状态与 ERO 图谱

只有当用户已积累足量 Wiki 页，并且"反链不足以找到关系"成为可观察问题时，才做此阶段。

### 7.1 页面状态

给 `wiki_pages` 增加：

```text
status: active | outdated | disputed | archived
```

- `active`：默认。
- `outdated`：内容已被新资料替代，但仍应保留历史和链接。
- `disputed`：来源或候选间存在待确认冲突。
- `archived`：用户主动停止使用，但不物理删除。

状态不能由 AI 静默批量改写；AI 只能提出候选，用户确认后才变更。

### 7.2 ERO 最小模型

若页面级链接无法表达重要关系，再添加：

```text
wiki_entities(id, agent_id, user_id, name, entity_type, created_at, updated_at)
wiki_observations(id, entity_id, content, status, supersedes_id, created_at)
wiki_relations(id, source_entity_id, target_entity_id, relation_type, strength, created_at)
```

其中：

- Observation 是可独立退役的原子事实；用 `supersedes_id` 保留演变，不物理删除。
- Relation 是有向、主动语态的关系，例如 `Lumii --uses--> SQLite`。
- 重复关系可在确认写入时使用概率并集合并：`1 - (1 - oldStrength) * (1 - newStrength)`。

不在这一阶段引入完整双时态、实体模糊合并或多跳问答。它们需要稳定的事实提取质量和明确的时间查询需求，不能以"未来可能用到"为理由预先铺设。

图谱 UI 也不应与 ERO 建模绑定发布。先让检索、实体详情和反链产生价值；图节点达到用户无法用列表理解关系时，再复用 `@xyflow/react` 和 `@dagrejs/dagre` 添加受限子图视图。默认图限制节点数量，避免全库图既难读又耗性能。

---

## 8. 扩展 3：智能检索

向量检索的前置门槛：应先建立 Lumii 自有的中文/中英混合金标查询集，确认 FTS5 确实无法覆盖关键语义检索需求。没有这个基准，不引入 embedding 运行时。

已核实的限制：MemPalace 的 Python MCP 进程封装了 chromadb 和相似度计算，核心 TypeScript 无法复用其向量或模型接口。因此只能：

1. 引入 Transformers.js 和本地多语言 embedding 模型；或
2. 维持 FTS5 检索。

若实施第一项：

- embedding 必须可关闭，模型未下载、加载失败或用户关闭时退化为 FTS5。
- UI 明确显示当前搜索模式与降级原因，不能悄悄给出不同质量的结果。
- FTS5 与向量各取排名结果，以 RRF 融合：`score = Σ 1 / (60 + rank_i)`。
- 先从少量页面的线性余弦相似度开始；只有数据量和 profile 证明瓶颈存在时，才引入 sqlite-vec 或 ANN 索引。

不做跨 Wiki/记忆/MemPalace 的"全局混合检索"。三个数据域的权限、语义和可解释性不同，混在一个结果列表会先降低可控性。

---

## 9. 实施顺序与验收

### MVP

1. 新建 `packages/agent-runtime/src/wiki/`，实现 `WikiRepo`、wikilink 解析和索引重建。
2. 在 schema 迁移中创建 `wiki_pages`、FTS5、`wiki_links`、元数据和触发器。
3. 补齐 `wiki:*` 判别命令、main 分派、preload API 类型与 renderer hook。
4. 在 MemoriesPage 新增 Wiki Tab：空状态、创建、编辑、保存、虚拟树、搜索、反链。
5. 实现目录选择后的 Markdown 批量导出。
6. 补就近 Vitest：路径唯一性、链接解析歧义、页面更新后的反链刷新、索引重建、FTS 输入转义。
7. 用真实中文与中英混合样本验证 FTS5；启动 Electron 开发环境，手工验证创建、编辑、搜索、反链、删除确认和导出。

MVP 验收标准：

- 重启应用后页面内容、路径和链接保持不变。
- 同一 agent/user 下同一路径不能创建两页；不同 agent/user 不互相可见。
- 搜索的结果可定位到对应页面，且不因 `"`、`*` 等输入报错。
- 删除页面不会修改其他页面原文；相应反链被正确清理。
- 索引重建后搜索和反链与重建前一致。
- 导出的 Markdown 可在没有 Lumii 的环境中阅读。

### 扩展发布门槛

- **扩展 1（AI 编译）**：MVP 已有稳定页面数据；候选 diff、明确来源和人工确认均可用。
- **扩展 2（ERO）**：已有真实的跨页关系导航痛点，且文本链接无法满足。
- **扩展 3（向量）**：有本地金标集证明 FTS5 的关键召回不足，并接受模型下载/存储成本。

---

## 10. 参考与许可证边界

本设计只吸收调研项目的架构思想，不复制代码、schema 细节或实现：

- wiki0：索引可重建、wikilink/backlink 的产品思想。
- Karpathy DKR：受控的 Triage → Compile → Review → Log 知识沉淀方法。
- Anthropic server-memory：后续 ERO 的最小概念模型。
- local-memory-mcp / memex：后续 RRF、软退役和关系强度的设计参考。

以下项目存在许可证或权属风险，严禁复制实现：`mcp-memory-graph`（PolyForm Noncommercial）、思源笔记（AGPLv3）、缺少明确许可证的 `chenly255-llm-wiki` 与 `erickmbugua-llm-wiki`、许可证存在冲突的 `aaronsb/memory-graph`，以及处于许可证迁移期的 `modelcontextprotocol-servers`。设计思想不等于代码授权，实施时只写 Lumii 自有代码。
