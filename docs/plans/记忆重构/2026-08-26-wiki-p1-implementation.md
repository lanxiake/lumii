# Lumii Wiki 知识库 P1 实施计划

> 日期：2026-08-26
> 设计来源：`docs/design/记忆设计/2026-08-25-wiki-design-p0p1p2.md` §4
> 范围：P1 - 知识组织闭环 + 归档清理 + 导出
> 周期：2-3 周（P0 已落地，本阶段为增量）
> 原则：修订即保护、链接解析失败不破坏正文、一切写操作可追溯、可 CLI 自测

---

## 0. 现状核实（2026-08-26 代码实况，与设计文档有两处出入）

| 项 | 设计文档所述 | 代码实际 | 对 P1 的影响 |
|---|---|---|---|
| SCHEMA_VERSION | V14/V15 | **V17**（V16 建 wiki 7 表，V17 给 `wiki_organize_runs` 加 `degraded` 状态） | P1 从 **V18** 起 |
| `diff` 依赖 | 「已装」 | **未安装**，全库无引用 | 修订对比改用自写行级 diff（见 Task 3），不新增依赖 |
| 后端 8 单元 | 全部就绪 | `WikiRepo`(567 行)/`WikiOrganizer`/`WikiClassifier`/`WikiIndexRepo`/`WikiIngestHook`/`WikiContentExtractor`/`WikiOrganizeQueue`/`types.ts` 均已落地 | P1 全部增量挂在这些单元上 |
| IPC 命令 | 12 个 | 12 个 `wiki:*` 命令全链路贯通 | P1 新增命令沿用同一条五步链路 |
| Agent 工具 | 4 个 | `wiki_overview/search/read/capture` 已注册 | P1 无需新增工具（可选项见 Task 9） |
| 前端 | 两栏 | `WikiTab.tsx` 355 行两栏，MDEditor 编辑态已有 | P1 恢复第三栏 |
| `archived_at` / `last_used` / `use_count` | P0 落字段 | **均已存在**，`WikiRepo.touchPage()` 已实现 | 清理建议可直接写，无需迁移 |
| 图可视化依赖 | 未定 | `@xyflow/react` + `@dagrejs/dagre` 已装且被 CronPage/PipelineGraph 使用 | P2 图谱直接复用 |
| 文件对话框 | 未定 | `dialog:showSaveDialog/showOpenDialog` IPC 已存在 | 导出选目录直接复用 |

---

## 1. 目标

P0 解决「进得来、整得齐、查得到」，P1 解决「**改得动、理得清、带得走**」。

| 核心能力 | P0 现状 | P1 目标 |
|---------|---------|---------|
| 页面链接与反链 | 无 | `[[标题]]` 解析、链接索引、反链列表 |
| 修订历史 | 只写不读 | 版本列表 + diff 对比 + 回滚（回滚=新增版本） |
| 归档清理 | 字段已落 | 清理建议 + 批量归档/恢复/删除 |
| 附件 | 无 | 编辑器拖拽上传 + 页面附件渲染 |
| 概念/实体页 | `concepts/`、`entities/` 分类已定义但 AI 不写 | 复现门槛 + 候选确认流程 |
| Markdown 导出 | 无 | 按路径结构批量导出，含失败清单 |

**范围控制**：合成综述（`syntheses/`）、图谱可视化、页面状态与矛盾提示、向量检索、遗忘曲线排序均属 **P2**，本阶段不实现。

---

## 2. 任务依赖顺序

```
Task 1 Schema V18（链接表 + 附件表 + 页面状态列）
   ↓
Task 2 Wikilink 解析 + 链接索引 + 反链（后端核心）
   ↓
Task 3 修订历史 diff + 回滚（后端 + 自写 diff）
   ↓
Task 4 归档清理（清理建议 + 批量操作）
   ↓
Task 5 附件上传与渲染
   ↓
Task 6 概念/实体页（复现门槛 + 确认流程）
   ↓
Task 7 Markdown 批量导出
   ↓
Task 8 界面增量（第三栏 + 清理视图 + 编辑器增强）
   ↓
Task 9 IPC 命令全链路 + CLI 扩展
   ↓
Task 10 测试与真实数据自测
```

