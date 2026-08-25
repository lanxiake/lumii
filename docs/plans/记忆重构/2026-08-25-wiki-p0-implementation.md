# Lumii Wiki 知识库 P0 实施计划

> 日期：2026-08-25
> 设计来源：`docs/design/记忆设计/2026-08-25-wiki-design-p0p1p2.md`
> 范围：P0 - 自动摄入 + AI 分类归档 + 检索
> 周期：3-4 周
> 原则：先做检索原型验证最大未知项，复用既有能力，所有交付可用 CLI 自测

---

## 1. 目标

交付 Wiki 最小闭环：资料不再散乱，进得来、整得齐、查得到（人与 Agent 双端）。

| 核心能力 | 现状 | P0 目标 |
|---------|------|---------|
| 资料摄入 | 上传文件、任务产物散落在 `uploads/`、`outputs/` | 四路自动摄入收件箱，零操作 |
| 分类归档 | 无 | AI 批量分类到固定目录骨架 |
| 检索 | 无 | FTS5 bigram 分词 + BM25 排序，中文可用 |
| Agent 工具 | 无 | 4 个 Wiki 工具（overview/search/read/capture） |
| 界面 | 无 | MemoriesPage 新增 Wiki Tab 两栏界面 |

**可验证性硬要求**：每项交付都能用 `lumii-ui wiki *` CLI 对真实数据自测。

---

## 2. 任务依赖顺序

```
Task 0 检索原型（最大未知项优先）
   ↓ 验证 FTS5 + bigram 可行性
Task 1 Schema 迁移 V15
   ↓
Task 2 Wiki 核心仓库层
   ↓
Task 3 四路摄入钩子
   ↓
Task 4 AI 分类归档管线
   ↓
Task 5 IPC 命令全链路
   ↓
Task 6 Agent 工具族注册
   ↓
Task 7 Wiki Tab 界面
   ↓
Task 8 CLI 命令扩展
   ↓
Task 9 集成测试 + E2E
   ↓
Task 10 真实数据 CLI 自测（验收主场）
```

| Task | 工作量 | 关键产出 |
|------|--------|---------|
| 0 检索原型 | 1.5 天 | FTS5 双路径验证 + bigram 精度实测 |
| 1 Schema 迁移 | 2 天 | 收件箱/资料/页面/修订/运行日志/FTS/索引元信息 7 表 |
| 2 核心仓库 | 3 天 | WikiRepo / Organizer / Classifier 等 8 单元 |
| 3 摄入钩子 | 2 天 | 上传/产物/搜索/沉淀四路接入 |
| 4 归档管线 | 3 天 | 批量分类 + 退避重试 + 队列恢复 |
| 5 IPC 命令 | 2 天 | 12 个 `wiki:*` 命令全链路贯通 |
| 6 Agent 工具 | 1.5 天 | 4 工具注册 + ToolRegistry 集成 |
| 7 Wiki Tab | 3 天 | 两栏界面 + 编辑器 + 待整理视图 |
| 8 CLI 扩展 | 1 天 | `wiki` 命令组 9 个子命令 |
| 9 集成测试 | 2 天 | 就近单测 + E2E 流程 |
| 10 真实数据自测 | 2 天 | CLI 自测脚本 + 人工验收 |

---

## 3. 前置准备（0.5 天）

1. **验证 FTS5 可用性**——Wiki 检索的全部前提：

   ```bash
   node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');
   d.exec(\"CREATE VIRTUAL TABLE t USING fts5(c)\");console.log('FTS5 OK')"
   ```

   同时验证 `better-sqlite3` 回退路径。两者任一不支持，Task 0 必须先收敛降级方案。

2. **确认 tokenizeBigram 可用**：

   ```bash
   cd packages/agent-runtime
   pnpm test segmentation
   ```

   预期：bigram 单测全绿。这是中文检索方案的基础。

3. **建分支 `feat/wiki-p0-mvp`**。

4. **备份真实库**：`cp ~/.lumii/data/lumii.db ~/.lumii/data/lumii.db.pre-wiki.bak`。

5. **确认当前 SCHEMA_VERSION**：应为 14，Wiki 从 V15 起。

---

## 4. Task 0：检索原型验证（1.5 天，最大未知项）

### 为何最优先

设计文档 §1.2 明确：项目**无任何 FTS5 使用先例**。FTS5 本身是未知项，bigram 预分词方案未经生产验证，中文精度是否足够也不确定。

**Task 0 的唯一产出**：用最小代码在两条 SQLite 路径上建 FTS5 表，灌入真实中文样本，验证精度和行为一致性。通过后才启动 Task 1-9。

