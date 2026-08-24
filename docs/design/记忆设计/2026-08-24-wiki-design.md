# Lumii Wiki 知识库设计（MVP + 扩展）

> 日期：2026-08-24
> 状态：设计定稿（可实施）
> 前置调研：[2026-08-23-memory-wiki-knowledge-base-design.md](./2026-08-23-memory-wiki-knowledge-base-design.md)
> 关联设计：[2026-08-24-memory-design.md](./2026-08-24-memory-design.md)
> 定调：轻度保守 + 实用主义。数据模型采用**三层分离（raw 资料原文 / pages 知识页 / revisions 修订历史）**，让 AI 编译、版本回滚、来源追溯都有清晰落点，是后续迭代的稳定骨架。

---

## 0. 结论摘要

| 问题 | 决定 | 原因 | 阶段 |
|---|---|---|---|
| 数据模型 | **三层分离**：`wiki_sources`(raw) / `wiki_pages`(知识页) / `wiki_page_revisions`(修订历史) | 资料不可变、知识可演进、每次保存可回滚，AI 编译与来源追溯各有落点 | MVP |
| 真相源 | SQLite 单库，Markdown 是导出格式 | 复用 `LocalDatabase` 迁移/备份/恢复；避免多源一致性负担 | MVP |
| 索引 | `wiki_pages_fts` + `wiki_links` 为可重建派生索引 | 一份用户数据、一条写路径，派生数据可删可重建 | MVP |
| 编辑 | 直接编辑 Markdown，每次保存生成 revision | 可回滚、可 diff、可追踪 | MVP |
| 链接 | `[[Page Title]]` 子集 + 反链 | 简单足以建立关联 | MVP |
| 搜索 | FTS5 BM25 + path/title/snippet | 零新依赖，先验证中文质量 | MVP |
| 资料入库 | 手动从现有上传/任务产物登记为 source | 不建第二套自动摄入管线 | MVP |
| Markdown 导出 | 批量导出 pages + raw | 数据可带走 | MVP |
| AI 编译 | 手动触发 → 候选修订 + diff + 用户确认 | 禁止 AI 静默覆盖用户内容 | 扩展 1 |
| 图谱/ERO | 不进入 MVP | 链接与反链先提供足够导航价值 | 扩展 2 |
| 向量检索 | 不进入 MVP | MemPalace 向量不能复用，须独立引入 | 扩展 3 |

**核心设计立场**：三层分离把「资料是什么」与「知识是什么」分开。资料是原始事实、不可变、可重建知识；知识页是经过理解与组织的产物、用户与 AI 都能编辑、每次编辑留痕。这是 Karpathy DKR「raw/ 不可变 → wiki/ 可积累」理念在 Lumii 的落地，也是后续 AI 编译（扩展 1）唯一能可靠 diff、回滚、溯源的基础。若无三层，AI 编译要么覆盖用户原文（不可接受），要么无处安放候选。

---

## 1. 目标与非目标

### 1.1 目标

用户能在 Lumii 内：

1. 把一份资料（上传文件/任务产物）登记为 source，或直接新建 knowledge page。
2. 编辑 knowledge page，写 Markdown，用 `[[链接]]` 建立关联，查看反链。
3. 搜索 title/正文，从结果定位页面。
4. 回滚到某个历史版本。
5. 导出全部 pages（+ 可选 raw）为标准 Markdown，数据可带走。

### 1.2 非目标（MVP 明确不做）

- 本地 Markdown 文件夹实时真相源或双向同步。
- PDF/Word/网页自动批量摄入、OCR、格式转换。
- LLM 自动总结/改写/归档/更新页面。
- 多人协作、云同步、Git 同步、权限系统。
- ERO 图谱、时间知识图谱、问答代理、向量检索。
- 拖拽排序、复杂标签体系、块级 ID、可视化画布。

---

## 2. 现有基础（已核实）