| Task | 工作量 | 关键产出 |
|------|--------|---------|
| 1 Schema V18 | 0.5 天 | `wiki_links` + `wiki_page_attachments` 两表，`wiki_pages.status` 列 |
| 2 Wikilink + 反链 | 2 天 | `WikiLinkResolver` + `WikiRepo` 反链查询 |
| 3 修订 diff + 回滚 | 1.5 天 | `line-diff.ts` + `WikiRepo.rollbackPage()` |
| 4 归档清理 | 1.5 天 | `WikiCleanupScanner` + 批量操作 |
| 5 附件 | 1.5 天 | 拖拽上传 + 附件渲染 + 导出携带 |
| 6 概念/实体页 | 2 天 | 复现门槛扫描 + 候选确认 |
| 7 Markdown 导出 | 1 天 | `WikiExporter` + 失败清单 |
| 8 界面增量 | 2.5 天 | 第三栏 + 清理视图 + 编辑器增强 |
| 9 IPC + CLI | 1.5 天 | 8 个新命令 + 5 个 CLI 子命令 |
| 10 测试自测 | 2 天 | 单测 + E2E + 真实数据验证 |

---

## 3. Task 1：Schema 迁移 V18（0.5 天）

### 位置

`packages/agent-runtime/src/storage/schema.ts` —— `MIGRATIONS` 数组追加 `[18, ...]`，`SCHEMA_VERSION` 17 → 18。

### DDL 设计

```sql
-- wiki_links：页面间有向链接索引（反链与 P2 图谱的数据源）
CREATE TABLE IF NOT EXISTS wiki_links (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  source_page_id TEXT NOT NULL,
  target_page_id TEXT,              -- 未解析链接为 NULL（保留原文，允许先链接后建页）
  anchor_text    TEXT NOT NULL,     -- [[...]] 内原文
  is_resolved    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_links_target ON wiki_links (agent_id, user_id, target_page_id, is_resolved);
CREATE INDEX IF NOT EXISTS idx_wiki_links_source ON wiki_links (source_page_id);
```

`target_page_id` 不带外键约束：删除目标页时链接索引级联清理由 `WikiRepo` 显式完成，其他页正文中的 `[[...]]` 文本**保留为未解析**（设计 §4.3 删除语义）。

```sql
-- wiki_page_attachments：页面附件关联
CREATE TABLE IF NOT EXISTS wiki_page_attachments (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  source_id   TEXT,                 -- 可关联既有资料条目（同一文件不重复存储）
  file_path   TEXT NOT NULL,        -- 只引用路径不搬移文件（沿用 P0 约定）
  media_type  TEXT NOT NULL DEFAULT 'document'
    CHECK (media_type IN ('document', 'image', 'audio', 'video')),
  display_name TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_attachments_page ON wiki_page_attachments (page_id);

-- wiki_pages 增加页面状态列（P2 §5.2 前置落字段，P1 只落不读）
ALTER TABLE wiki_pages ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'outdated', 'doubtful', 'archived'));
```

### 注意

- `wiki_pages.status` 的 `archived` 与 `wiki_sources.archived_at` 是两套机制：后者是资料归档（Task 4），前者是页面状态（P2 启用）。迁移只加列，P1 不写页面状态。
- SQLite `ALTER TABLE ADD COLUMN` 带 CHECK 约束可行（与 V17 的整表重建不同，无需 copy 流程）。

### 验证方式

- 空库与 V17 数据库均可迁移，`SCHEMA_VERSION` = 18
- 两张新表 + 新列存在（`PRAGMA table_info`）
- 追加 `schema-wiki.test.ts` V18 断言

---

## 4. Task 2：Wikilink 解析 + 链接索引 + 反链（2 天）

### 位置

- 新建 `packages/agent-runtime/src/wiki/wiki-link-parser.ts`（纯函数）
- 新建 `packages/agent-runtime/src/wiki/wiki-link-resolver.ts`
- `wiki-repo.ts` 追加链接索引与反链方法

