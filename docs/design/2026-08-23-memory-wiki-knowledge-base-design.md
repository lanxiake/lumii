# Lumii 记忆 + Wiki 知识库技术设计（方法论调研 + 方案设计）

> 日期：2026-08-23
> 状态：头脑风暴/调研稿（非实施规格）
> 目的：调研社区成熟的"记忆 + LLM Wiki"开源方案，提炼方法论，设计 Lumii 内建的用户记忆与资料管理功能。所有外部项目均已核实存在（2026-08 检索），链接见文末「参考项目清单」。

---

## 1. 背景与目标

Lumii 是本地优先的 AI 桌面伙伴（Electron + React + SQLite）。用户在使用 Lumii 客户端时需要：

1. **结构化记忆管理**：AI 对话中提取的记忆、用户手动记录的信息，需要可查、可编辑、可组织。
2. **资料文档管理**：用户上传的资料（PDF/文档/网页）、任务过程中产生的文档，需要归档、检索、关联。
3. **Wiki 式知识沉淀**：不只是"存文件"，而是让 AI 把资料**编译**成可积累的结构化知识，随使用越来越聪明。

约束：本地化、轻量化（复用现有 SQLite 栈，不引入 Docker/独立服务）、用户可感知的产品功能（而非仅面向 AI 的 MCP 插件）。

---

## 2. 现状盘点（Lumii 已有的基础）

| 现有资产 | 位置 | 说明 |
|---|---|---|
| LocalDatabase（node:sqlite / better-sqlite3 回退） | `packages/agent-runtime/src/storage/local-database.ts` | Schema 版本迁移机制（当前 V14），含备份/轮转/损坏恢复 |
| `agent_memories` 表 | `packages/agent-runtime/src/storage/schema.ts` | 5 类记忆（user/feedback/project/reference/general），含 importance、tags、last_used、use_count、is_archived、source_segment_id |
| AgentMemoryRepo 热记忆加载 | `packages/agent-runtime/src/memory/memory-repo.ts` | importance 加权 + recency 加分 + 相关性门控（overlap 系数），已有"时间衰减"雏形 |
| user_memory Markdown | FileMemoryHandler → `consolidateUserMemory` | 个人记忆（user/feedback 类）写入 Markdown 全文，LLM 去重合并 |
| 文件处理 | `apps/windows/src/main/agent-runtime/file-memory-handler.ts` | 上传/输出文件分类、MIME 识别、文件元数据注册、文件→记忆候选提取 |
| MemPalace 插件 | MemoriesPage「记忆插件」Tab | Wing/Room/Drawer 空间隐喻 + 向量检索（插件式，独立于核心） |
| MemoriesPage UI | `apps/windows/src/renderer/pages/MemoriesPage/` | 已有 4 Tab（AI灵魂/AI记忆/user-memory/插件），复用 `@uiw/react-md-editor` |
| 多模型 LLM 调用 | BridgeContextCompactor 等 | 已有 LLM 编排能力，可复用于"编译"流程 |

**结论**：记忆的"提取→存储→注入"链路已完整；缺的是**面向用户的知识管理界面**（Wiki/资料库）和**知识组织的方法论**（图谱、矛盾检测、编译式沉淀）。

---

## 3. 参考项目调研（全部已核实，2026-08）

### 3.1 记忆图谱类（MCP 记忆服务器）