### 验证步骤

1. **最小 FTS5 表 + bigram 分词**（`packages/agent-runtime/src/wiki/__test__/fts-proto.test.ts`）：

   建表：`wiki_proto_fts` 虚拟表，含 `title_tokens` / `content_tokens` 两列（预分词后的 bigram 序列）。
   写入：调用 `tokenizeBigram(text)` 生成空格分隔的 bigram 序列存入。
   查询：对用户输入施加同一函数，构造 FTS5 MATCH 查询。

2. **双路径行为一致性**：node:sqlite 和 better-sqlite3 两条路径分别执行相同查询，断言 rank 顺序、BM25 分数一致（误差 <1%）。

3. **中文精度实测**（真实样本）：

   | 查询词 | 预期召回目标 | 评估指标 |
   |--------|-------------|---------|
   | "架构设计" | 含"架构"+"设计" bigram 的页面 | top-3 命中率 |
   | "记忆重构" | 本次项目相关页面 | 精确率 >80% |
   | "上传文件" | 功能说明相关页面 | 无误召回不相关页 |
   | 特殊字符 `"引号"` | 不抛异常 | 转义正确 |

4. **误配率人工评估**：bigram 会将"架构设计"分为"架构 / 构设 / 设计"，可能误召回"构建设施"类页面。记录 top-5 结果中不相关页面的比例，若 >30% 则需调整方案。

### 通过标准

- [ ] FTS5 在两条 SQLite 路径均可用
- [ ] bigram 分词后查询不抛异常，特殊字符已转义
- [ ] 3 个中文测试用例目标页面均在 top-3
- [ ] 误配率 <30%
- [ ] 双路径行为一致

**不通过时的退路**：降级为 `LIKE` + 手动 bigram 匹配；或 P1 改为 trigram 分词器（需 SQLite ≥3.34）。

---

## 5. Task 1：Schema 迁移 V15（2 天）

### 位置

`packages/agent-runtime/src/storage/schema.ts` —— `MIGRATIONS` 元组数组追加 V15。`SCHEMA_VERSION` 14 → 15。

### 建表清单（对齐设计 §3.2）

1. `wiki_inbox` —— 收件箱，索引 `(agent_id, user_id, status, created_at DESC)`
2. `wiki_sources` —— 资料层，含 `media_type` / `extracted_text` / `media_meta` / `origin_context` / `archived_at`
3. `wiki_pages` —— 知识层，`(agent_id, user_id, path)` 唯一；含 `category` / `last_used` / `use_count`
4. `wiki_page_revisions` —— 修订层，`(page_id, version)` 唯一
5. `wiki_organize_runs` —— 运行日志，`inbox_ids` 为 JSON 数组
6. `wiki_pages_fts` —— FTS5 虚拟表，索引预分词列
7. `wiki_index_meta` —— 索引元信息键值表

### 关键实现原理

- 用多语句 `db.exec()`，与现有 MIGRATIONS 风格一致
- FTS5 表创建放在末尾，失败则整体回滚
- **不建触发器同步 FTS**：FTS 索引列是预分词产物，由 `WikiIndex.rebuild()` 与写入路径显式维护（触发器无法调用 JS 函数 `tokenizeBigram`）

### 验证方式

- 迁移前后 `SCHEMA_VERSION` 正确递增
- 7 张表建表成功，索引存在（`PRAGMA index_list`）
- 可在空库和已有 V14 数据的库上都跑通
- 单测：`schema.test.ts` 追加 V15 断言

---

## 6. Task 2：Wiki 核心仓库层（3 天）

### 位置

新建 `packages/agent-runtime/src/wiki/`，与 `memory/memory-repo.ts` 同级，直接持有 `DatabaseAdapter`，不建 service/factory 分层。

### 单元清单（对齐设计 §3.10）

| 文件 | 职责 |
|------|------|
| `wiki-repo.ts` | 收件箱取件、页面保存（同事务写修订）、检索、分类统计 |
| `wiki-ingest-hook.ts` | 四路摄入统一入口，去重判定 + 收件箱插入 |
| `wiki-organizer.ts` | 取件→提取→批量分类→落库→写日志，含退避重试 |
| `wiki-content-extractor.ts` | 按媒体类型提取文本 |
| `wiki-classifier.ts` | 分类决策与提示词构造，含落点规则校验 |
| `wiki-index.ts` | 派生索引重建，调用 `tokenizeBigram` 生成检索列 |
| `wiki-query-builder.ts` | 查询分词、特殊字符转义、FTS5 查询构造 |
| `wiki-organize-queue.ts` | 串行异步队列，入队/启动恢复/并发闸门 |
| `types.ts` | 类型定义 |