### 4.1 解析规则（设计 §4.1）

支持两种子集：`[[页面标题]]` 与 `[[目录/页面标题]]`。不支持别名、锚点、块引用、嵌入。

```
parser: /\[\[([^\[\]\n]+)\]\]/g   —— 单行内匹配，跨行不解析
```

解析出的候选文本须做路径规范化（复用 `types.ts` 的 `validateWikiPath` 思路），再按三规则匹配：

1. 带路径的按规范化路径精确匹配；
2. 不带路径的先匹配**当前目录**下同标题，再匹配**全库唯一**标题；
3. 多重匹配**不写边**，返回歧义候选列表（UI 非阻塞提示，引导改为带路径写法）；
4. 未匹配不写边但保留原文（允许「先链接后建页」，建页后下次保存或重建时解析）。

### 4.2 链接索引维护时机

- **`WikiRepo.savePage()`**：保存页面时在同事务内重算该页的链接索引（删除旧行 → 解析 → 插入新行）。解析失败/歧义的行以 `is_resolved=0` 落库（歧义行可落 `anchor_text` 供 UI 展示候选）。
- **`WikiRepo.deletePage()`**：级联删除以该页为源的链接行；以该页为目标的链接行置 `target_page_id=NULL, is_resolved=0`。
- **`WikiIndexRepo.rebuildFts()`** 旁挂一个 `WikiRepo.rebuildLinkIndex()`：全量重扫所有页面正文重建链接索引（供解析规则升级后修复）。

### 4.3 反链查询

```typescript
// WikiRepo 新增
listBacklinks(agentId, userId, pageId): WikiBacklink[]   // 含源页标题/路径 + 链接原文 + 解析状态
listOutboundLinks(agentId, userId, pageId): WikiLink[]
listUnresolvedLinks(agentId, userId): WikiLink[]         // 供 UI「未解析链接」入口
```

### 4.4 边界

- AI 归档时可写入链接（分类提示词允许产出正文含 `[[...]]`），但不承担全库维护责任 —— 由保存路径统一重算，无需 organizer 改动。
- 链接解析**永不失败**：任何异常都走未解析分支，正文不动。

### 验证方式

- 单测 `wiki-link-parser.test.ts`：两种子集、跨行不解析、`[[]]` 空、`[[a|b]]` 别名（不解析，保留原文）
- 单测 `wiki-link-resolver.test.ts`：四条解析规则 + 歧义候选 + 先链接后建页（建页后保存触发解析）
- 集成：保存页面 → 链接索引更新；删除目标页 → 反向链接变未解析；`rebuildLinkIndex()` 后条数一致

---

## 5. Task 3：修订历史 diff + 回滚（1.5 天）

### 位置

- 新建 `packages/agent-runtime/src/wiki/line-diff.ts`（自写行级 diff，不新增依赖）
- `wiki-repo.ts` 追加 `listRevisions()` / `rollbackPage()`
- 前端第三栏与 diff 渲染在 Task 8

### 5.1 行级 diff（替代 `diff` 依赖）

设计文档假定 `diff` 依赖已装，实际未装。不新增依赖，写一个 LCS 行 diff：

```typescript
diffLines(oldText: string, newText: string): DiffLine[]
// DiffLine = { type: 'same' | 'add' | 'remove'; text: string }
```

- 按行切分后做 LCS（动态规划），输出统一 diff 格式；
- 页面正文规模（数千字）下 O(n·m) 可接受，**长度积 > 400 万行² 时降级**为「首尾公共前缀/后缀 + 中间整体替换」（`ponytail:` 注释标明上限）；
- 纯函数、无副作用，单测覆盖：全同、全异、单行增删、中文行。

### 5.2 修订列表与回滚

```typescript
// WikiRepo 新增
listRevisions(agentId, userId, pageId): WikiPageRevision[]   // 按 version DESC
rollbackPage(agentId, userId, pageId, targetVersion): WikiPage
```