| 已有资产 | 复用方式 |
|---|---|
| `LocalDatabase`（node:sqlite / better-sqlite3 回退） | 为 Wiki 三层表 + FTS5 + 触发器建 schema migration；已有备份/轮转/损坏恢复 |
| `MIGRATIONS` 元组数组 | 追加新版本；多语句 `db.exec()` |
| `MemoriesPage` | 新增 `wiki` Tab |
| `@uiw/react-md-editor` + `useDataThemeColorMode` | 编辑/预览 + 明暗主题同步 |
| `FileTree.tsx` | 复用树的交互/样式思路（不放真实文件系统，只挂虚拟目录数据） |
| `agent-runtime:command` | 复用单命令通道，新增 `wiki:*` 命令族 |
| `diff` 依赖（已装） | 扩展 1 做候选 diff |

现有上传文件落到 `cwd/uploads/YYYY-MM-DD/`，任务产物在 `cwd/outputs/`。MVP 不改变这两条流程；用户在 Wiki 里主动地把某个文件登记为 source（引用路径 + 内容快照），而不是让系统自动监听入库。

---

## 3. 数据模型（三层分离）

### 3.1 层级职责

```text
wiki_sources          资料原文（raw）—— 不可变的事实层，知识可从中重建
wiki_pages            知识页（知识）—— 用户/AI 编辑的可演进产物
wiki_page_revisions   修订历史 —— 每次保存的不可变快照，支持 diff + 回滚
派生索引              wiki_pages_fts / wiki_links —— 可删可重建
```

- `wiki_sources` 是「获取到的原始材料」，一旦登记原则上不改（改也是明确的新 source 或修订标记，而非原地覆盖）。
- `wiki_pages` 是「沉淀后的知识」。它可能引用多个 source，也可能由用户手写、无 source。
- `wiki_page_revisions` 是 `wiki_pages.content_md` 的完整历史，每次保存（含 AI 编译接受后）追加一条。

三层合起来满足三大保证：

1. **可回滚**：任何编辑都能回到历史版本。
2. **可溯源**：AI 编译产物能指向它依据的 source 与 revision。
3. **可重建**：FTS 与 links 是派生索引，删了重来零损失。

### 3.2 MVP 表

```sql
-- 资料原文（raw），不可变
CREATE TABLE wiki_sources (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_path TEXT,                 -- 引用磁盘上的上传/产物文件路径，可空（纯粘贴入口）
  content_md TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,       -- 用于检测源文件是否被改（后续同步依据，MVP 只记录）
  mime_type TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_wiki_sources_owner ON wiki_sources(agent_id, user_id);

-- 知识页，可演进
CREATE TABLE wiki_pages (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  path TEXT NOT NULL,               -- 虚拟目录路径，如 项目/Lumii/架构
  title TEXT NOT NULL,
  content_md TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1, -- 当前修订号，对应 wiki_page_revisions.version
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, user_id, path)
);
CREATE INDEX idx_wiki_pages_owner_path ON wiki_pages(agent_id, user_id, path);
CREATE INDEX idx_wiki_pages_owner_title ON wiki_pages(agent_id, user_id, title);

-- 修订历史，不可变
CREATE TABLE wiki_page_revisions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_md TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  editor TEXT NOT NULL DEFAULT 'user', -- user | ai
  source_revision_ids TEXT,         -- 扩展1：AI 编译依据的 wiki_sources 或 revisions（JSON 数组）
  created_at TEXT NOT NULL,
  UNIQUE(page_id, version)
);
CREATE INDEX idx_wiki_page_revisions_page ON wiki_page_revisions(page_id, version DESC);

-- 页面与资料来源的关联（可空说明该页由用户手写）
CREATE TABLE wiki_page_sources (
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES wiki_sources(id) ON DELETE CASCADE,
  PRIMARY KEY (page_id, source_id)
);

-- 全文索引（派生）
CREATE VIRTUAL TABLE wiki_pages_fts USING fts5(
  title, content_md,
  content='wiki_pages', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- 链接索引（派生）
CREATE TABLE wiki_links (
  source_page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  target_page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_page_id, target_page_id)
);
CREATE INDEX idx_wiki_links_target ON wiki_links(target_page_id);

-- 索引元数据（健康状态）
CREATE TABLE wiki_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 3.3 写入与版本规则

- **新建 page**：INSERT `wiki_pages`（version=1）+ INSERT `wiki_page_revisions`(version=1)。
- **编辑 page**：同一事务内 `UPDATE wiki_pages SET content_md=?, version=version+1, updated_at=?` + `INSERT wiki_page_revisions`(version=新值)。revision 保存本次新内容快照。
- **回滚**：读某 revision 的 content_md/title/path → 作为一次新编辑写入（version 继续 +1），不物理修改旧 revision。历史永不被覆盖。
- **FTS / links 同步**：由触发器维护；`rebuildWikiIndex()` 清空后从 `wiki_pages` 全量重建 FTS + 重新解析每页正文重建 links。

### 3.4 `[[wikilink]]` 解析（与上版一致，明确保留）

支持 `[[页面标题]]` 与 `[[目录/页面标题]]` 两种子集；不支持 alias/heading/block/transclusion/frontmatter。规则：

1. 带路径的按规范化 path 精确匹配。
2. 不带路径的先当前目录同 title，再全库唯一 title。
3. 多匹配不写边，非阻塞提示候选，交给用户改带路径。
4. 未匹配也不写边，保留原文（允许先链接后建页）。
5. title/path 修改**不自动改写其他页正文**，受影响链接在下次重建时显示未解析。

`wiki_links` 只是反链/图谱缓存，解析失败永不破坏内容。

---

## 4. MVP 服务、IPC 与界面

### 4.1 运行时边界

通用仓储放 `packages/agent-runtime/src/wiki/`（只依赖 SQLite + TS）：

```text
packages/agent-runtime/src/wiki/
  wiki-repo.ts          source/page/revision CRUD、搜索、反链、导出读取
  wikilink-parser.ts    [[...]] 解析与目标页解析
  wiki-index.ts         rebuildWikiIndex()
  types.ts              WikiSource、WikiPage、WikiRevision 等类型