### 关键实现原理

- **`WikiRepo.savePage`**：同一事务内 `UPDATE wiki_pages SET version=version+1` + `INSERT wiki_page_revisions`
- **`WikiQueryBuilder`**：先对输入调用 `tokenizeBigram` 得到 bigram 集合（标点已过滤），再拼接 FTS5 查询
- **`WikiClassifier` 路径校验**：分类必须落在 `sources/media/inbox`；不得含空段、`..`、绝对路径；校验失败降级到 `inbox/`
- **`WikiOrganizeQueue` 启动恢复**：应用启动时扫描 `status='pending'` 且 `attempt_count` 未超上限的条目重新入队

### 验证方式

- 单测：路径校验、修订写入事务性、分类落点越权降级
- 集成测试：重复摄入跳过、内容变化作为新条目

---

## 7. Task 3：四路摄入钩子接入（2 天）

### 业务流程与挂载点

| 摄入源 | 挂载点（需 Grep 定位） | 摄入策略 |
|--------|----------------------|---------|
| 上传文件 | 文件落盘且元数据注册完成后 | 全自动 |
| 任务产物 | 产物文件写入 `outputs/` 后 | 全自动 |
| 网页搜索 | 搜索结果获取后 | 全自动，记录 URL + 摘要 |
| 对话提取 | 仅显式沉淀信号触发 | 降级处理，固定落 `inbox/` |

### 关键实现位置

1. **上传文件钩子** —— Grep 定位 `file-memory-handler.ts` 或上传 IPC handler，调用 `WikiIngestHook.ingestUpload(path, title, mime)`
2. **任务产物钩子** —— Grep 定位任务产出写入处理点，调用 `WikiIngestHook.ingestOutput(path, title, taskContext)`
3. **网页搜索钩子** —— 定位 `webSearchToolConfig` 执行完成点，调用 `WikiIngestHook.ingestWebSearch(url, title, snippet)`
4. **对话提取钩子** —— 预留 `WikiIngestHook.ingestChat()` 接口，实际通过 `wiki_capture` 工具触发（Task 6）

### 摄入去重逻辑

同一 `source_path` + 内容哈希判定：
- 相同内容重复摄入：跳过
- 相同路径内容变化：作为新条目摄入（旧资料保留）
- 哈希计算：复用 `file-memory-handler.ts` 中的既有哈希函数

### 注意事项

- 钩子内部 try-catch 包裹，失败只记日志不抛错，不影响原流程
- 对话提取降级理由：无明确用户意图信号，全自动会产生大量垃圾页

### 验证方式

- 手工测试：上传文件/运行任务/网页搜索后确认收件箱有记录
- 集成测试：重复上传跳过、内容变化生成新条目
- 异常测试：钩子抛错不影响主流程

---

## 8. Task 4：AI 分类归档管线（3 天）

### 业务流程

```
收件箱取件（批量，同类型聚合）
  → 内容提取（文档/图片/音视频分别处理）
  → 批量分类（单次 LLM 处理一批，返回结构化结果）
  → 落库：写资料→生成摘要页→写修订→标记 organized
  → 写运行日志
```

### 关键实现点

1. **批量合并调用**：将一批条目合并为单次 LLM 请求，批大小按内容长度动态收缩（复用既有 LLM 编排能力估算 token 预算）

2. **内容提取分派**：
   - 文档：正文抽取（复用 `file-memory-handler.ts` 中的文本提取）
   - 图片：调用 `recognizeImage`（`bridge-image-services.ts`），由 `vision` 槽驱动；未启用时降级为元数据
   - 音视频：不转录，仅元数据 + `origin_context`

3. **失败留 pending**：LLM 失败时 `attempt_count += 1`，记录 `last_error`，退避重试（1min → 5min → 30min → 2h，超 4 次转人工处理态但不删除）

4. **部分成功语义**：一批中部分失败时，成功者落库，失败者留 pending，`status = 'partial'`

5. **顺序与并发**：单队列串行，避免并发争抢 LLM 配额与写库冲突

### 注意事项

- 落库顺序：先写 `wiki_sources`（不可变），再写 `wiki_pages` + `wiki_page_revisions`，最后标记 `organized`
- 图片降级在 UI 明示"未生成描述"，允许配置后重新提取

### 验证方式

- 单测：批大小收缩、退避间隔计算、部分成功状态
- 集成测试：LLM 失败场景、vision 槽未启用降级
- 手工测试：10+ 混合文件验证批量合并（LLM 调用次数 << 文件数）