**回滚语义**（设计 §4.2）：读取目标版本内容作为**一次新的编辑**写入 —— 走 `savePage()` 同一条路径，`version+1`，`editor='user'`，写新修订。旧修订永不被物理修改或覆盖。

### 验证方式

- 单测 `line-diff.test.ts`：四类场景 + 降级路径
- 单测 `wiki-repo.test.ts` 追加：回滚后 version 递增、旧修订内容不变、回滚产生的修订 editor 为 user
- 手工：AI 归档的页被改坏 → 回滚 → 内容恢复且历史链完整

---

## 6. Task 4：归档清理（1.5 天）

### 位置

- 新建 `packages/agent-runtime/src/wiki/wiki-cleanup.ts`（`WikiCleanupScanner`）
- `wiki-repo.ts` 追加归档与批量操作方法

### 6.1 清理建议规则（设计 §4.3）

| 规则 | 判定条件 | 建议动作 |
|------|---------|---------|
| 长期未用 | `last_used` 为空且 `created_at` 早于 N 天（默认 90，可配置） | 归档 |
| 来源失效 | `source_path` 非空且文件已不存在 | 归档或删除 |
| 内容重复 | `content_hash` 相同且非空 | 合并（保留一份，其余归档） |

扫描为只读操作，结果返回给 UI 展示为「待清理清单」，**不自动执行任何动作**。

### 6.2 归档与批量操作

```typescript
// WikiRepo 新增
archiveSources(agentId, userId, sourceIds: string[]): number      // 置 archived_at
restoreSources(agentId, userId, sourceIds: string[]): number      // 清空 archived_at
deleteSources(agentId, userId, sourceIds: string[]): number       // 物理删除，解绑页面来源标注
deletePages(agentId, userId, pageIds: string[]): { deleted: number; affectedBacklinks: number }
```

- 归档后检索默认排除：`WikiRepo.search()` 的 SQL 追加 `AND (s.archived_at IS NULL OR p.id IS NOT NULL)` 语义 —— 具体实现为：归档资料**对应的页面**不出现在搜索结果（P0 已把资料文本索引进页面，排除页面即排除资料）。
- 删除页面时返回**受影响反链数**，UI 二次确认时展示（设计 §4.3）。
- 删除资料条目**不级联删除**引用它的页面，页面仅失去来源标注（`source_ref` 保持原值，来源详情入口显示「资料已删除」）。
- 不做软删除回收站 —— 修订历史与数据库备份双重兜底（设计 §4.3）。

### 验证方式

- 单测：三条建议规则各自命中/不命中；归档后搜索排除；恢复后搜索回来
- 单测：删除页面的反链计数；删除资料不级联删页
- 手工：真实库里跑扫描，确认建议清单合理

---

## 7. Task 5：附件上传与渲染（1.5 天）

### 位置

- 新建 `packages/agent-runtime/src/wiki/wiki-attachments.ts`
- 前端编辑器拖拽（Task 8），本任务先做后端与渲染

### 7.1 后端

```typescript
// WikiRepo 新增
attachFile(agentId, userId, pageId, filePath, mediaType, displayName, sourceId?): WikiAttachment
listAttachments(agentId, userId, pageId): WikiAttachment[]
detachFile(agentId, userId, attachmentId): void
```

**文件落盘策略**：沿用 P0 约定「只引用路径不搬移文件」。编辑器拖入文件时走既有上传通道（上传到 `uploads/YYYY-MM-DD/`，复用 ChatInput 的 file-attachment-strategy 分类与 MIME 判定），随后登记为附件并**插入引用语法**到正文。引用语法沿用项目既有格式：

```
[media attached: /path/to/file (filename)]
```

预览渲染把该语法替换为 `<img>`（图片）或媒体播放器（音视频），与 ChatPage 的渲染行为保持一致。

### 7.2 附件与资料条目关联

同一文件既是资料源又被页面引用时（`attachFile` 传 `sourceId`），不重复存储文件 —— 附件行仅指向既有资料条目路径。P0 摄入的图片/音视频在 `media/` 页上自然成为附件（建页时顺手登记，organizer 小改）。

### 验证方式

