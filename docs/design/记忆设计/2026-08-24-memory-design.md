# Lumii 记忆系统设计（MVP + 扩展）

> 日期：2026-08-24
> 状态：设计定稿（可实施）
> 前置调研：[2026-08-23-memory-wiki-knowledge-base-design.md](./2026-08-23-memory-wiki-knowledge-base-design.md)
> 定调：轻度保守 + 实用主义。不重构已工作的链路，只补最小缺口。

---

## 0. 结论摘要

| 维度 | 当前实现 | 本方案变化 | 阶段 |
|---|---|---|---|
| 存储 | `agent_memories` 表（V14），字段完整 | **不改表结构** | - |
| 提取→注入链路 | 规则/LLM/段落总结三路汇入，已工作 | **不动** | - |
| 检索 | `memory-repo.ts:317` `content LIKE %kw%` | 加 FTS5 虚拟表，search() 改走 FTS5 | MVP |
| 索引可靠性 | 无重建手段，索引损坏无法自愈 | 加 `rebuildMemoryIndex()` 显式重建 | MVP |
| 死代码 | preload 声明 4 个 `api:*Memory` 通道无 handler | 删除（未被任何 renderer 代码调用） | MVP |
| 时间语义 | last_used/use_count/recency bonus 已有 | 不变 | - |
| 矛盾检测 | 无 | 不做（YAGNI，现有规模不需要） | 扩展-待评估 |
| 双时态/supersede | 无 | 加 `valid_to` 软退役，仅 user/feedback 类 | 扩展 |
| 向量检索 | 无（MemPalace 不可复用，见下） | Transformers.js 本地 embedding，可关闭 | 扩展 |

**关键结论（核实过，不是假设）**：
- MemPalace 的向量能力**不可复用**。它是外部 PyPI 包 + chromadb，TS 侧只能整包调用 MCP JSON-RPC，拿不到向量本身，也没有独立的 embed 端点。若要给核心记忆加向量检索，必须走 Transformers.js 独立引入，或干脆不做。
- `agent_memories` 的提取→存储→注入链路本身没有问题，缺口只在检索质量（LIKE 模糊匹配）和索引可靠性上。

---

## 1. 现状（已核实）

`packages/agent-runtime/src/storage/schema.ts:68-93`，`agent_memories` V1：

```sql
CREATE TABLE IF NOT EXISTS agent_memories (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('user','feedback','project','reference','general')),
  content TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0.0 AND importance <= 1.0),
  tags TEXT,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, last_used TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0
);
```

打分逻辑（`memory-repo.ts:76-85`）：

```
recencyBonus = 0.1 * max(0, 1 - daysSinceUse / 30)
score = importance * categoryWeights[category] + recencyBonus + relevanceBonus * overlapCoefficient(...)
```

检索（`memory-repo.ts:317`）：`content LIKE '%' || kw || '%'` —— 纯子串匹配，无分词、无排序权重、无中文友好性。

死代码：`preload/api/api-server-http-api.ts:89,96,100,101` 声明了 `api:getMemories`/`api:createMemory`/`api:updateMemory`/`api:deleteMemory`，`preload/index.ts:538-556` 有类型，但 `main/` 下无对应 `ipcMain.handle`。调用会 reject。renderer 现有记忆管理走的是链路 B（`agent-runtime:command`），这四个通道未被任何代码调用。

---

## 2. MVP

### 2.1 schema V15：FTS5 索引