---

## 9. Task 5：IPC 命令全链路（2 天）

### 命令清单（12 个）

| 命令 | 职责 |
|------|------|
| `wiki:inbox:list` | 待整理列表 |
| `wiki:inbox:retry` | 重试分类 |
| `wiki:inbox:discard` | 丢弃条目 |
| `wiki:inbox:organize` | 手动归档 |
| `wiki:page:list` | 列出页面 |
| `wiki:page:get` | 读取单页 |
| `wiki:page:update` | 保存（写新修订） |
| `wiki:page:delete` | 删除页面 |
| `wiki:search` | 全文检索 |
| `wiki:source:get` | 读取资料详情 |
| `wiki:runs:list` | 运行日志 |
| `wiki:index:rebuild` | 重建索引 |

### 五处必须同步

1. `shared` 判别联合类型（Grep 定位记忆系统命令位置，追加 Wiki 命令）
2. main 分派逻辑
3. IPC 白名单（默认拒绝，漏一条命令不通）
4. preload 类型与暴露
5. renderer hook

### 安全边界

- 写操作（organize/update/delete）标注写权限
- `rebuild` 需确认或 `--yes`
- 按 `agent_id`/`user_id` 隔离

### 验证方式

- 逐条命令走通全链路
- 白名单遗漏检测（故意漏一条，确认被拒绝）

---

## 10. Task 6：Agent 工具族注册（1.5 天）

### 位置与实现范式

新增 `apps/windows/src/main/agent-runtime/bridge-wiki-tools.ts`，参照 `bridge-browser-tools.ts` 的按域分文件范式。工具以 `createMtBotTool` 定义，经 `ToolRegistry.registerAll()` 注册。

### 工具清单

| 工具 | 职责 | 只读/写 |
|------|------|---------|
| `wiki_overview` | 各分类页面数 + 近期页面标题 | 只读 |
| `wiki_search` | 检索并返回匹配段落**全文** | 只读 |
| `wiki_read` | 读取指定路径完整页面 | 只读 |
| `wiki_capture` | 沉淀内容到 `inbox/` | 写 |

### 关键实现原理

- `wiki_overview`：让 Agent 先建立地图，避免盲目搜索后误报"没有资料"
- `wiki_search` 返回全文而非短 snippet：一次调用拿到足够上下文，避免多轮往返
- 形态参照 `memorySearchToolConfig` / `memoryReadToolConfig`（`built-in/integration-tools.ts`）
- `wiki_capture` 调用 `WikiIngestHook.ingestChat()`，固定落 `inbox/`

### 验证方式

- 注册后可在 `ToolRegistry.getAll()` 查到 4 个新工具
- 手工测试：Agent 调用 `wiki_overview` 后 `wiki_search`，确认返回结构正确
- 权限测试：`wiki_capture` 触发权限确认，其余三个无需确认

---

## 11. Task 7：Wiki Tab 界面（3 天）

### 位置

`apps/windows/src/renderer/pages/MemoriesPage/`，新增 Wiki Tab。复用 `FileTree.tsx` 树交互思路、`@uiw/react-md-editor`、`useDataThemeColorMode`。

### 界面结构（两栏）

**左栏**：搜索框；固定分类树（`sources/` `media/` `inbox/`，含页数）；「待整理」入口显示计数

**右栏三视图**：
1. 页面视图：标题/路径/正文渲染+编辑，来源资料链接，运行日志入口
2. 待整理视图：收件箱列表，支持重试/丢弃/手动归档
3. 运行日志视图：归档批次与结果概要

### 关键实现点

- 空状态：说明自动收集，不生成示例数据
- 窄窗口：左栏可折叠
- P0 编辑能力最小化：只改标题/路径/正文
- 样式限定在 `MemoriesPage` 作用域

### 验证方式

- 空状态正确显示
- 待整理列表操作生效（重试/丢弃）
- 编辑保存后持久化且版本递增
- 窄窗口折叠正常

---

## 12. Task 8：CLI 命令扩展（1 天）

### 位置

`apps/windows/resources/app-ui-cli/commands.mjs`，声明式注册表。

### 新增 `wiki` 命令组

| 子命令 | 用途 |
|--------|------|
| `wiki inbox list [--status X]` | 列出收件箱 |
| `wiki inbox retry <id>` | 重试分类 |
| `wiki inbox discard <id>` | 丢弃条目 |
| `wiki inbox organize <id> --path P` | 手动归档 |
| `wiki page list [--category C]` | 列出页面 |
| `wiki page get <path>` | 读取单页 |
| `wiki search <关键词> [--limit N]` | FTS5 检索 |
| `wiki runs list` | 运行日志 |
| `wiki index rebuild` | 重建索引 |