- 单测：attach/detach 增删；附件行引用既有 source 不产生新文件
- 手工：拖入图片 → 正文出现引用语法 → 预览渲染为图片 → 导出时文件一并带出（Task 7）

---

## 8. Task 6：概念/实体页（2 天）

### 位置

- 新建 `packages/agent-runtime/src/wiki/wiki-concept-candidate.ts`
- `wiki-classifier.ts` 或独立提示词文件追加候选扫描提示词

### 8.1 复现门槛

同一概念/实体需在 **N 份不同资料**中复现方可建页（默认 N=3，可配置，存 `wiki_index_meta`）。扫描输入为近期资料条目的标题 + 摘要（`sources/` 页正文前 N 字），单次 LLM 调用返回候选概念/实体清单 + 复现证据（哪几份资料）。

### 8.2 候选确认流程（与 sources/media 全自动区别对待）

```
扫描（可手动触发，也可随 organize 批次顺带跑）
  → 生成候选写入 wiki_index_meta 或内存态（不落正式页）
  → UI「概念候选」视图展示：概念名 + 类型 + 复现证据 + 建议正文
  → 用户逐项确认/拒绝
  → 确认的走 WikiRepo.savePage() 建页（editor='ai'，path 落 concepts/ 或 entities/）
  → 相关资料摘要页自动链接到新页（编辑摘要页正文追加 [[概念名]]，走正常保存路径）
```

**不自动建页**：跨资料合并语义出错代价高（设计 §4.5）。候选存储选 `wiki_index_meta`（key 前缀 `concept_candidate:`），不做新表 —— 候选是临时态，用户处理完即清除。

### 8.3 落点约束

- 候选页 path 必须落在 `concepts/` 或 `entities/`，复用 `validateWikiPath`；
- `AI_WRITABLE_CATEGORIES` **不**加入这两类 —— 建页只走确认流程这一条路径，防止 organizer 越权。

### 验证方式

- 单测：复现计数逻辑（N 份资料、去重按资料 id）；候选序列化/清除
- 单测：确认建页落点合法；拒绝不产生任何写入
- 手工：3 份含「微信语音」的资料 → 扫描产生候选 → 确认 → 概念页建出 → 3 个摘要页出现反链

---

## 9. Task 7：Markdown 批量导出（1 天）

### 位置

- 新建 `packages/agent-runtime/src/wiki/wiki-exporter.ts`
- IPC 侧用 `dialog:showSaveDialog` 选目录（已存在，直接复用）

### 9.1 导出逻辑

```typescript
exportPages(agentId, userId, targetDir, options: { includeSources?: boolean; includeAttachments?: boolean }):
  { exported: number; failed: { path: string; error: string }[] }
```

- 按页面 `path` 结构创建目录树，页面写为 `.md`（frontmatter 含 title/category/version/updatedAt）；
- 导出文件名安全化：替换 Windows 非法字符，冲突时追加序号（**不覆盖**）；
- 路径规范化复用 `validateWikiPath` 思路，拒绝空段/`..`/绝对路径（写盘前再次校验，防目录逃逸）；
- 可选附带资料原文（`wiki_sources.content_md`）与附件文件（复制到 `_attachments/` 子目录）；
- 逐页失败返回清单，**不静默跳过**（设计 §4.6）；
- 写入导出清单 `_export-manifest.json`（范围、时间、失败项）。

### 9.2 兼容性目标

导出产物在无 Lumii 环境可正常阅读，`[[标题]]` 链接语法与 Obsidian 兼容（不转换、原样保留）。

### 验证方式

- 单测：目录树生成、非法文件名替换、冲突追加序号、失败清单
- 单测：路径逃逸注入（`../../etc/passwd` 风格）被拒绝
- 手工：导出真实库 → 用 Obsidian 或任意编辑器打开验证

---

## 10. Task 8：界面增量（2.5 天）

### 位置

`apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx`（355 行 → 预计 600+，超过 800 行红线前拆子组件）。

### 10.1 第三栏（设计 §4.7）

页面视图右侧恢复第三栏，两个分块：

