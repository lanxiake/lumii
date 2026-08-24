# Lumii 记忆系统设计（MVP + 扩展）

> 日期：2026-08-24
> 状态：设计定稿（可实施）
> 前置调研：[2026-08-23-memory-wiki-knowledge-base-design.md](./2026-08-23-memory-wiki-knowledge-base-design.md)
> 关联设计：[2026-08-24-wiki-design.md](./2026-08-24-wiki-design.md)
> 定调：轻度保守 + 实用主义。核心目标是让记忆的**存储、提取、注入、展现**四段各有一层清晰的抽象，后续优化时改一处而非改全部。

---

## 0. 结论摘要

| 维度 | 当前实现 | 本方案变化 | 阶段 |
|---|---|---|---|
| 存储 | `agent_memories` 单表，字段完整 | **不改表结构**，加 FTS5 派生索引 | MVP |
| 检索 | `memory-repo.ts:317` `content LIKE %kw%` | FTS5 BM25，search 走虚拟表 | MVP |
| 打分 | `memory-repo.ts:76-85` 硬编码 weight/bonus | 抽出 `MemoryScorer` 纯函数，公式参数可配 | MVP |
| 注入 | `memory-injector.ts:176-188` 用 `indexOf("## 工作记忆")` 切字符串 | 改为结构化记忆块 → 模板渲染，去掉字符串手术 | MVP |
| 索引可靠性 | 无重建手段 | `rebuildMemoryIndex()` 显式重建 | MVP |
| 死代码 | preload 声明 4 个 `api:*Memory` 无 handler | 删除 | MVP |
| 来源可追溯 | provenance 链路已完整 | 保留，不扩展 | - |
| 矛盾/退役 | 无 | 不在 MVP；列为待评估 | 扩展 |

**关键结论（已核实）**：

- MemPalace 向量能力**不可复用**：TS 侧只能整包调用 MCP JSON-RPC，拿不到 embedding 本身。核心记忆要做向量检索须独立引入 Transformers.js。
- 记忆的"提取→存储→注入"链路本身是通的，缺口在**检索质量**（`LIKE` 模糊）与**注入的工程性**（字符串 `indexOf` 切分 system prompt，脆且不可维护）两处。
- provenance 链路已完整（`agent:memories:provenance` + `MemoryViewer` 展示原文）。本设计不重复造它。

---

## 1. 现状（已核实）

存储 `agent_memories`（`schema.ts:68-93`）：`user/feedback/project/reference/general` 五类，含 `importance / tags / source_message_id / source_segment_id / palace_drawer_id / last_used / use_count / is_archived`。

打分 `memory-repo.ts:76-85`：

```
recencyBonus = 0.1 * max(0, 1 - daysSinceUse / 30)
score = importance * categoryWeights[category] + recencyBonus + relevanceBonus * overlapCoefficient(queryTokens, contentTokens)
```

注入 `memory-injector.ts`：`formatUnifiedMemoryBlock` 已把个人记忆/工作记忆/记忆宫殿三层拼成结构化区块；但 `injectMemories`（`:170-191`）仍用 `systemPrompt.indexOf("## 工作记忆")` 定位旧区块、再用 `indexOf("\n## ", start+1)` 找下一节边界做字符串替换。这段代码对标题字符串的精确匹配强依赖，任何标题改动都会静默失效。

检索 `memory-repo.ts:317`：`content LIKE '%' || kw || '%'`，无分词、无 FTS、无 BM25 排序。

---

## 2. MVP

### 2.1 schema：FTS5 派生索引