`schema.ts` 追加迁移，不改 `agent_memories` 本身：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_fts USING fts5(
  content, tags,
  content='agent_memories', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
```

用外部内容表（`content='agent_memories'`）而非独立存储，索引本身不持有数据，符合"索引可重建、数据不丢"的原则（借鉴 wiki0）。

同步用触发器维护，而不是应用层手动双写（避免遗漏路径）：

```sql
CREATE TRIGGER IF NOT EXISTS agent_memories_ai AFTER INSERT ON agent_memories BEGIN
  INSERT INTO agent_memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS agent_memories_ad AFTER DELETE ON agent_memories BEGIN
  INSERT INTO agent_memories_fts(agent_memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS agent_memories_au AFTER UPDATE ON agent_memories BEGIN
  INSERT INTO agent_memories_fts(agent_memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
  INSERT INTO agent_memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
```

迁移脚本需要一次性把已有数据灌入 FTS 表（`INSERT INTO agent_memories_fts(rowid, content, tags) SELECT rowid, content, tags FROM agent_memories;`），否则历史记忆搜不到。

**中文分词风险（必须先实测，不能假设）**：`unicode61` 对中文是按字符切分，不是真正分词，中文短语搜索的召回可能不如预期。落地前用现有真实记忆样本跑一次 `MATCH` 查询手工检查效果；如果太差，退路是 `content LIKE` 与 FTS5 并行、取并集，而不是引入 jieba 之类的分词依赖（YAGNI：先用最简单的方案验证问题是否真实存在）。

### 2.2 `memory-repo.ts` 的 `search()` 改造

```typescript
search(query: string, options): MemoryRow[] {
  const ftsQuery = escapeFtsQuery(query); // 转义 FTS5 特殊字符，防止语法错误
  return db.prepare(`
    SELECT m.* FROM agent_memories m
    JOIN agent_memories_fts f ON f.rowid = m.rowid
    WHERE f MATCH ? AND m.agent_id = ? AND m.user_id = ? AND m.is_archived = 0
    ORDER BY bm25(agent_memories_fts) LIMIT ?
  `).all(ftsQuery, agentId, userId, limit);
}
```

FTS5 查询语法对用户输入是"部分受信"的——特殊字符（`"`, `*`, `-` 开头等）会导致 MATCH 语法错误而不是安全问题，但仍需转义/包裹成 `"..."` 短语查询防止报错。

### 2.3 显式重建入口

```typescript
export function rebuildMemoryIndex(db: DatabaseSync): void {
  db.exec(`DELETE FROM agent_memories_fts;`);
  db.exec(`INSERT INTO agent_memories_fts(rowid, content, tags) SELECT rowid, content, tags FROM agent_memories;`);
}
```

挂到已有的 `agent:memories:*` 命令族下新增一个 `agent:memories:rebuildIndex`（复用链路 B 的既有通道命名与白名单机制，不新开链路）。UI 侧在 MemoriesPage 的 AI 记忆 Tab 加一个"重建索引"按钮即可，不需要自动触发——重建只在索引怀疑损坏时才有意义，自动定时重建是没有问题去解决的问题（YAGNI）。

### 2.4 清理死代码

删除 `api:getMemories`/`api:createMemory`/`api:updateMemory`/`api:deleteMemory` 四个通道：`preload/api/api-server-http-api.ts` 对应行、`preload/index.ts:538-556` 类型声明。确认过 renderer 无引用后直接删，不做兼容层——没有调用方的死代码不需要过渡期。

### 2.5 MVP 范围外（明确不做）

- 不改 `agent_memories` 表结构
- 不动提取/注入三条路径（规则/LLM/段落总结）
- 不做向量检索
- 不做矛盾检测
- 不做双时态

---

## 3. 扩展功能

### 3.1 供 user/feedback 类的软退役（supersede）

现状 `is_archived` 是唯一的"失效"信号，语义是"归档"不是"被新事实取代"。当用户说"我搬到北京了"而库里有"我住在上海"，需要能标记旧记忆已被取代而不是简单覆盖或留着造成矛盾注入。

最小实现：加一列 `superseded_by TEXT REFERENCES agent_memories(id)`，写入新记忆时如果 LLM/规则提取判断是对同类信息的更新（复用现有 `merge.ts` 的 `normalizeKey` 做同 key 检测），走：

```sql
UPDATE agent_memories SET superseded_by = ?, is_archived = 1 WHERE id = ?;
```

查询路径天然排除 `is_archived=1`，不需要额外改检索逻辑。这是对现有 `merge.ts` 去重逻辑的直接扩展，不是新建一套机制。

**不做的部分**：不引入 `valid_from/valid_to` 双时态区间——现有场景是"新事实取代旧事实"的单向替换，双时态解决的是"某事实在特定时间段成立"的时间点查询问题，Lumii 当前没有这类查询需求，加了就是过度设计。

### 3.2 矛盾检测——评估后仍不建议做

调研中的 LLM-free 否定词扫描方案是为英文设计的，中文否定语义（"不是"、"没有"、"并非" vs 双重否定、语气弱化）规则化成本高、误报率难控制。这类检测的价值只在记忆量大、用户不会逐条核对时才体现；Lumii 当前记忆规模和用户交互方式（用户能在 MemoriesPage 直接看到、编辑每条记忆）已经提供了人工纠错通道。**结论：不做，除非未来记忆规模明显增长到用户无法人工核对的程度。**

### 3.3 本地向量检索（可选，独立于 MVP）

前提条件都已明确：
- 不能复用 MemPalace（已核实）
- 需要引入 Transformers.js + 一个多语言 embedding 模型（如 `multilingual-e5-small`，384 维，量化后约 30MB）
- 向量存储可以用 sqlite-vec，也可以先用简单的内存线性扫描（记忆条目量级通常是几百到几千条，暴力余弦相似度在这个量级下足够快，不需要引入向量索引库）

**建议顺序**：先只用 FTS5（MVP 已做），观察一段时间检索质量。如果用户反馈"搜不到语义相关但用词不同的记忆"，再评估引入向量层的成本收益。向量层必须可关闭（复用调研中"MEMORY_EMBED_DISABLED"式的开关设计），降级到纯 FTS5 时用户要能感知到（UI 提示，不是静默降级）。

RRF 融合公式（届时如果做）：`score = Σ 1/(60 + rank_i)`，k=60 是社区通用值，直接抄，不需要自己调参。

---

## 4. 迁移与实施要点

- schema V15 只需两步：`schema.ts:9` 的 `SCHEMA_VERSION` 改为 15；`MIGRATIONS` 数组末尾追加 `[15, 'CREATE VIRTUAL TABLE ... ; CREATE TRIGGER ... ; ...']`（多语句分号分隔，`db.exec` 支持，照抄 V14 的追加形式）
- 历史数据回填 FTS 表必须在同一条迁移 SQL 里做，不能指望用户手动点"重建索引"
- 触发器命名遵循 `<table>_<ai|ad|au>` 惯例（insert/delete/update after），SQLite 社区通用写法
- 涉及 IPC 的部分（重建索引按钮）：main handler（`agent-commands.ts`）+ preload 类型（`preload/index.ts`）+ renderer 调用方（`useMemoryUsage.ts`）三处同步更新，遵循 AGENTS.md 第 5 条

---

## 5. 与 Wiki 的边界

参见 [2026-08-24-wiki-design.md](./2026-08-24-wiki-design.md) 第 5 节。简述：`agent_memories` 是"AI 对用户的画像"，Wiki 是"用户主动沉淀的知识"，两者数据模型和生命周期独立，MVP 阶段不打通、不回写。