```

不拆 service/factory。`WikiRepo` 与 `AgentMemoryRepo` 一样直接持 `DatabaseAdapter`。Electron IPC 分派与文件导出窗口放 `apps/windows/src/main`。

### 4.2 IPC 命令（复用 `agent-runtime:command`）

```text
wiki:source:register      登记资料为 source（含内容快照与 hash）
wiki:page:list
wiki:page:get
wiki:page:create
wiki:page:update          保存为新的 revision
wiki:page:delete
wiki:page:revisions       读某页的修订历史
wiki:page:revert          回滚到某 version（内部走一次 update）
wiki:search
wiki:backlinks
wiki:link:add|remove      手动建立/移除页面关联（MVP 可选，见下）
wiki:export
wiki:index:rebuild
```

命令命名沿用 `<域>:<子域>:<动作>` 约定（与现有 MemPalace `mempalace:*` 一致）。每个命令按 AGENTS.md 第 5 条同步更新：`shared/agent-runtime-commands.ts` 判别联合 → `main/ipc/agent-runtime/agent-commands.ts` → `main/ipc/agent-runtime-ipc.ts` 白名单 → `preload/api/agent-runtime-api.ts` + `preload/index.ts` → renderer hook。

`wiki:export`：main 起目录选择器，规范化各 `path`（拒绝空段、`..`、绝对路径、分隔符逃逸）后写 `.md`；逐页返回失败列表，不静默跳过。

### 4.3 MemoriesPage 的 Wiki Tab（三栏）

```text
+-------------------+------------------------------+---------------------+
| 搜索 / 资料(raw)  | Markdown 编辑器 / 预览        | 反链 / 修订历史      |
| / 知识页树        | 标题、路径、保存、版本号      |                     |
+-------------------+------------------------------+---------------------+
```

- 左侧：搜索框、两段（资料 raw / 知识页）虚拟树、"新建页面"、"登记资料"按钮。
- 中间：标题/路径输入、`MDEditor`、保存、当前版本号与「历史」入口。标题/路径空或冲突时禁保存并给具体错误。
- 右侧：当前页反链 + 修订历史列表（点某版本预览、点「回滚」走 revert）。无反链/无历史显示空状态。
- 顶部：导出、重建索引两个命令，进行中/成功/失败态明确，不后台自动执行。
- 窄窗口：右侧折叠到编辑器下方。
- 首开空状态：提示「新建页面」或「登记资料」，不生成示例数据。

编辑器用 `useDataThemeColorMode` 同步主题，按钮复用 `Button`/`Tooltip`/`lucide-react`，新增 CSS 限 `MemoriesPage` 作用域。

### 4.4 用户操作流

- **登记资料**：选文件（复用现有文件路径）→ 标题 + 内容快照 + hash 存 `wiki_sources` → 可选「从资料新建页」。
- **新建/编辑页**：同现有，每次保存产生新 revision。
- **搜索**：FTS5 返回 path/title/snippet/version。
- **建链**：正文 `[[标题]]` 保存后解析，唯一命中进目标反链。
- **回滚**：右侧历史选版本预览 → 回滚 = 新 revision 写入该版本内容。
- **导出**：选目录 → 按 path 写 pages 的 `.md`（可选附带 raw），写导出 manifest。

### 4.5 删除语义

- page 删除：二次确认 + 显示受影响反链数；`wiki_links` 级联删除，其余页的 `[[...]]` 文本保留为未解析。
- source 删除：`wiki_page_sources` 级联解绑，但**不级联删除引用了它的 page**，page 只是失去来源标注。
- 不做软删除/回收站：revision 已是删除前的历史兜底；数据库备份再兜一层。再建删除历史是过度设计。

---

## 5. 与记忆、文件、MemPalace 的边界

| 系统 | 职责 | Wiki 关系 |
|---|---|---|
| `agent_memories` | AI 对话抽取的用户画像/工作上下文 | 独立；MVP 不自动回写，不从记忆自动建页 |
| `user-memory.md` | 用户/反馈个人记忆可读载体 | 独立 |
| 上传/任务产物 | 原始文件与执行输出 | 仍按原流程保存；Wiki 的 source 只「引用」不搬移 |
| MemPalace | 插件向量记忆 | 不依赖、不调用、不共享向量索引 |

这条边界避免把「用户主动维护的知识」与「模型应何时注入的短记忆」混库。未来可加**用户主动操作**：从某页生成记忆候选、或聊天里引用某页；不作自动闭环，直到交互与评估质量确定。

---

## 6. 扩展 1：受控 AI 编译（三层模型的直接受益者）

有了 `wiki_sources` + `wiki_page_revisions`，AI 编译才有可靠的输入与落点。

### 6.1 触发与输入

- 仅用户显式点击「从资料生成候选」或「更新此页候选」。
- 输入为一个 source（或一组）或当前 page；运行前保存 source 的 `content_hash`（不靠 mtime）。

### 6.2 管线（Triage → Compile → Review → Apply → Log）

```text
选择 source
  -> Triage：检索相关 wiki_pages，分类 new / update / disputed / no_material
  -> Compile：产出候选（新建页或对现有页的修订建议），附 source 引用片段
  -> Review：用户查看 diff（基于 revision 对比），逐项接受/拒绝
  -> Apply：接受的写入为新 revision（editor='ai'，source_revision_ids 记录依据）
  -> Log：记录本次 run 与结果