1. **反链列表**：指向当前页的页面（标题+路径，点击跳转）；未解析链接入口（全库视角放左栏）；
2. **修订历史**：版本号、时间、编辑者（用户/AI）；点版本号弹 diff 对比（当前版本 vs 选中版本，渲染 `line-diff.ts` 输出，绿色新增/红色删除）；「回滚到此版本」按钮（二次确认后走 `wiki:page:rollback`）。

窄窗口：第三栏折叠到正文下方（沿用 P0 左栏折叠的响应式思路）。

### 10.2 清理视图

- 新视图入口「清理」（左栏）：调 `wiki:cleanup:scan` 展示三类建议（长期未用/来源失效/内容重复），勾选 + 批量归档/恢复/删除；
- 「已归档」分栏：浏览归档资料，一键恢复；
- 删除页面时弹窗展示受影响反链数。

### 10.3 编辑器增强

- **拖拽上传**：MDEditor 外层包 dropzone（复用 ChatInput 的 `handleDragOver/handleDrop` 模式与 file-attachment-strategy），图片即时渲染；
- **链接补全**：输入 `[[` 时弹出候选（`wiki:page:list` 缓存到本地做前缀过滤），选择后插入 `[[标题]]`；存在同名页时显示路径消歧（对应解析规则 2/3）；
- 路径选择器：改路径时下拉已有目录结构（P0 是手输）。

### 10.4 组件拆分预案

`WikiTab.tsx` 增长后按「右栏视图」拆：`PageView.tsx`（含第三栏）、`InboxView.tsx`、`RunsView.tsx`、`CleanupView.tsx`、`LinkAutocomplete.tsx`。样式沿用 `WikiTab.css`，新组件平级放 `components/` 下。

### 验证方式

- 反链跳转、diff 渲染正确、回滚流程走通
- 清理批量操作后列表与搜索行为一致
- 拖拽上传在图片/文档两类文件上验证
- 窄窗口三栏折叠正常

---

## 11. Task 9：IPC 命令全链路 + CLI 扩展（1.5 天）

### 11.1 新命令清单（8 个）

| 命令 | 职责 |
|------|------|
| `wiki:link:backlinks` | 查某页反链 |
| `wiki:link:unresolved` | 未解析链接列表 |
| `wiki:page:revisions` | 修订列表 |
| `wiki:page:diff` | 两版本 diff（前端传 pageId + 两版本号，或返回文本由前端算） |
| `wiki:page:rollback` | 回滚到指定版本 |
| `wiki:cleanup:scan` | 清理建议扫描 |
| `wiki:source:archive` / `wiki:source:restore` / `wiki:source:delete` | 批量归档/恢复/删除 |
| `wiki:attach:list` / `wiki:attach:add` / `wiki:attach:remove` | 附件管理 |
| `wiki:export` | 批量导出（参数含目标目录，由 renderer 先弹 `dialog:showSaveDialog`） |
| `wiki:concept:scan` / `wiki:concept:confirm` / `wiki:concept:reject` | 概念候选流程 |

> `wiki:page:diff` 决策：diff 在**前端算**（`line-diff.ts` 放 `packages/agent-runtime` 被 renderer 引用，或复制到 shared —— 实施时按包依赖方向定），IPC 只提供 `wiki:page:revisions` 取回各版本正文。理由：diff 是纯计算，不碰数据库，放 IPC 徒增一次往返。

### 11.2 五步链路（每条命令，AGENTS.md 第 5 条）

1. `apps/windows/src/shared/agent-runtime-commands.ts` —— 判别联合 + Result 条件类型
2. `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts` —— handler（复用 `resolveAgentIdForWiki`）
3. `apps/windows/src/main/ipc/agent-runtime-ipc.ts` —— switch 分派
4. `apps/windows/src/main/app-ui-control/command-allowlist.ts` —— 白名单（默认拒绝，漏一条不通）
5. `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts` —— hook 封装

### 11.3 CLI 扩展

`apps/windows/resources/app-ui-cli/commands.mjs` 追加：