### 关键实现点

- 退出码约定：`ok:0 / other:1 / usage:2 / appDown:3 / auth:4 / denied:5`
- 路由：`{ method: 'POST', path: '/ipc/agent/wiki/...' }`，`group: 'Wiki'`

### 验证方式

- 子命令正确路由并返回预期结构
- 错误参数返回正确错误码

---

## 13. Task 9：集成测试 + E2E（2 天）

### 就近单元测试清单

| 测试点 | 覆盖内容 |
|--------|---------|
| 路径校验 | 合法/`..`/绝对路径/空段 |
| 分类结果校验 | 越权分类降级到 inbox |
| 批量分类切分 | 超长内容触发收缩 |
| 失败重试流转 | pending→重试失败→计数递增→超限转人工态 |
| 修订写入事务性 | 保存失败时页面与修订均不落地 |
| 索引重建 | 重建后条数一致 |
| 查询转义 | 引号星号不报错 |
| 双路径一致性 | 复用 Task 0 验证脚本 |

### E2E 流程

上传文件→收件箱记录→自动分类归档→Wiki Tab 显示新页→检索命中→Agent 工具检索命中→手动编辑→版本递增→运行日志可追溯。

### 验证方式

- `pnpm lint` / `typecheck` / `test` 全绿
- E2E 手工走通一遍并记录耗时

---

## 14. Task 10：真实数据 CLI 自测（2 天，验收主场）

详细步骤见配套文档 `2026-08-25-wiki-p0-cli-test.md`。

### 自测前提

- 应用已启动，控制口可达
- 建议先用拷贝库验证无破坏性后再对主库操作
- 准备真实素材：3-5 个不同类型文件、1 次网页搜索、1 段显式沉淀对话

### 核心验证维度

1. 摄入零操作：上传/产物/搜索后自动出现在收件箱
2. 批量效率：LLM 调用次数远小于文件数
3. 失败可见不丢数据
4. 中文检索质量：真实样本验证多字词精度
5. 可追溯：运行日志可查生成依据
6. Agent 侧可用：工具正常调用

---

## 15. 验收清单

**功能**

- [ ] Task 0 检索原型通过，误配率 <30%
- [ ] Schema V15 迁移成功，7 张表齐全
- [ ] 四路摄入钩子接入且不影响原流程
- [ ] AI 分类批量合并生效，失败不丢数据
- [ ] 12 个 IPC 命令全链路贯通
- [ ] 4 个 Agent 工具注册成功
- [ ] Wiki Tab 三视图全部可用
- [ ] 9 个 CLI 子命令可用

**质量**

- [ ] `pnpm lint` / `typecheck` / `test` 全绿
- [ ] P0 非目标（wikilink、修订历史 UI、导出、附件嵌入、归档清理 UI、概念/实体页、综述、图谱、向量检索、音视频转录）确认未实现，避免范围蔓延
- [ ] Task 10 CLI 自测全部通过，输出留档
- [ ] 未提交数据库、用户数据、密钥

---

## 16. 风险与回滚

| 风险 | 应对 |
|------|------|
| FTS5 双路径行为不一致 | Task 0 前置验证；不一致则选定一条为准 |
| bigram 精度不足 | Task 0 实测把关；P1 可切 trigram |
| vision 槽未配置 | 降级为元数据，UI 明示 |
| 全自动分类准确率不足 | 落点规则约束 AI 自由度；运行日志可追溯 |
| LLM 成本超预期 | 批量合并；提示词精简；串行限流 |
| 摄入钩子影响原流程稳定性 | try-catch 隔离，失败不影响主流程 |
| Schema 迁移失败 | 前置备份；FTS5 表可直接 DROP 重建 |
| 对话提取产生噪音 | 仅显式信号触发，落 inbox 待处理 |

**回滚顺序**：`DROP TABLE wiki_pages_fts` → 检索降级不可用 → 必要时恢复备份库。摄入钩子与 Agent 工具是新增代码，git revert 即可禁用。

---

## 17. 一句话总结

先用 Task 0 收敛最大未知项（FTS5 + bigram 中文检索可行性），再按 schema→仓库层→摄入→归档→IPC→Agent 工具→界面→CLI 顺序交付，遵循设计文档五条原则；所有成果都能用 `lumii-ui wiki *` 对真实数据自测验证。