```

约束：

- AI **绝不直接覆写** `wiki_pages.content_md`，只能写候选，接受后作为新 revision。
- `disputed` 是候选状态与提示，不删双方内容、不替用户判定真伪。
- `no_material` 也落日志。
- 首版不做 Cascade 自动级联改写；先列出可能受影响页交给用户选。

### 6.3 最小新增数据

```sql
CREATE TABLE wiki_compile_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,          -- source id 或 page id
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  summary TEXT, created_at TEXT NOT NULL, finished_at TEXT
);

CREATE TABLE wiki_compile_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES wiki_compile_runs(id) ON DELETE CASCADE,
  target_page_id TEXT REFERENCES wiki_pages(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('create','update','disputed','no_material')),
  proposed_title TEXT, proposed_path TEXT, proposed_content_md TEXT,
  source_excerpt TEXT,             -- 引用片段，保证 source fidelity
  created_at TEXT NOT NULL
);
```

不建通用 job 队列；复用现有 LLM 编排与串行队列，一次一个编译任务。

---

## 7. 扩展 2：状态与 ERO 图谱

前提：用户已积累足量页，且「反链不足以找关系」成为可观察痛点。

### 7.1 页面状态

给 `wiki_pages` 加 `status active|outdated|disputed|archived`（默认 active）。状态不能由 AI 静默批量改，只能候选 + 用户确认。

### 7.2 ERO 最小模型

页面级链接不够时再上：

```text
wiki_entities(id, agent_id, user_id, name, entity_type, created_at, updated_at)
wiki_observations(id, entity_id, content, status, supersedes_id, created_at)
wiki_relations(id, source_entity_id, target_entity_id, relation_type, strength, created_at)
```

Observation 用 `supersedes_id` 保留演变不物理删；Relation 主动语态 + 概率并集合并 `1-(1-a)(1-b)`。不在此阶段引入完整双时态、实体模糊合并、多跳问答。图谱 UI 与 ERO 绑定发布不可行，先让检索/实体详情/反链产生价值；需要时再用 `@xyflow/react`+`@dagrejs/dagre` 做受限子图（限制节点数）。

---

## 8. 扩展 3：智能检索

门槛：先建 Lumii 中文/中英金标集，证明 FTS5 关键召回不足，才引入模型。

- 不可复用 MemPalace（已核实），只能引入 Transformers.js + 多语言小模型。
- embedding 可关闭，失败/关闭时退化为 FTS5 且 UI 显式提示，无静默降级。
- RRF `score = Σ 1/(60 + rank_i)` 融合。
- 从少量页线性余弦开始，证明瓶颈后再上 sqlite-vec/ANN。
- 新增 `wiki_embed(rowid, vec)` 派生表 + 重建函数，接入 3.x 的派生索引骨架。

不做跨 Wiki/记忆/MemPalace 的全局混合检索——三域权限/语义/可解释性不同，混列会先降可控性。

---

## 9. 实施顺序与验收

### MVP

1. `packages/agent-runtime/src/wiki/`：`WikiRepo`、`wikilink-parser`、`wiki-index`。
2. schema 迁移：三层表 + FTS5 + links + 触发器 + meta，加回填。
3. `wiki:*` 判别命令 + main 分派 + preload 类型 + renderer hook。
4. MemoriesPage 新增 Wiki Tab：空状态、登记资料、建页、编辑、保存（新 revision）、虚拟树、搜索、反链、历史/回滚。
5. Markdown 批量导出。
6. 就近 Vitest：path 唯一性、链接歧义、revision 回滚后 version 递增、索引重建、FTS 转义。
7. 中文/中英混合样本验证 FTS5；Electron 手工验证全流程。

验收：

- 重启后 page 内容/路径/version 不变。
- 同 agent/user 同 path 不重复；跨 agent/user 隔离。
- 每次保存 version +1 且 revision 可回滚，回滚后 version 继续递增、旧 revision 不被覆盖。
- 搜索定位到页面，`"`/`*` 输入不报错。
- 删 page 不改其他页原文，反链正确清理；删 source 不解绑 page。
- 重建索引后搜索/反链与重建前一致。
- 导出 Markdown 可在无 Lumii 环境阅读。

### 扩展发布门槛

- 扩展 1（AI 编译）：三层模型落定 + 候选 diff + 来源 + 人工确认可用。
- 扩展 2（ERO）：真实跨页关系导航痛点且文本链接不够。
- 扩展 3（向量）：金标集证明 FTS5 召回不足 + 接受模型下载/存储成本。

---

## 10. 参考与许可证边界

只吸收架构思想，不复制代码/schema/实现细节：

- wiki0：索引可重建、wikilink/backlink 产品思想。
- Karpathy DKR：raw 不可变 → wiki 可积累的编译理念（本设计三层分离的直接来源）。
- Anthropic server-memory：后续 ERO 概念模型。
- local-memory-mcp / memex：RRF、软退役、关系强度参考。

禁止复用实现的项目（许可证/权属红线）：`mcp-memory-graph`（PolyForm Noncommercial）、思源笔记（AGPLv3）、缺许可证的 `chenly255-llm-wiki`/`erickmbugua-llm-wiki`、许可冲突的 `aaronsb/memory-graph`、迁移期的 `modelcontextprotocol-servers`。只写 Lumii 自有代码。