| 子命令 | 用途 |
|--------|------|
| `wiki backlinks <path>` | 查反链 |
| `wiki revisions <path>` | 修订列表 |
| `wiki rollback <path> <version>` | 回滚 |
| `wiki cleanup scan` | 清理建议 |
| `wiki source archive <id...>` | 批量归档（`--restore` 恢复） |
| `wiki export <dir>` | 批量导出 |

### 验证方式

- 逐条命令走通五步链路
- 白名单遗漏检测（故意漏一条，确认被拒绝）
- CLI 子命令路由与退出码正确

---

## 12. Task 10：测试与真实数据自测（2 天）

### 12.1 就近单元测试清单

| 测试点 | 覆盖内容 |
|--------|---------|
| link-parser | 两种子集、跨行不解析、别名不解析 |
| link-resolver | 四规则、歧义候选、先链接后建页 |
| line-diff | 全同/全异/增删/中文行/降级路径 |
| rollback | 版本递增、旧修订不可变 |
| cleanup | 三规则、归档排除/恢复 |
| attachments | attach/detach、source 关联 |
| concept | 复现计数、候选确认/拒绝 |
| exporter | 目录树、非法文件名、路径逃逸拒绝、失败清单 |
| schema V18 | 迁移断言 |

### 12.2 E2E 流程（手工）

编辑页写 `[[微信语音]]` → 保存 → 反链出现（或未解析入口可见）→ 建目标页 → 再保存源页 → 链接解析 → 回滚编辑 → 内容恢复 → 清理扫描 → 归档 → 搜索排除 → 恢复 → 导出 → 外部打开验证。

### 12.3 真实数据自测

- 备份库：`cp ~/.lumii/data/lumii.db ~/.lumii/data/lumii.db.pre-p1.bak`
- 用真实库跑 `lumii-ui wiki *` 全子命令，输出留档
- 导出真实库 → Obsidian 打开验证链接兼容

---

## 13. 验收清单

**功能**

- [ ] `[[标题]]` 与 `[[目录/标题]]` 解析正确，反链可查，歧义与未解析不破坏正文
- [ ] 任意历史版本可预览、可 diff、可回滚，回滚后旧修订完好
- [ ] 清理清单识别三类问题；归档后检索排除、可恢复；删除页面展示反链影响数
- [ ] 附件可拖拽上传、正确渲染、导出时一并带出
- [ ] 概念/实体候选达到门槛才出现，经确认才落库，确认后自动链接
- [ ] 导出产物在无 Lumii 环境可读，失败项有明确清单
- [ ] 全部新 IPC 命令白名单贯通，CLI 可自测

**质量**

- [ ] `pnpm typecheck` / `pnpm test` 全绿（apps/windows 无 lint 脚本，以 typecheck+test 为准）
- [ ] 无新增 npm 依赖（diff 自写、图库沿用 P2）
- [ ] P2 范围（综述/图谱/页面状态 UI/向量/遗忘排序）确认未实现
- [ ] 未提交数据库、用户数据、密钥

---

## 14. 风险与回滚

| 风险 | 应对 |
|------|------|
| `[[...]]` 解析误伤正文（代码示例里的双括号） | 解析仅产出索引，绝不改写正文；误伤只影响反链列表，可接受 |
| LCS diff 在大页面上慢 | 长度积上限降级策略（Task 3.1），页面规模下实测 |
| 清理建议误判（如误报来源失效） | 扫描只读不执行；所有动作由用户在 UI 确认 |
| 拖拽上传与 ChatInput 策略耦合 | 复用分类函数而非组件，接口隔离 |
| 概念扫描 LLM 产出幻觉概念 | 复现门槛 + 人工确认双重闸门；拒绝即清除不落库 |
| Schema V18 迁移失败 | 前置备份；新表无数据，失败可重跑 |
| 导出目录写盘出错（权限/磁盘满） | 逐页失败清单，不静默跳过 |

**回滚顺序**：新增表/列均为增量，`git revert` 即可；链接索引为派生数据，`rebuildLinkIndex()` 可重建；导出不触碰主库。