**3.1.1 [YonasValentin/mcp-memory-graph](https://github.com/YonasValentin/mcp-memory-graph)** ⭐ 本次调研重点

> "Local-first memory for Claude Code and any MCP client: hybrid search + knowledge graph in one SQLite file, $0/token, no cloud."

- **技术栈**：Node.js + better-sqlite3 + sqlite-vec + FTS5；Transformers.js 本地跑 `all-MiniLM-L6-v2`（384 维，纯 JS，无 Python/GPU）
- **混合检索**：向量 + BM25 关键词，用 Reciprocal Rank Fusion（RRF）融合，附置信度标签；可选 cross-encoder 重排（~200ms）
- **知识图谱**：记忆与实体互联，支持多跳问答；`use_graph` 开启时融合 HippoRAG Personalized PageRank 分数；`as_of: <时间戳>` 支持历史时刻检索
- **记忆生命周期**：夜间"dream cycle"自动去重、重评分、剪枝、报告知识缺口；access reinforcement + decay
- **51 个 MCP 工具**：CRUD、矛盾检测（self-correcting write gate）、签名溯源、Obsidian vault 往返同步、GDPR 级遗忘
- **基准**：本地 gold set 混合检索 precision@1=0.563 → 加重排 0.813；10K 向量 p95=9.1ms

**可借鉴**：单文件 SQLite 全栈（vec+FTS5 同库）、RRF 融合、矛盾检测、时间衰减、Obsidian 兼容导出。⚠️ 该项目是 MCP server 形态，Lumii 应借鉴其**数据模型与算法**而非直接集成。

**3.1.2 [studiomeyer-io/local-memory-mcp](https://github.com/studiomeyer-io/local-memory-mcp)**（npm: `@studiomeyer/local-memory-mcp`，v2.x）

- 单一 SQLite 文件；混合检索 = FTS5(BM25) + 本地向量（`Xenova/multilingual-e5-small`，384 维，q8 量化 ~30MB，**多语言含中文**）经 RRF(k=60) 融合；可关闭向量退化为纯 FTS5
- **13+ 工具分类设计**（值得抄 API 设计）：Sessions（会话开始/结束摘要）、Learnings（learn/recall/search，10 种类别：pattern/mistake/insight/research/architecture…）、Decisions（决策记录含 alternatives）、Knowledge Graph（entity_observe/relate/open/search）、Reflection（reflect/insights/profile）
- **双时态（bi-temporal）**：`asOf` 时间点查询；`memory_observation_supersede` 用 tombstone 退役过期事实（Zep fact-supersession 模式）
- **LLM-free 矛盾扫描**：`memory_contradictions` 基于否定词/置信度漂移检测，不依赖 LLM
- **去重 gatekeeper**：入库前阻止重复信息
- 导入导出：版本化 JSON envelope，幂等

**可借鉴**：学习/决策/实体观察的**工具分类体系**、bi-temporal 建模、supersede（退役而非删除）语义、去重守卫。

**3.1.3 [vndee/memex](https://github.com/vndee/memex)**

> "Local-first temporal knowledge graph memory for AI agents. Single Go binary + SQLite. Runs with Ollama — no API keys required."

- **时间知识图谱**：从自然语言抽取实体/关系/事件；**双时态建模**（valid time + transaction time），`--at` 时间查询
- 混合检索：BM25 + 向量 + 图谱遍历三路 RRF；图评分策略 BFS/PageRank/Weighted 可选
- **关系强化**：重复事实用概率并集 `w = 1-(1-a)(1-b)` 强化既有边，而非创建重复
- **记忆生命周期**：Ebbinghaus 遗忘曲线衰减；智能剪枝（去重后再删）；实体合并（3 级解析：精确匹配 → Jaro-Winkler 模糊 → LLM 判定）
- MCP + REST + TUI 三接口；异步摄入队列

**可借鉴**：双时态 schema、关系强度概率合并（天然去重）、三级实体解析、Ebbinghaus 衰减公式。

**3.1.4 [aaronsb/memory-graph](https://github.com/aaronsb/memory-graph)**

- 属性图模型：Memory Nodes（content/tags/summary）+ 有向带强度边，关系类型含 `contradicts` / `refines` / `synthesizes` / `supports`
- Domain 隔离（每域独立子图 + 跨域引用）；JSON/SQLite/MariaDB 多后端
- ⚠️ **作者自述"已被更新的 Knowledge Graph 项目取代"**——作为模型参考（typed edges + strength）价值仍在，但不建议作为依赖方向

**3.1.5 [@modelcontextprotocol/server-memory](https://github.com/modelcontextprotocol/servers)**（Anthropic 官方参考实现）

- **Entity-Relation-Observation（ERO）模型源头**：Entities（name + entityType + observations 列表）、Relations（from/to/relationType 主动语态如 `works_at`）、Observations（离散原子事实，可独立增删）
- Lumii 若做图谱，ERO 是最小可行的正统起点

### 3.2 Wiki / 知识库类

**3.2.1 Karpathy llm-wiki / DKR（Dynamic Knowledge Repository）方法论** ⭐ 本次调研重点

> 核心思想："**Process sources at ingest time, not query time.**" RAG 是解释器（每次查询现算），llm-wiki 是编译器（摄入时编译进 wiki，之后所有推理基于编译产物）。知识随每次添加**复利增长**。

- **三层目录结构**：
  - `raw/` — 事实层，原始资料**不可变**（ground truth，wiki 可从它重建）
  - `wiki/` — 编译层，LLM 拥有写权限（concepts/、entities/、sources/、syntheses/）
  - `index.md` + `log.md` — 注册表（目录 + 追加式审计日志）
- **编译方法论（ingest pipeline）**：
  1. **Triage**：检索 wiki 中与源相关的实体 → 分类为 New（新建文章）/ Update（合并）/ Disputed（矛盾，标 Status block）/ No material（记录后停止）
  2. **Compile**：thesis 匹配则合并；新概念建新页；加交叉引用；**source fidelity**——每个数字/日期/引用必须能在 raw 文件里验证
  3. **Cascade updates**：全库搜索涟漪效应，更新所有受影响的文章；被取代的声明标 `Outdated`/`Disputed` 而非改写历史
  4. **Post-ingest**：更新 index.md + 追加结构化 log.md 条目
- **复利效应**：每个新源更新 10-15 个既有页面，第 100 个源是在浓缩了前 99 个的 wiki 上被解释的

**实现案例（可学习代码）**：
- [nvk/llm-wiki](https://github.com/nvk/llm-wiki)：Claude Code 插件（~900 star），并行多 agent 研究、thesis 驱动、raw/articles/notes 结构、YAML frontmatter、`[[wikilinks]]` Obsidian 兼容
- [geronimo-iia/llm-wiki](https://github.com/geronimo-iia/llm-wiki)：Rust 单二进制 + 23 MCP 工具，git-backed wiki、typed frontmatter JSON Schema 校验、tantivy 搜索、概念图
- [erickmbugua/llm-wiki](https://github.com/erickmbugua/llm-wiki)：Python + FastAPI + SQLite FTS5，Obsidian 兼容 vault（raw/Sources/Concepts/Entities）
- [chenly255/llm-wiki](https://github.com/chenly255/llm-wiki)：Claude Code Skill 形态，7 阶段知识飞轮（ingest→compile→browse→Q&A→flywheel→inspection→vault）

**3.2.2 [spences10/wiki0](https://github.com/spences10/wiki0)**

- "Markdown is the source of truth; SQLite is a rebuildable index/cache"——Markdown wiki 为真相源，SQLite 索引可随时重建
- `[[WikiLinks]]` 遵循 Obsidian 兼容子集；backlinks、facts、graph 视图；CLI + MCP 双层接口
- **可借鉴**：索引可丢弃重建的架构哲学（索引损坏 = 删了重来，数据零损失）

**3.2.3 [siyuan-note/siyuan](https://github.com/siyuan-note/siyuan)（思源笔记）**

- ⭐ 35K+，本地优先个人知识管理的**产品形态标杆**（非技术依赖方向）
- 细粒度块级引用（每段落有全局 ID）、双向链接、Markdown WYSIWYG、本地 `.sy` 文件存储
- **可借鉴**：产品交互（块引用、反链面板、知识网络视图），验证"本地优先知识管理"的产品天花板长什么样

**3.2.4 [Mycel-AI-notes](https://github.com/Mycel-AI-notes)**（TypeScript，obsidian-like 榜上有名）

- 本地优先 Markdown 知识库 + 内建"AI 第二大脑"：纯 .md 文件、wikilinks、图谱视图、内联数据库、私有 GitHub 同步、本地 LLM 检索/关联/推理（搜索能力标注 in feature/开发中）
- **可借鉴**：wiki 数据 + 本地 LLM 增强的产品组合形态

---

## 4. 方法论提炼（五条核心）

### 4.1 ERO 图谱模型（Entity / Relation / Observation）

来源：Anthropic server-memory（原始）；mcp-memory-graph、memex（生产化）。

```
实体（Entity）    —— 有名字、有类型的东西：人、项目、工具、概念
观察（Observation）—— 附在实体上的原子事实，可独立增删/退役
关系（Relation）  —— 有向、带类型、带强度（0-1），主动语态
```

核心操作语义：
- **Supersede（退役）而非删除**：事实过期时 tombstone，保留历史可追溯（studiomeyer-io `memory_observation_supersede`）
- **关系强度概率合并**：重复观察同一边，用 `w = 1-(1-a)(1-b)` 强化而非新建（memex）——这是图谱自动去重的关键
- **三级实体解析**：精确匹配 → 模糊匹配（Jaro-Winkler）→ LLM 判定（memex）

### 4.2 混合检索 + RRF 融合

来源：mcp-memory-graph、studiomeyer-io（k=60 是社区通用经验值）。

```
score(doc) = Σ 1/(k + rank_i)，k=60，分别对 FTS5(BM25) 结果集和向量结果集排名求和
```

- 关键词路径：SQLite FTS5（Lumii 可直接用，零新增依赖）
- 向量路径：本地 embedding（multilingual-e5-small 384 维 q8，~30MB，中文友好）
- 关键设计：**向量层是可开关的**（studiomeyer-io 支持 `MEMORY_EMBED_DISABLED=1` 纯 FTS5 退化）——Lumii 应先上 FTS5，向量作为可选增强

### 4.3 矛盾检测（三档策略）

来源：mcp-memory-graph（write gate）、studiomeyer-io（LLM-free 扫描）、aaronsb（`contradicts` 边类型）。

| 档位 | 方法 | 成本 | 适用 |
|---|---|---|---|
| 轻量 | 否定词/极性冲突规则扫描 | 零 LLM | 入库时快速拦截明显矛盾 |
| 中等 | 向量相似 > 阈值 + 语义冲突判断 | 仅 embedding | 同类事实漂移检测 |
| 深度 | 编译流程的 Disputed 分类 | LLM | Karpathy triage：新源与 wiki 冲突 → 标 Disputed 而非静默覆盖 |

统一语义：**标记而非删除**——Disputed/Outdated 状态 + 保留双方原文。

### 4.4 时间建模与遗忘曲线

来源：memex（双时态 + Ebbinghaus）、Lumii 现有 memory-repo（recency 加分雏形）。

- **双时态**：`valid_from/valid_to`（事实真实有效期）+ `created_at`（记录时间）——"用户 2026 年 1 月住在上海"这个事实在未来可被时间查询正确排除
- **衰减**：`score = importance × (α + β·e^(-Δt/S))`，S 随 use_count 增长（用得越多忘得越慢）
- Lumii 现有 `agent_memories` 已有 last_used/use_count/recency bonus，只需把公式显式化并复用到 wiki 内容

### 4.5 DKR 编译流程（Karpathy）

来源：Karpathy llm-wiki gist + 各实现（nvk/geronimo-iia/chenly255）。

> raw/（不可变）→ LLM 编译 → wiki/（可积累）→ index.md + log.md（注册表）

编译四步：Triage → Compile（source fidelity：引用必须能回溯到 raw）→ Cascade（涟漪更新，标 Outdated 而非改历史）→ Post-ingest（更新 index + log）。

**复利效应**是这套方法论的核心价值主张：每个新资料在浓缩了旧资料的 wiki 上被编译，知识网络密度随时间非线性增长。

---

## 5. Lumii 目标架构设计

### 5.1 设计原则

1. **复用现有栈**：LocalDatabase（node:sqlite/better-sqlite3）+ 现有 schema 迁移机制，不引入新依赖、独立服务或 MCP 层
2. **用户产品功能优先**：新增能力是用户在 Lumii 界面里可感知的（页面 + 编辑 + 检索），而不是只给 AI 用的隐藏插件
3. **真相源 = 用户数据**：wiki 内容以 Markdown 为真相源；SQLite 索引可重建（wiki0 哲学）
4. **三层数据流**（Karpathy DKR 映射到 Lumii）：

```
raw/（资料层，不可变）           —— 用户上传的文档、任务产物 → wiki_documents(kind='raw')
wiki/（编译层，AI 可写）          —— AI 编译的结构化页面 → wiki_pages(kind='wiki')
索引层（可重建）                 —— FTS5 +（可选）向量；损坏即重建
```

5. **图谱渐进引入**：ERO 三表独立演进，MVP 可不依赖图谱

### 5.2 数据模型（草案，schema V15+ 演进）

```
wiki_pages
  id, kind(raw|wiki|note), path, title, content_md, frontmatter_json,
  status(active|outdated|disputed), source_page_id(编译来源，可空),
  created_at, updated_at, last_used, use_count
  └── FTS5 虚拟表 wiki_pages_fts(title, content, tags)

wiki_entities
  id, name, entity_type, created_at, updated_at

wiki_observations            -- 原子事实（ERO 的 O）
  id, entity_id, content, confidence,
  valid_from, valid_to,      -- 双时态（memex 模式）
  status(active|superseded|disputed), supersedes_id,
  created_at

wiki_relations               -- 有向带强度边
  id, source_entity_id, target_entity_id, relation_type,
  strength(0-1), created_at

wiki_compile_log             -- log.md 的数据库形态，追加式
  id, run_at, source_page_id, action(new|update|disputed|no_material),
  summary, pages_touched_json
```

关键语义（全部来自第 4 节方法论）：
- `status` 与 `supersedes_id`：退役而非删除
- 关系 upsert 时概率合并 strength
- `valid_from/valid_to`：时间点查询排除过期事实
- `wiki_compile_log`：每次编译的审计轨迹（= Karpathy log.md）

### 5.3 关键机制落地

**检索**：`wiki:search` = FTS5 BM25（MVP）→ +向量 RRF(k=60)（V2，向量层可开关）。复用 MemoriesPage 现有搜索交互模式。

**编译管线**（V2，复用现有 LLM 编排能力）：
- 触发时机：用户上传资料后、AI 任务产出文档后、手动点"编译"
- 流程：Triage（检索相关页 → 四分类）→ Compile（合并/新建 + source fidelity 校验）→ Cascade（更新受影响页，标 Outdated）→ Post-ingest（写 compile_log + 更新索引）
- 失败语义：No material / Disputed 都要落 log，禁止静默丢弃

**矛盾检测**（V2）：入库守卫（轻量规则）→ 编译时 Disputed 分类（LLM）→ 定期扫描（可选，向量相似 + 漂移）

**遗忘曲线**（V2）：wiki_pages 增加 last_used/use_count，搜索排序与"相关页面推荐"融入衰减公式

### 5.4 UI 形态

在现有 MemoriesPage 增加「知识库/Wiki」Tab（或独立页面）：

- **文件树**：按 path 组织（raw 资料夹 / wiki 编译页 / 笔记），支持文件夹
- **编辑器**：复用 `@uiw/react-md-editor`；支持 `[[wikilinks]]`（Obsidian 子集）
- **反链面板**：显示引用当前页的页面（wiki0 的 backlinks）
- **图谱视图**（V3）：实体-关系可视化（现有 `@xyflow/react` 依赖可复用）
- **编译日志视图**：展示 compile_log（透明审计）
- 导出：Markdown 批量导出（Obsidian 兼容 = 用户数据可带走）

### 5.5 分阶段路线

| 阶段 | 范围 | 方法论来源 |
|---|---|---|
| **P0（MVP）** | schema 迁移（wiki_pages + FTS5）；WikiPageRepo CRUD + 搜索；IPC 桥接；MemoriesPage Wiki Tab（树 + 编辑器 + 反链）；Markdown 导出 | wiki0（索引可重建）、Karpathy（raw/wiki 分层） |
| **P1（编译）** | LLM 编译管线（Triage/Compile/Cascade/log）；source fidelity 校验；Outdated/Disputed 状态 | Karpathy DKR、nvk/geronimo-iia |
| **P2（图谱+时间）** | ERO 三表；supersede 语义；矛盾扫描；双时态查询；关系强度合并 | Anthropic server-memory、memex、studiomeyer-io、mcp-memory-graph |
| **P3（智能检索）** | 本地 embedding（multilingual-e5-small）+ sqlite-vec + RRF；相关推荐 + 遗忘曲线 | mcp-memory-graph、studiomeyer-io |

依赖评估：P0 零新依赖；P2 纯 SQLite 零新依赖；P3 需引入 embedding 运行时（Transformers.js 或复用 MemPalace 已有向量能力，待验证 MemPalace 是否可复用）。

### 5.6 与现有系统的边界

- **agent_memories（AI 提取记忆）**：保留现状不动；未来 wiki_entities 可作为其记忆的"可引用锚点"，但 MVP 不做打通
- **MemPalace 插件**：定位为插件生态的一部分；核心 wiki 功能不依赖它；P3 向量层优先复用其 embedding，若不可复用再独立引入
- **user_memory Markdown**：保留；wiki 不替代它，wiki 是"知识"，user_memory 是"画像"

---

## 6. 待验证清单（有空时人工核实）

学习参考项目时建议按以下顺序，边看边回答右侧问题：

| # | 项目 | 要验证的问题 |
|---|---|---|
| 1 | YonasValentin/mcp-memory-graph | 矛盾检测 write gate 的具体实现；dream cycle 去重/剪枝算法；向量表 schema |
| 2 | Karpathy llm-wiki 原始 gist | DKR 原文表述（编译四步是否为社区实现补充）；raw→wiki 的目录细节 |
| 3 | studiomeyer-io/local-memory-mcp | 21 工具完整清单；LLM-free 矛盾扫描的否定词表；supersede 的 tombstone 实现 |
| 4 | vndee/memex | 双时态 SQL schema；Ebbinghaus 衰减具体公式；三级实体解析的模糊匹配阈值 |
| 5 | spences10/wiki0 | "索引可重建"的具体机制（重建命令、数据流）；wikilinks 解析规则 |
| 6 | nvk/llm-wiki | 编译时 Cascade 更新的触发范围算法；YAML frontmatter schema |
| 7 | 思源笔记 | 块级引用的产品交互；反链面板 UX（作为 UI 参考，非技术参考） |

⚠️ **易混淆项目注意**（检索中发现的坑）：
- PyPI 上的 `mcp-memory-graph`（RetroRobAI，Python）与 npm 的（YonasValentin，Node）是**两个不同项目**；另有一个 `memory-graph/memory-graph`（支持 Neo4j/Memgraph 后端）也是独立的
- `Ekgardt/llm-wiki` **不存在**——本会话早先口述中出现过此名，检索证实真实项目是 geronimo-iia/llm-wiki 等
- aaronsb/memory-graph 作者已转向新项目 "Knowledge Graph"，旧仓库模型仍值得读

---

## 7. 参考项目清单（附链接）

**记忆图谱类**
- [YonasValentin/mcp-memory-graph](https://github.com/YonasValentin/mcp-memory-graph) — Node + better-sqlite3 + sqlite-vec + FTS5，混合检索 + 知识图谱 + dream cycle（本次调研重点）
- [studiomeyer-io/local-memory-mcp](https://github.com/studiomeyer-io/local-memory-mcp) — 13+ 工具分类体系、bi-temporal、supersede、LLM-free 矛盾扫描
- [vndee/memex](https://github.com/vndee/memex) — Go 单二进制 + Ollama，时间知识图谱、双时态、Ebbinghaus 衰减、关系强度概率合并
- [aaronsb/memory-graph](https://github.com/aaronsb/memory-graph) — 属性图 + 带类型带强度边（`contradicts`/`refines`/`synthesizes`）；作者已转向新项目
- [@modelcontextprotocol/server-memory](https://github.com/modelcontextprotocol/servers) — Anthropic 官方 ERO 模型参考实现

**Wiki / 知识库类**
- Karpathy llm-wiki（DKR 方法论原始出处，gist；方法论综述见 [阿里云开发者社区文章](https://developer.aliyun.com/article/1725697)）
- [nvk/llm-wiki](https://github.com/nvk/llm-wiki) — Claude Code 插件，多 agent 研究 + raw/articles 结构 + wikilinks
- [geronimo-iia/llm-wiki](https://github.com/geronimo-iia/llm-wiki) — Rust 单二进制 + MCP + git-backed wiki + typed frontmatter
- [erickmbugua/llm-wiki](https://github.com/erickmbugua/llm-wiki) — Python + FastAPI + SQLite FTS5，Obsidian 兼容 vault
- [chenly255/llm-wiki](https://github.com/chenly255/llm-wiki) — Claude Code Skill，7 阶段知识飞轮
- [spences10/wiki0](https://github.com/spences10/wiki0) — Markdown 真相源 + SQLite 可重建索引 + backlinks
- [siyuan-note/siyuan](https://github.com/siyuan-note/siyuan) — 思源笔记，本地优先知识管理产品标杆（35K+ star）
- [Mycel-AI-notes](https://github.com/Mycel-AI-notes) — TypeScript 本地优先 Markdown 知识库 + 本地 LLM 第二大脑

---

## 8. 开放问题（下次讨论）

1. Wiki 存储形态：**Markdown 文件树**（可 git 同步、Obsidian 互通）vs **SQLite 单库**（查询强、备份简单）vs 混合（文件为真相源 + 库为索引，wiki0 模式）？倾向：混合，与 5.1 原则 3 一致
2. P3 向量层：复用 MemPalace 现有 embedding 还是引入 Transformers.js？取决于 MemPalace 服务是否可脱离插件独立调用
3. 图谱 UI 优先级：P2 的图谱是否必须配可视化（@xyflow/react）？还是先只做检索侧价值（多跳问答、时间查询），图谱视图放 P3
4. 编译触发策略：全自动（每次上传后后台跑）vs 手动（用户点按钮）vs 混合（自动候选 + 用户确认）？成本与可预测性的权衡
5. wiki_pages 与 agent_memories 的关系：编译产物要不要回写记忆系统（知识飞轮的闭环）？