不改 `agent_memories` 本身，只加一个可重建的全文索引：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_fts USING fts5(
  content, tags,
  content='agent_memories', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
```

同步用触发器维护（INSERT/DELETE/UPDATE 三连，标准 `ai/ad/au` 命名），避免应用层多路手动双写遗漏。迁移脚本里必须一次性回填历史数据：

```sql
INSERT INTO agent_memories_fts(rowid, content, tags)
SELECT rowid, content, tags FROM agent_memories;
```

**中文分词风险必须实测**：`unicode61` 对中文按字符切分而非分词，短语召回可能弱。落地前用现有真实记忆样本跑 `MATCH` 手工验证；若召回差，退路是 FTS5 命中∪`LIKE` 命中取并集，而非引入 jieba 依赖。

### 2.2 打分引擎抽象 `MemoryScorer`（纯函数）

把 `memory-repo.ts:76-105` 里散落的打分长逻辑抽成独立纯函数 `scorer.ts`。这不是抽象过度——打分与检索是两件不同的事，抽出来后可以用不同配置（如"注入用高分截断"vs"搜索用高相关排序"）复用，也便于后续加衰减公式、加向量得分时只改一处：

```typescript
// scorer.ts —— 纯函数，无 db 依赖
export interface MemoryScoreInput {
  readonly importance: number;
  readonly category: MemoryCategory;
  readonly lastUsedAt: number;   // unix ms
  readonly now: number;          // 注入测试可固定，避免测试随墙钟漂移
  readonly relevance: number;    // 0..1，由 overlap 系数算得
}

export function scoreMemory(
  input: MemoryScoreInput,
  cfg: HotMemoryConfig = DEFAULT_HOT_MEMORY_CONFIG,
): number {
  const daysSinceUse = (input.now - input.lastUsedAt) / 86_400_000;
  const recencyBonus = 0.1 * Math.max(0, 1 - daysSinceUse / 30);
  return input.importance * cfg.categoryWeights[input.category]
    + recencyBonus
    + (cfg.relevanceBonus ?? 1.0) * input.relevance;
}
```

`loadTopMemories` 只需遍历行、算 `relevance`、调 `scoreMemory`、排序截断，逻辑明显变薄。`now` 显式传入，测试可注入固定时间戳。

### 2.3 注入改为「结构化块 → 模板渲染」

`formatUnifiedMemoryBlock` 已是结构化输出，问题是 `injectMemories` 的字符串 `indexOf` 替换。改为：

- 把注入点定义为 system prompt 里的**占位符**，而非搜索已有标题。例如 prompt 模板里固定带 `{{MEMORY_BLOCK}}`，`injectMemories` 只做一次字符串占位替换。
- 若不能改生成 system prompt 的宿主模板，则保留 `formatUnifiedMemoryBlock` 产物、由宿主在拼装末尾**追加**，删除"先 indexOf 再替换"的旧路径。

这消除对标题字符串的静默依赖，是"注入形式科学化"的核心改动。具体采用哪种方式，由 system prompt 的组装代码决定（实施时确认），文档不强行指定一种。

### 2.4 检索改造 + 重建入口

```typescript
search(agentId, userId, keyword, limit): readonly MemoryEntry[] {
  const q = escapeFtsQuery(keyword);
  return db.prepare(`
    SELECT m.* FROM agent_memories m
    JOIN agent_memories_fts f ON f.rowid = m.rowid
    WHERE f MATCH ? AND m.agent_id = ? AND m.user_id = ? AND m.is_archived = 0
    ORDER BY bm25(agent_memories_fts) LIMIT ?`).all(q, agentId, userId, limit);
}
```

`rebuildMemoryIndex()` 一条 `DELETE FROM agent_memories_fts` + 一条回填 `SELECT`，挂 `agent:memories:rebuildIndex` 命令（复用链路 B，进 App-UI 白名单），UI 在 AI 记忆 Tab 加"重建索引"按钮。

### 2.5 清理死代码

删除 preload 侧无 handler 的 `api:getMemories`/`createMemory`/`updateMemory`/`deleteMemory` 四通道及其类型（`api-server-http-api.ts:89,96,100,101`、`preload/index.ts:538-556`），已确认 renderer 无引用。

### 2.6 一句话工程化核心（「展现形式更科学」的落点）

对记忆做「存储→派生」分离：`agent_memories` 是**事实真相**，FTS5 是**可重建派生索引**。这与 Wiki 侧"pages 真相 + 索引派生"同构，是后续引入向量、衰减、矛盾候选时都成立的稳定骨架。MVP 只把 FTS5 这一种派生固化下来，之后每加一种检索能力就是再加一张派生表 + 一个重建函数，不再动真相表。

---

## 3. 扩展功能

### 3.1 状态列化（supersede 候选）—— 待评估而非必做

现状只有 `is_archived` 一个失效信号。当"我搬到北京了"取代"我住在上海"，需要标记旧记忆被取代。最小做法：加 `superseded_by TEXT` 列，写新记忆时若判定为同类更新，`UPDATE … SET superseded_by=?, is_archived=1`。

**结论：列为扩展，不进 MVP。** 因为存在一个更关键的先决问题——（1）记忆规模通常未到需要自动矛盾管理的量级；（2）用户可在 MemoriesPage 直接看/编每条记忆，已有人工纠错通道。做它之前需先证明"记忆量大到用户核对不过来"。不引入 `valid_from/valid_to` 双时态：当前不存在"事实在特定时间段成立"的时间点查询需求。

### 3.2 矛盾检测—— 不做的理由已在上一版，重申

调研中的 LLM-free 否定词扫描为英文设计，中文否定语义规则化成本高、误报率高。价值只在记忆量大且用户不逐条核对时才体现。当前不满足前提。**不做。**

### 3.3 向量检索（依赖金标集验证后）

前提：先建 Lumii 自有中文金标查询集，证明 FTS5 关键召回不足，才引入模型。

- 不可复用 MemPalace（已核实）。
- 引入 Transformers.js + 多语言小模型（384 维量化 ~30MB）。
- 向量层必须可开关，关闭时 UI 显式提示降级到纯 FTS5，无静默降级。
- RRF(k=60) 融合，届时用 `score = Σ 1/(60 + rank_i)`。
- 与 2.6 的"派生索引表"骨架天然衔接：新增 `agent_memories_embed(ROWID, vec)` 派生表，重建时逐条 embed 回填即可。

---

## 4. 迁移与实施要点

- schema 迁移两步：`schema.ts:9` 的 `SCHEMA_VERSION` +1；`MIGRATIONS` 末尾追加 `[N, 'CREATE VIRTUAL TABLE ...; CREATE TRIGGER ...; ...; INSERT INTO ... SELECT ...;']`（多语句分号分隔，`db.exec` 支持，照抄 V14 追加形式）。
- FTS 回填必须在同一条迁移 SQL 内完成，不能指望手动"重建索引"。
- 改动落点：`memory-repo.ts`（search）、新增 `scorer.ts`（打分纯函数）、`memory-injector.ts`（去掉 indexOf 替换）、`schema.ts`（FTS）、preload 清理。
- 涉及 IPC 的 `agent:memories:rebuildIndex`：main handler + preload 类型 + renderer 调用三处同步（AGENTS.md 第 5 条）。

---

## 5. 与 Wiki 的边界

`agent_memories` 是「AI 对用户的画像 + 工作上下文」，生命周期跟随对话与任务；Wiki 是「用户主动沉淀的知识」，生命周期跟随用户维护。数据模型与查询模式均不同，MVP 阶段不打通、不回写。详见 [wiki 设计](./2026-08-24-wiki-design.md)。
