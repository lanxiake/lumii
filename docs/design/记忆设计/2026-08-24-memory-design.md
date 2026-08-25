# Lumii 记忆系统设计（方案 A+：语义类别 × 生命周期温度）

> 日期：2026-08-24
> 输入：`docs/design/记忆设计/` 下的调研报告（1 份主报告 + 11 份参考项目拆解）
> 范围：本文只覆盖**记忆**。Wiki 知识库见 `2026-08-24-wiki-design.md`。
> 定位：完整设计，按 **P0 / P1 / P2** 优先级分批落地，不再区分 MVP。

---

## 1. 设计定位

### 1.1 记忆要解决的问题

Agent 每次对话都从零开始，用户必须反复交代同样的事：自己是谁、偏好什么、当前在做什么项目、
上次的结论是什么。记忆系统的职责是把这些跨会话有效的信息**自动沉淀、按需召回、精准注入**，
让 Agent 表现得像"记得你"，而不是每次重新认识你。

### 1.2 两类记忆的本质差异

用户视角有两种截然不同的记忆：

| | 稳定记忆 | 动态记忆 |
|---|---|---|
| 例子 | 名字、性别、地区、职业、说话偏好 | 当前任务、上个任务的结论、下一步计划 |
| 变化频率 | 几乎不变（月/年级别） | 高频（小时/天级别） |
| 作用范围 | 全局，所有 Agent 通用 | 与具体 Agent / 项目绑定 |
| 过期方式 | 基本不过期，只被修正 | 任务结束即失效，需归档 |
| 注入策略 | 始终注入，不做相关性过滤 | 按相关性 + 温度择优注入 |
| 存储形态 | Markdown 全文（人可读可编辑） | SQLite 结构化行（可打分排序） |

这两类的**存储形态、注入策略、过期逻辑都不同**，因此必须分开设计，不能用一套逻辑硬套。

### 1.3 本设计采用的方案：A+

调研阶段对比过两条路线：

- **方案 A**：保留现有 5 个语义类别，另加一个**正交的生命周期温度维度**
- **方案 B**：把语义与生命周期合并成一个轴（stable / dynamic 两类）

**结论：采用方案 A+**（A 加上对 `general` 语义的收紧与显式 `scope` 字段）。

理由：
1. **语义 ≠ 生命周期**，二者是两个独立的轴。`reference` 类既可能是永久的（常用工具文档链接），
   也可能是临时的（本次任务的一个 URL）。B 方案把两轴压成一轴，必然丢失这种区分能力。
2. **温度是计算属性，不是写入决策**。温度由 `last_used` / `use_count` / `importance` 推导，
   公式可以随时调整并立即对全量历史数据生效；而 B 方案的 stable/dynamic 是 LLM 写入时的一次性判断，
   判错了就固化，只能重新提取。
3. **零迁移成本**。B 方案要变更 `agent_memories.category` 的 CHECK 约束，SQLite 无法 ALTER CHECK，
   必须走"建新表 → 拷数据 → 删旧表 → 改名"，而项目的 `migrate()` 无回滚机制，
   迁移中途失败会损坏用户数据库。A+ 不需要动 CHECK。
4. **表达能力更强**。5 类语义 × 3 档温度 = 15 种状态，比 2 类更精细。

### 1.4 设计原则

1. **真相表 + 可重建派生索引**。`agent_memories` 与 `user-memory.md` 是唯一真相；
   FTS5 索引、温度分档、统计视图全部是**派生物**，可以整体删掉重建。
   后续每加一种检索能力（向量、图谱），就加一张派生表 + 一个 rebuild 函数，**永不改动真相表结构**。
2. **纯函数优先**。打分、温度、token 估算、去重键全部做成不依赖 `db` 的纯函数，
   `now` 显式传入，保证单元测试不随墙钟漂移。
3. **正交维度不互相编码**。`category` 只表达"这是什么类型的知识"；
   温度只表达"它还活着吗"；`scope` 只表达"它在多大范围内有效"。三者互不重叠。
4. **AI 不静默覆写用户内容**。个人记忆的整理必须产出完整文档并可预览，
   删除类操作走 `remove_section` 而不是全量 overwrite。
5. **不做过度设计**。语义向量、知识图谱、多跳推理留在 P2，且前置条件是先建好中文评测集，
   否则无法判断新方案是否真的比 BM25 更好。

---

## 2. 整体架构

### 2.1 三层存储

```
┌─────────────────────────────────────────────────────────────┐
│ 个人记忆层（Personal）—— 稳定记忆                            │
│ 存储：~/.lumii/data/user-memory.md（单文件 Markdown 全文）   │
│ 类别：user（身份画像）、feedback（交互偏好）                  │
│ 特点：跨 Agent 全局、人可直接编辑、LLM 整理去重合并           │
│ 注入：静态 prompt 段，按 `## ` 章节边界做预算截断             │
│ 写入：profile_memory 工具（append / remove_section / update） │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ 工作记忆层（Work）—— 动态记忆                                │
│ 存储：SQLite agent_memories（按 agent_id + user_id 隔离）     │
│ 类别：project（进行中的事）、reference（外部资源）、general    │
│ 特点：结构化可打分、有温度分档、任务结束可归档                 │
│ 注入：动态 prompt 段，热记忆择优注入（打分 + 门控 + 预算）      │
│ 写入：段落总结管线自动提取 → 去重合并 → 落库                  │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ 记忆宫殿层（Palace）—— 冷归档                                │
│ 存储：MemPalace（外部 Python MCP 进程，chromadb 向量库）      │
│ 内容：对话段落原文，按 Wing → Room → Drawer 结构化            │
│ 特点：海量、语义检索、不进 prompt，仅按需召回                  │
│ 互引：drawer_id ↔ agent_memories.palace_drawer_id 双向        │
└─────────────────────────────────────────────────────────────┘
```

三层不是包含关系，而是**按变化频率与召回方式分工**：越往上越稳定越常驻 prompt，
越往下越海量越依赖主动搜索。

### 2.2 新增的第四个维度：温度

温度**不是第四层存储**，而是叠加在工作记忆层上的一个计算属性：

```
        importance 高
             ↑
    ┌────────┼────────┐
    │  hot   │  hot   │   hot  → 优先注入，不做相关性门控
    ├────────┼────────┤   warm → 注入前需过相关性门控
    │  warm  │  warm  │   cold → 不注入，仅显式搜索时返回
    ├────────┼────────┤
    │  cold  │  warm  │
    └────────┴────────┘
   久未使用 ←→ 最近使用
```

温度的价值在于：**用一个派生属性同时解决了"注入太多噪音"和"归档没有依据"两个问题**。
它不需要存储，不需要迁移，公式改了立刻对全量数据生效。

### 2.3 类别 × 温度 的组合语义

| 类别 | 默认温度倾向 | 说明 |
|------|------------|------|
| `user` | 恒定 hot | 个人记忆层，不参与温度计算，始终注入 |
| `feedback` | 恒定 hot | 同上。交互偏好必须每次生效，否则用户要反复纠正 |
| `project` | hot → warm → cold 快速衰减 | 任务性质，7 天未用降 warm，30 天降 cold |
| `reference` | 高 importance 常驻 hot | 常用工具文档不该因为几天没用就消失 |
| `general` | 缓慢衰减 | 经验教训类，不常用但用到时很关键 |

---

## 3. 数据模型

### 3.1 真相表：`agent_memories`（现状，P0 不改结构）

```sql
CREATE TABLE agent_memories (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL,           -- 作用域：哪个 Agent
  user_id           TEXT NOT NULL,           -- 作用域：哪个用户
  category          TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('user','feedback','project','reference','general')),
  content           TEXT NOT NULL,           -- 记忆正文（一条一个事实）
  importance        REAL NOT NULL DEFAULT 0.5
    CHECK (importance >= 0.0 AND importance <= 1.0),
  tags              TEXT,                    -- JSON 数组字符串
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  source_segment_id TEXT,                    -- 溯源锚点：来自哪个对话段
  palace_drawer_id  TEXT,                    -- 宫殿互引
  created_at        TEXT NOT NULL,
  last_used         TEXT NOT NULL,           -- 温度计算输入
  use_count         INTEGER NOT NULL DEFAULT 0,
  is_archived       INTEGER NOT NULL DEFAULT 0
);
```

现有索引（`schema.ts:84-93`）：

```sql
CREATE INDEX idx_memories_agent_user_active
  ON agent_memories (agent_id, user_id, is_archived, importance DESC);
CREATE INDEX idx_memories_category
  ON agent_memories (agent_id, user_id, category) WHERE is_archived = 0;
CREATE INDEX idx_memories_last_used
  ON agent_memories (agent_id, user_id, last_used ASC) WHERE is_archived = 0;
```

**字段完备性核对**：`importance` ✅、`tags` ✅、`last_used` ✅、`use_count` ✅、
`is_archived` ✅、`source_segment_id` ✅ —— 需求中列出的字段现已全部存在，P0 无需加列。

### 3.2 派生索引：`agent_memories_fts`（P0 新增）

当前 `AgentMemoryRepo.search()`（`memory-repo.ts:317`）用的是 `content LIKE '%kw%'`，
无分词、无排序、无高亮，中文长查询基本召回不到。P0 引入 FTS5 作为**可重建派生索引**：

```sql
CREATE VIRTUAL TABLE agent_memories_fts USING fts5(
  content,
  tags,
  content='agent_memories',      -- external content：不复制正文，省一倍空间
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- 增删改三个同步触发器
CREATE TRIGGER agent_memories_ai AFTER INSERT ON agent_memories BEGIN
  INSERT INTO agent_memories_fts(rowid, content, tags)
  VALUES (new.rowid, new.content, new.tags);
END;

CREATE TRIGGER agent_memories_ad AFTER DELETE ON agent_memories BEGIN
  INSERT INTO agent_memories_fts(agent_memories_fts, rowid, content, tags)
  VALUES ('delete', old.rowid, old.content, old.tags);
END;

CREATE TRIGGER agent_memories_au AFTER UPDATE ON agent_memories BEGIN
  INSERT INTO agent_memories_fts(agent_memories_fts, rowid, content, tags)
  VALUES ('delete', old.rowid, old.content, old.tags);
  INSERT INTO agent_memories_fts(rowid, content, tags)
  VALUES (new.rowid, new.content, new.tags);
END;
```

**中文分词的现实约束**：`unicode61` 不做中文分词，对 CJK 是按字切分。
效果上等于 unigram 索引：查"爬山"能命中"喜欢爬山"，但也会命中"山上爬行"这类误配。
这比 `LIKE` 好（有 BM25 排序、有 `snippet()` 高亮、有多词 AND/OR），但不是完美方案。
**落地时必须用真实中文记忆做召回实测**，若误配率不可接受，退路是 P1 引入 bigram 自定义分词
（`tokenize='trigram'` 是另一个可选项，但索引体积明显更大）。

### 3.3 个人记忆：`user-memory.md`

不进数据库，就是一个 Markdown 文件（`~/.lumii/data/user-memory.md`，
读写实现在 `apps/windows/src/main/index.ts:654` / `:732`）。

选择文件而非表的理由：

1. **人可直接编辑**。用户想改自己的画像，用任何编辑器打开改一行即可，不需要 UI。
2. **LLM 整理的天然载体**。整理任务的输入输出都是完整文档，
   Markdown 的 `## ` 章节结构正好给 LLM 提供了组织框架。
3. **不需要打分排序**。个人记忆本来就全量注入，不存在 top-K 择优的需求，
   拆成行反而要额外拼装。

约定的文档结构：

```markdown
## 身份与背景
- 姓名：李明
- 职业：高中数学老师
- 坐标：成都

## 交互偏好
- 规则：回复要简洁。原因：用户多次要求精简。应用：所有回复。适用范围：全局
- 规则：生成图片必须调用 image_generate。原因：用户纠正过编造链接。应用：生图任务。适用范围：全局

## 长期习惯
- 每周日晚整理下周计划
```

**注入预算**（`bridge-prompt-composer.ts:407`）：`USER_MEMORY_MAX_CHARS = 2400`（约 1200 token）。
超预算时按 `## ` 章节边界截断，并在末尾附一句提示，让模型知道可以用
`profile_memory` 的 `read_memory` 读完整文档。这是必要的防护：个人记忆文档会长到几十 KB，
整篇注入会淹没当前任务，诱发"口嗨已完成"的幻觉。

> **文档一致性修正（P0）**：`memory-architecture.ts:27` 目前把个人记忆的存储写成
> `"PostgreSQL user_memory（Markdown 全文）"`，与实际实现（本地文件）不符。
> 这段字符串会通过 `buildMemoryArchitectureSection()` 进入提取提示词，
> 属于**直接喂给 LLM 的错误事实**，必须改为本地文件描述。

### 3.4 派生视图：温度（P0，纯计算不落表）

温度不建表、不加列，只在读取时计算：

| 温度 | 判定 | 检索行为 |
|------|------|---------|
| `hot` | 个人类；或 7 天内使用过；或 `importance >= 0.8` | 优先注入，跳过相关性门控 |
| `warm` | 7~30 天未用，且 `importance >= 0.4` | 注入前须过相关性门控 |
| `cold` | 超 30 天未用，或 `importance < 0.4` 且 7 天未用 | 不参与注入，仅显式搜索可见 |

阈值（7 / 30 天、0.8 / 0.4）是初始经验值，收进配置对象供调参，不散落在代码里。

### 3.5 P1 新增列：`scope`

解决 `reference` 类的语义冲突——"常用工具文档链接"（全局永久）和"本次任务的一个 URL"
（任务级临时）现在都是 `reference`，温度公式无法区分二者。

```sql
-- P1 migration（schema version 15 → 16）
ALTER TABLE agent_memories ADD COLUMN scope TEXT;
-- 取值：'session' | 'project' | 'agent' | 'global'；NULL 表示未标注，按 category 默认推断
CREATE INDEX idx_memories_scope ON agent_memories (agent_id, user_id, scope)
  WHERE is_archived = 0;
```

设计要点：
- **可空**。历史数据不需要回填，NULL 走 `category` 默认推断（`project`→`project`，
  `user`/`feedback`→`global`，其余→`agent`）。
- **正交**。不改 `category`，不改 CHECK 约束，纯 ADD COLUMN，
  可复用 `isMigrationAlreadyApplied(version)` 保证幂等。
- **LLM 选填**。提取提示里标为可选字段，模型不确定就留空，不强迫它猜。

`scope` 的作用：`session` 级记忆在会话结束时自动归档；`global` 级记忆不受温度衰减影响。

---

## 4. 核心流程

### 4.1 提取：对话 → 候选记忆

```
AgentInstance.observe(turn)
        ↓
SegmentTracker          按边界规则切段（user 问 + assistant 答 = 一段）
        ↓  段关闭
SummarizationQueue      入队，串行消费，失败重试（maxRetry）
        ↓
回读段落原文             segmentRepo → conversationRepo.loadSegmentText(start..end)
        ↓
buildSegmentSummaryPrompt + callLLM（basic tier，由宿主选模型）
        ↓
parseCandidatesJson     解析出 ExtractedCandidate[]
        ↓
      分流
   ┌────┴─────────────────────────┐
   ↓                              ↓
user / feedback              project / reference / general
   ↓                              ↓
个人记忆整理管线              MemoryManager.saveCandidate
（见 4.5）                        ↓
                              merge.ts 去重 → memory-repo 落库
                                  ↓
                              段原文归档进宫殿（archivePalace）
                                  ↓
                              回填 palace_drawer_id
```

关键设计（沿用现状）：
- **管线与模型无关**。只依赖注入的 `callLLM`，宿主决定用哪个模型。
- **灰度开关**。宿主 `enabled=false` 时不创建管线，完全走旧逻辑。
- **内容寻址 drawer_id**。`deterministicDrawerId = sha256(wing + room + content)`，
  同一段重复归档幂等。**wing/room 由 runtime 计算并传出，宿主不得自行重算**，
  否则 id 与存储位置错位，幂等失效。

### 4.2 去重合并：写入前的收敛

现状（`merge.ts:30-33`）：

```typescript
export function normalizeKey(category: MemoryCategory, content: string): string {
  const norm = content.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  return `${category}::${norm}`;
}
```

`mergeCandidates` 返回 `{ toInsert, toUpdate }`：命中同键则 tags 取并集、importance 取最大值。

**能力边界要说清楚**：这是**字符串级**去重，只能消除完全/近似相同的表述。
"我喜欢爬山" vs "用户爱好是爬山" 归一化后不同键，会存成两条。
`merge.ts` 的文件注释本身就坦承了这一点。

分层应对：
- **P0**：接受这个边界。工作记忆走字符串去重，个人记忆走 LLM 整理（LLM 天然能做语义合并）。
- **P1**：在 `MemoriesPage` 提供"查重"入口，把疑似重复项并排列出，由用户点击合并。
  规则用 FTS5 找高分相似对，不引入向量。
- **P2**：向量语义去重，前置条件见 §8.3。

### 4.3 检索：候选池 → 打分 → 门控 → 预算

`AgentMemoryRepo.loadTopMemories()`（`memory-repo.ts:49-134`）的五步流水线：

**① 取候选池**

```sql
SELECT * FROM agent_memories
WHERE agent_id = ? AND user_id = ? AND is_archived = 0
ORDER BY importance DESC
LIMIT ?   -- useRelevance ? max(maxItems*2.5, 200) : max(maxItems*2.5, 50)
```

带查询上下文时池子放大到 200，因为高相关但 importance 中等的记忆需要机会进入排序。

**② 打分**（P0 抽成纯函数）

```typescript
// packages/agent-runtime/src/memory/scorer.ts —— 纯函数，无 db 依赖
export interface MemoryScoreInput {
  readonly importance: number;
  readonly category: MemoryCategory;
  readonly lastUsedAt: number;   // unix ms
  readonly now: number;          // 显式注入，测试可固定，不随墙钟漂移
  readonly relevance: number;    // 0..1，由 overlap 系数算得
}

export function scoreMemory(
  input: MemoryScoreInput,
  cfg: HotMemoryConfig = DEFAULT_HOT_MEMORY_CONFIG,
): number {
  const daysSinceUse = (input.now - input.lastUsedAt) / 86_400_000;
  const recencyBonus = cfg.recencyWeight * Math.max(0, 1 - daysSinceUse / cfg.recencyHalfLifeDays);
  return input.importance * cfg.categoryWeights[input.category]
    + recencyBonus
    + cfg.relevanceBonus * input.relevance;
}
```

配置对象（`types.ts:77-93`）：

```typescript
export interface HotMemoryConfig {
  readonly maxItems: number;                          // 最终返回条数上限
  readonly maxTokenBudget: number;                    // token 天花板
  readonly categoryWeights: Record<MemoryCategory, number>;
  readonly relevanceBonus: number;
  readonly recencyWeight: number;                     // P0 新增
  readonly recencyHalfLifeDays: number;               // P0 新增，原 30 天改为可配置
  readonly minQueryTokens: number;
  readonly gateContextualByRelevance: boolean;
}
```

现状（`memory-repo.ts:76-85`）：打分逻辑直接写在 `loadTopMemories` 方法体里，
与 SQL 查询、相关性计算、去重、预算截断揉在一起，**一个方法 85 行，混了 6 件事**。
P0 的改进就是抽出 `scoreMemory` 纯函数，单独测试，不夹带 `db` 依赖。

**③ 相关性门控**（`memory-repo.ts:90-96`）

```typescript
if (
  cfg.gateContextualByRelevance &&
  !isPersonalCategory(row.category) &&
  overlap < 0.15
) {
  continue;  // 过滤
}
```

个人记忆（`user` / `feedback`）不做门控，因为它们是"Agent 的底层人设与规则"，
跟当前问题无关也要遵守。工作记忆若相关性太低，注入了也是噪音。

**④ 内容去重**（`memory-repo.ts:100-107`）

```typescript
const contentLower = row.content.trim().toLowerCase();
if (seenContent.has(contentLower)) continue;
seenContent.add(contentLower);
```

同一正文出现多次（比如同一个 source 提取出好几条，归一化键不同但正文相同），只保留分最高的那条。

**⑤ token 预算截断**（`memory-repo.ts:109-118`）

```typescript
const estTokens = estimateTokens(row.content);
if (tokenBudget > 0 && accTokens + estTokens > tokenBudget) break;
accTokens += estTokens;
```

`estimateTokens()`（`memory-repo.ts:13-21`）：中文字符（charCode > 0x2e80）约 2 字符 = 1 token，
拉丁字符约 4 字符 = 1 token。这是粗估，误差 ±20%，但够用。精确计算需调 tokenizer，
对记忆注入这种非关键路径不值得。

**⑥ 副作用：更新召回统计**（`memory-repo.ts:120-131`）

批量 UPDATE 被召回记忆的 `last_used = now, use_count = use_count + 1`。
这个副作用是温度计算的输入，也是未来分析"哪些记忆从未被用"的依据。

> 用 `withTransaction` 包裹批量更新，避免 N 条记忆产生 N 次 fsync。

### 4.4 注入：结构化块 + 占位符渲染

**现状的问题**（`memory-injector.ts:170-191`）：

```typescript
export function injectMemories(systemPrompt: string, memories: readonly MemoryEntry[]): string {
  if (memories.length === 0) return systemPrompt;
  const memoriesSection = formatMemoriesForPrompt(memories);
  // 兼容旧标题 "## 你的记忆" 和新标题 "## 工作记忆"
  const sectionStart = systemPrompt.indexOf("## 工作记忆");
  const legacyStart = systemPrompt.indexOf("## 你的记忆");
  const start = sectionStart !== -1 ? sectionStart : legacyStart;
  if (start !== -1) {
    const nextSection = systemPrompt.indexOf("\n## ", start + 1);
    const sectionEnd = nextSection !== -1 ? nextSection : systemPrompt.length;
    return systemPrompt.slice(0, start).trimEnd() + memoriesSection + systemPrompt.slice(sectionEnd);
  }
  return systemPrompt.trimEnd() + "\n" + memoriesSection;
}
```

这是**在字符串上做手术**：靠 `indexOf` 找中文标题定位，再切片拼接。缺陷有三：

1. **静默失效**。谁改了 prompt 模板里的标题文字（哪怕只是加个空格），
   定位失败就落到"末尾追加"分支，记忆跑到 prompt 最后，位置语义全乱，但没有任何报错。
2. **兼容包袱只会累积**。已经有两个历史标题要兼容了，下次改标题就是第三个 `indexOf`。
3. **不可测**。测试只能断言"输出里包含记忆内容"，无法断言"记忆插在了正确的位置"。

**P0 的改法**：把注入点变成模板里的**显式占位符**，注入退化为字符串替换。

```typescript
export const MEMORY_PLACEHOLDER = "{{LUMII_MEMORY_BLOCK}}";

export function injectMemories(
  systemPrompt: string,
  memories: readonly MemoryEntry[],
): string {
  const block = memories.length > 0 ? formatUnifiedMemoryBlock(memories) : "";

  if (systemPrompt.includes(MEMORY_PLACEHOLDER)) {
    return systemPrompt.replace(MEMORY_PLACEHOLDER, block);
  }

  // 模板未声明占位符：这是装配错误，不是正常降级路径
  if (process.env.NODE_ENV !== "production") {
    throw new Error(
      `[injectMemories] system prompt 缺少 ${MEMORY_PLACEHOLDER} 占位符，请检查模板装配`,
    );
  }
  logger.warn(`[injectMemories] 占位符缺失，降级为末尾追加`);
  return block ? `${systemPrompt.trimEnd()}\n\n${block}` : systemPrompt;
}
```

要点：
- **开发期抛错，生产期降级并告警**。装配错误必须在开发阶段就暴露，不能静默漂移。
- **删掉两个历史标题的 `indexOf` 兼容分支**。占位符是唯一契约。
- **可测**。测试直接断言替换结果，包括"占位符缺失时抛错"这个分支。

**注入块的格式**（`formatUnifiedMemoryBlock`，`memory-injector.ts:70-121`，已实现，保留）：

```markdown
## 记忆

（个人记忆 3 条 · 工作记忆 8 条 · 宫殿可搜索）

### 关于用户
- 用户叫李明，是一名高中数学老师，坐标成都
- 规则：回复要简洁。原因：用户多次要求精简。应用：所有回复。适用范围：全局

### 工作记忆
- K8s 小红书系列：深度长文 1200-1500 字，每篇封面 + 5-6 张图。状态：进行中
- 用户的 K8s 系列文章存放在 outputs/k8s-xhs-series/ 目录

### 使用原则
- 与当前任务无关的记忆不必强行套用
- 用户最新的明确陈述优先于历史记忆
```

三层摘要行（"个人记忆 3 条 · 工作记忆 8 条 · 宫殿可搜索"）是有意设计的：
它让模型知道**还有东西没注入**，可以用 `memory_search` 去捞，而不是以为看到的就是全部。

类别标签映射（`memory-injector.ts:16-22`）：
`user`→关于用户、`feedback`→交互偏好、`project`→进行中的事、
`reference`→外部资源、`general`→其他。

**个人记忆与工作记忆的注入位置不同**（`bridge-prompt-composer.ts:398`）：

```
staticPrompt（含个人记忆，走 prompt cache）
  + CACHE_BOUNDARY_MARKER
  + dynamicPrompt（含工作记忆 + 活跃任务 + 诊断采样）
```

个人记忆放静态段是因为它几乎不变，可以吃到 prompt cache 的折扣；
工作记忆每轮都可能变，必须放在缓存边界之后。**这个边界不能破**，
否则每轮对话的 prompt cache 全部失效，成本显著上升。

### 4.5 个人记忆整理：LLM 去重合并

触发时机有三类：

1. **有新候选**（`new_candidates`）：段落总结提取出 `user` / `feedback` 类候选
2. **无新候选但检出问题**（`needsPersonalMemoryConsolidation`，`memory-consolidation.ts:28-97`）：
   - `existing_duplicates`：同一规则主体重复出现 ≥2 次；同一项目主题重复 ≥3 次
   - `existing_conflicts`：检出互斥的工具/方法并存（如 `generate_image.py` 与 `image_generate`）
   - `existing_oversized`：列表项 ≥12 条且高度重复
3. **定时任务**（已实现，见 §4.9）：轻量整理 30 分钟一次、深度整理 6 小时一次

流程：

```
新候选（可空） + 现有 user-memory.md 全文
        ↓
buildConsolidationPrompt（含三层架构说明 + 冲突消解规则）
        ↓
callLLM → 输出整理后的完整 Markdown
        ↓
校验：非空、长度未异常缩水（防 LLM 截断导致内容丢失）
        ↓
writeUserMemoryFile 全量替换
```

关键原则（提示词里强制执行）：

- **语义去重**：同一主题只保留一条最完整的表述
- **冲突消解**：工具/方法变更时，只保留新方法，删旧的；用户明确纠正的规则保留，含糊的删
- **禁止泛化过度**："用户喜欢爬山和游泳" 不能泛化成"用户喜欢运动"
- **结构化格式**：feedback 类必须写成"规则：…… 原因：…… 应用：…… 适用范围：……"

这是**唯一一个允许 LLM 全量重写用户数据的地方**。需要的防护措施见 §7.3。

**冲突消解的实现方式**：不做规则引擎，而是 **LLM 语义理解 + 提示词约束**。

- ✅ LLM 读完整上下文，理解"用户现在用 React，Vue 那条可以删了"，这是语义理解
- ✅ 工具冲突（`.py` 脚本 vs 内置工具）可枚举、可检测，用启发式规则识别
- ❌ 不做关键词匹配式的硬编码规则（"包含否定词就删对应肯定句"在中文里假阳性必爆）

整理提示词里的冲突消解规则（`memory-consolidation.ts:142-146`）：

```
1. 最近用户明确陈述 > 历史记忆
2. 全局偏好 > 任务级规则
3. 工具/方法冲突：保留内置工具，删脚本方案
4. 场景互斥：不同项目规则可并存，但须分节标注范围
```

### 4.6 搜索：关键词 → FTS5 BM25 排序

替换 `memory-repo.ts:317-327` 的 `LIKE %kw%`：

```typescript
export function search(keyword: string, limit = 20): readonly MemoryEntry[] {
  const rows = this.db
    .prepare(
      `SELECT m.*, bm25(fts) AS rank
       FROM agent_memories_fts fts
       JOIN agent_memories m ON m.rowid = fts.rowid
       WHERE fts MATCH ? AND m.agent_id = ? AND m.user_id = ? AND m.is_archived = 0
       ORDER BY rank
       LIMIT ?`,
    )
    .all(keyword, this.agentId, this.userId, limit) as MemoryRow[];
  return rows.map(fromRow);
}
```

**MATCH 查询语法**：`keyword` 传入时需转义 FTS5 特殊字符（`" * ( ) AND OR NOT`），
或给用户提供高级模式（支持 `keyword1 AND keyword2`、`"exact phrase"`）。

**高亮片段**（P1）：`snippet(fts, 0, '[', ']', '…', 15)` 提取匹配上下文，
返回时附带高亮后的摘要，方便用户判断是否要展开全文。

### 4.7 归档与恢复

**归档**（`memory-repo.ts:276` / `:283` / `:304`）：

```typescript
archiveById(memoryId: string): void {
  this.db.prepare("UPDATE agent_memories SET is_archived = 1 WHERE id = ?").run(memoryId);
}

archiveLowImportance(threshold: number): number {
  const result = this.db
    .prepare(
      `UPDATE agent_memories SET is_archived = 1
       WHERE agent_id = ? AND user_id = ? AND is_archived = 0 AND importance < ?`,
    )
    .run(this.agentId, this.userId, threshold);
  return result.changes;
}
```

P0 新增：按温度归档。

```typescript
archiveCold(now: number = Date.now()): number {
  const coldThresholdMs = now - 30 * 86_400_000;  // 30 天前
  const result = this.db
    .prepare(
      `UPDATE agent_memories SET is_archived = 1
       WHERE agent_id = ? AND user_id = ? AND is_archived = 0
         AND last_used < ?
         AND category NOT IN ('user', 'feedback')`,  -- 个人记忆不受温度影响
    )
    .run(this.agentId, this.userId, new Date(coldThresholdMs).toISOString());
  return result.changes;
}
```

**归档不是删除**。`is_archived = 1` 的记忆仍在库里，不参与注入，
但显式搜索时可以带 `includeArchived` 标志找回。这符合"退而不删"原则。

**真删除**（`removeById`，`memory-repo.ts:358+`）：同时删掉正文相同的重复行，
避免删了一条之后另一条又被召回，用户误以为"删不掉"。

### 4.8 溯源：记忆 → 对话原文

已完整实现的链路（**不要重新发明**）：

```
MemoriesPage / MemoryViewer 点击"查看来源"
        ↓ IPC: agent:memories:provenance
main/ipc/agent-runtime/agent-commands.ts:105
        ↓
MemoryManager.getProvenance(memoryId)     manager.ts:342-390
        ↓
读 agent_memories.source_segment_id
        ↓
segmentRepo.findById(segmentId) → { start_message_id, end_message_id }
        ↓
conversationRepo 回读该区间的消息原文
        ↓
返回 { memory, segment, messages, palaceDrawerId }
```

涉及文件：`shared/agent-runtime-commands.ts:301` / `:1064`、
`main/ipc/agent-runtime-ipc.ts:868`、`main/app-ui-control/command-allowlist.ts:29`、
`renderer/hooks/business/useMemoryUsage/useMemoryUsage.ts:22` / `:136`、
`renderer/pages/SettingsPage/components/MemoryViewer/MemoryViewer.tsx:283-302`。
测试：`packages/agent-runtime/src/__tests__/memory-provenance.test.ts`。

来源回填策略（`memory-repo.ts:219-250`）：命中已有记忆时，
仅当旧记忆的 `source_segment_id IS NULL` 才回填，即**最早证据胜出**。
理由：第一次说出这件事的那段对话，才是这条记忆真正的出处。

### 4.9 定时记忆整理（已实现，P0 补强防护）

**这是已经在运行的能力**，不是新设计。实现在 `local-companion-handler.ts`，
通过 companion cron job 种子注册（`:423-441`），默认全部开启，
用户可在定时任务页自行关闭（启动时不覆盖用户的开关状态）。

| Job | 指令 | 频率 | 行为 |
|-----|------|------|------|
| `companion-memory-fast` | `__companion_memory_fast__` | `*/30 * * * *` | 先本地体检，检出重复/冲突/超长才调 LLM |
| `companion-memory-deep` | `__companion_memory_deep__` | `0 */6 * * *` | 无条件重写一遍全文 |

**轻量整理（fast）为什么是好设计**：

```typescript
// local-companion-handler.ts:258
if (depth === 'fast' && !needsPersonalMemoryConsolidation(existing).needed) {
  return 'skipped: 记忆无重复或冲突，跳过整理'
}
```

先用纯本地启发式做体检，没查出问题就直接跳过——半小时一次的任务不该每次都烧一次模型调用。
30 分钟的频率也不会打断用户当前的对话节奏。

**深度整理（deep）的价值**：捞 fast 那套启发式**查不出来的隐式过时**。

举例：用户半年前说"我喜欢用 Vue"，现在已全面转 React，但从没明确说过"别用 Vue 了"。
`needsPersonalMemoryConsolidation` 检测不到这种冲突（没有互斥关键词对、没有重复规则），
只有让 LLM 全局审视一遍才能识别"这条已经不成立了"。这是深度整理无法被 fast 替代的原因。

**现有防护的缺口**（P0 必须补）：

`consolidateUserMemory`（`memory-consolidation.ts:196-222`）目前只检查了三件事：

```typescript
if (!cleaned || cleaned.length < 10) { /* 拒绝 */ }        // 输出太短
if (cleaned.length > maxLength) { /* 拒绝 */ }              // 输出太长
if (cleaned === existingContent.trim()) { /* 无变化 */ }    // 没改动
```

**缺少"缩水过半"检测**：LLM 把 6000 字的文档整理成 500 字（remove 了大量内容但仍 > 10 字符），
当前会**直接通过并写入**。深度整理每 6 小时执行一次，累积风险不可接受。

补充校验：

```typescript
// memory-consolidation.ts:217 返回前插入
if (existingContent.trim().length > 200 && cleaned.length < existingContent.trim().length * 0.5) {
  // 200 字以下的短文档整理时缩水比例波动大，不做此校验
  return { content: existingContent, merged: false };  // 拒绝写入，保持原样
}
```

**缺少写入前备份**：

```typescript
// local-companion-handler.ts:285 updateUserMemory 之前
await backupUserMemory(existing);   // 写 user-memory.md.bak，只留最近一份
await updateUserMemory(result.content);
```

**缺少用户可见性**（P1）：定时任务静默改了记忆，用户不知道改了什么。
- 整理产生实质变化后，桌宠主动通知一句"整理了记忆，精简了 N 字"
- MemoriesPage 显示"最近一次整理"时间 + diff 查看入口

---

## 5. 模块划分与接口

### 5.1 目录结构

```
packages/agent-runtime/src/memory/
├── types.ts                    # MemoryCategory / MemoryEntry / HotMemoryConfig
├── memory-architecture.ts      # 三层架构定义（供提示词复用）
├── scorer.ts                   # ★P0 新增：打分纯函数
├── temperature.ts              # ★P0 新增：温度计算纯函数
├── memory-repo.ts              # SQLite 读写（真相表 + FTS 查询）
├── memory-index.ts             # ★P0 新增：FTS 索引重建
├── merge.ts                    # 字符串级去重合并
├── manager.ts                  # 编排：saveCandidate / getProvenance
├── memory-extractor.ts         # 提取提示词构建 + 候选解析
├── memory-injector.ts          # 格式化 + 占位符注入
├── memory-consolidation.ts     # 个人记忆 LLM 整理
├── segmentation.ts             # 对话分段边界规则
├── segment-tracker.ts          # 段状态机
├── summarization-queue.ts      # 总结任务队列
├── segment-memory-pipeline.ts  # 管线装配
├── content-address.ts          # 内容寻址 drawer_id
└── __tests__/
```

模块边界遵循 `AGENTS.md`：通用记忆逻辑在 `packages/agent-runtime`，
Electron 专属（文件读写、MemPalace 进程、IPC）在 `apps/windows/src/main`。

### 5.2 核心接口

#### `scorer.ts`（P0 新增）

```typescript
export interface MemoryScoreInput {
  readonly importance: number;
  readonly category: MemoryCategory;
  readonly lastUsedAt: number;
  readonly now: number;
  readonly relevance: number;
}

export function scoreMemory(
  input: MemoryScoreInput,
  cfg: HotMemoryConfig,
): number;
```

#### `temperature.ts`（P0 新增）

```typescript
export type MemoryTemperature = "hot" | "warm" | "cold";

export interface TemperatureInput {
  readonly category: MemoryCategory;
  readonly lastUsedAt: number;
  readonly importance: number;
  readonly now: number;
  readonly scope?: string | null;  // P1 字段，P0 可选
}

export function computeTemperature(
  input: TemperatureInput,
  thresholds: TemperatureThresholds,
): MemoryTemperature;

export interface TemperatureThresholds {
  readonly hotRecentDays: number;        // 默认 7
  readonly warmRecentDays: number;       // 默认 30
  readonly hotImportanceMin: number;     // 默认 0.8
  readonly warmImportanceMin: number;    // 默认 0.4
}
```

#### `memory-index.ts`（P0 新增）

```typescript
export interface MemoryIndexRepo {
  rebuildFts(): void;  // 删 agent_memories_fts 全表重建
  checkFtsHealth(): { isHealthy: boolean; reason?: string };
}
```

#### `memory-injector.ts`（P0 改）

```typescript
export const MEMORY_PLACEHOLDER = "{{LUMII_MEMORY_BLOCK}}";

export function injectMemories(
  systemPrompt: string,
  memories: readonly MemoryEntry[],
): string;  // 抛 Error 当占位符缺失且 NODE_ENV !== 'production'
```

---

## 6. IPC 与 UI

### 6.1 IPC 命令（已有，补充归档与重建命令）

| 命令 | 参数 | 功能 | 状态 |
|------|------|------|------|
| `agent:memories:save` | `{ category, content, importance, tags }` | 手动保存一条 | ✅ 已有 |
| `agent:memories:list` | `{ agentId?, includeArchived? }` | 列出全部记忆 | ✅ 已有 |
| `agent:memories:search` | `{ keyword, limit? }` | FTS 搜索 | ★P0 改用 FTS5 |
| `agent:memories:provenance` | `{ memoryId }` | 溯源 | ✅ 已有（完整） |
| `agent:memories:delete` | `{ memoryId }` | 删除 | ✅ 已有 |
| `agent:memories:archive` | `{ memoryId }` | 归档单条 | ✅ 已有 |
| `agent:memories:archiveCold` | `{ agentId, userId }` | 归档所有冷记忆 | ★P0 新增 |
| `agent:memories:unarchive` | `{ memoryId }` | 恢复 | ★P0 新增 |
| `agent:memories:rebuildIndex` | `{ agentId, userId }` | 重建 FTS 索引 | ★P0 新增 |

路由方式：复用现有 `agent-runtime:command` 单通道（`agent-runtime-ipc.ts`），
不新增顶层 IPC channel。

新增命令必须同步三处（`AGENTS.md` 硬性要求）：
1. main 侧 handler（`main/ipc/agent-runtime/agent-commands.ts`）
2. preload 的 `ElectronAPI` 类型与方法
3. `command-allowlist.ts` 白名单

### 6.2 待清理的死代码（P0）

调研中发现 4 个 `api:*Memory` 通道已无渲染进程调用方，属于历史遗留：
落地时用 grep 逐个确认无引用后删除，减少 IPC 表面积。

### 6.3 记忆管理 UI

**位置**：`SettingsPage → 记忆` （现有 `MemoryViewer` 组件扩展）

```
┌──────────────────────────────────────────────────────────────┐
│ [个人记忆] [工作记忆] [宫殿]            ← Tab 切换            │
├──────────────────────────────────────────────────────────────┤
│ 个人记忆 Tab                                                  │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ user-memory.md                       [整理] [保存]       │ │
│ │ ┌──────────────────────────────────────────────────────┐ │ │
│ │ │ ## 身份与背景                                        │ │ │
│ │ │ - 姓名：李明                                         │ │ │
│ │ │ ...                        ← MDEditor 直接编辑       │ │ │
│ │ └──────────────────────────────────────────────────────┘ │ │
│ │ 2.4 KB / 注入预算 2400 字符  ← 超预算时黄色警示          │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ 工作记忆 Tab                                                  │
│ [搜索框________________] [类别▾] [温度▾] [☐含归档]           │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ 🔥 project  0.8  K8s 系列：深度长文 1200-1500 字…        │ │
│ │    3 天前用过 · 用了 12 次      [来源] [编辑] [归档] [删] │ │
│ ├──────────────────────────────────────────────────────────┤ │
│ │ 🌡 reference 0.6  文章存放在 outputs/k8s-xhs-series/     │ │
│ │    12 天前用过 · 用了 3 次      [来源] [编辑] [归档] [删] │ │
│ ├──────────────────────────────────────────────────────────┤ │
│ │ ❄ general   0.4  Electron 打包 node_modules 不能符号链接 │ │
│ │    45 天前用过 · 用了 1 次      [来源] [恢复] [删除]      │ │
│ └──────────────────────────────────────────────────────────┘ │
│ 共 47 条（🔥12 🌡21 ❄14）  [归档全部冷记忆] [重建索引]       │
└──────────────────────────────────────────────────────────────┘
```

设计要点：

- **温度用图标而非文字**，一眼扫过能看出分布，不占横向空间
- **显示"多久前用过 · 用了几次"**，让用户理解温度是怎么算出来的，而不是黑盒
- **归档冷记忆是显式按钮**，不做自动后台归档。用户需要感知"系统删掉了什么"
- **重建索引入口放在这里**，出现搜不到东西的疑似索引损坏时用户可自救
- **个人记忆直接给 Markdown 编辑器**，不做行级 CRUD——文档本来就是给人读写的

### 6.4 记忆使用可视化（P1）

在 ChatPage 侧栏显示"本轮注入了哪些记忆"：

```
本轮注入记忆（8 条 / 892 token）
├─ 关于用户 2 条
├─ 进行中的事 4 条  ← 点击展开看具体内容
└─ 外部资源 2 条
   未注入：13 条低相关 · 14 条冷记忆
```

这个可视化的价值是**让记忆系统可调试**：用户抱怨"它怎么不记得我说过 X"时，
能立刻看出 X 是没被提取、被相关性门控挡了、还是超预算被截了。
`useMemoryUsage` hook 已存在，扩展它即可。

---

## 7. 可靠性与风险

### 7.1 FTS 索引失联

**风险**：external content FTS5 表与真相表可能不一致——手工改过库、
迁移过程中断、触发器创建失败，都会导致搜索结果缺失或指向已删除的行。

**对策**：
1. `rebuildMemoryIndex()` 全量重建，通过 `agent:memories:rebuildIndex` 暴露给用户
2. 启动时轻量健康检查：比对 `COUNT(*)` 是否一致，不一致则记 warn 日志并提示重建
3. 迁移里创建 FTS 表后**立即用 `INSERT INTO agent_memories_fts(agent_memories_fts) VALUES('rebuild')` 灌入历史数据**，
   否则老用户的历史记忆搜不到

### 7.2 迁移安全

`migrate()` 的现状约束（**设计时必须假定**）：
- 无 down migration，无回滚
- 无 per-statement 事务包裹
- `isMigrationAlreadyApplied(version)` 只让历史 ALTER 变幂等

因此：
- **P0 的 FTS 迁移只做 CREATE**（虚表 + 3 个触发器 + rebuild），不动 `agent_memories` 结构，失败也不损坏真相数据
- **P1 的 `scope` 只做 ADD COLUMN**，可空，不加 CHECK，不回填
- **绝不在迁移里做表重建**（这正是不选方案 B 的关键理由之一）
- 迁移前依赖 `LocalDatabase` 已有的备份轮转机制

### 7.3 LLM 整理个人记忆导致内容丢失

这是**全系统最高危的操作**：LLM 全量重写用户的画像文档，一次幻觉就可能抹掉几个月积累。

**分层防护**：

风险在**深度整理每 6 小时无条件执行一次**的场景下会累积：单次幻觉的概率不高，
但一天 4 次、一个月 120 次，只要有一次把文档改烂且用户没及时发现，损失就是不可逆的。

**分层防护**：

1. **缩水过半拒绝写入**（P0，当前缺失）
   ```typescript
   // memory-consolidation.ts:217 返回前
   const before = existingContent.trim();
   if (before.length > 200 && cleaned.length < before.length * 0.5) {
     return { content: existingContent, merged: false };  // 保持原样
   }
   ```
   现有代码只拒绝"< 10 字符"和"> maxLength"两种极端，
   6000 字整理成 500 字这种**明显的内容丢失会直接通过**。

2. **写入前自动备份**（P0，当前缺失）：把旧内容写到 `user-memory.md.bak`，
   只保留最近一份。用户发现记忆被改烂时有东西可捞。

3. **工具层面优先增量**（已实现）：`profile_memory` 的工具描述已明确要求
   优先用 `append` / `remove_section`，`update_memory` 全量覆写标注为 risky。

4. **LLM 异常不静默吞掉**（已实现，`local-companion-handler.ts:262-280`）：
   `consolidateUserMemory` 内部会把 LLM 异常回退成"无变化"，
   宿主额外记了一笔 `llmError` 并重新抛出，否则模型故障在定时任务页会显示成"跳过"，
   看不出是失败。这个设计要保留。

5. **整理结果可见**（P1）：整理产生实质变化后主动通知用户 + 提供 diff 查看，
   手动触发的整理先预览再确认写入。

6. **保留定时整理**：定时整理是必要能力（见 §4.9），**不删除**。
   fast 档有本地体检做前置过滤，成本可控；deep 档能捞出启发式查不到的隐式过时。
   风险靠上面 1、2 两道保险控制，而不是靠取消功能。

### 7.4 提取质量：`general` 垃圾抽屉

**现状问题**：`memory-extractor.ts:208` 对 `general` 的定义是"其他跨会话知识"，
且**提取提示里 user / feedback / project / reference 四类都有具体示例，只有 general 没有**。
语义模糊 + 无示例锚定 = 模型倾向于把拿不准的都丢进 general。

**P0 修正**：

```diff
- "| general | 工作记忆 | SQLite agent_memories | 其他跨会话知识 |",
+ "| general | 工作记忆 | SQLite agent_memories | 经验教训、踩坑记录、技术决策 |",
```

并补一条示例：

```
### general（经验与决策）→ 工作记忆
记录踩过的坑、做过的技术决策及其理由。不记录一次性的操作步骤。
示例：{"content": "经验：Electron 打包时 node_modules 不能用符号链接，会导致 asar 打包失败。已改用 pnpm 的 node-linker=hoisted", "category": "general", "importance": 0.7, "tags": ["electron", "build", "lesson"]}
```

**落地验证**：P0 上线后第一周手工抽查 50 条新提取的 general 类记忆，看有没有明显误放的。

### 7.5 冲突检测的可扩展性（P1）

当前工具冲突检测是硬编码（`memory-consolidation.ts:38-42`）：

```typescript
const hasScript = /generate_image\.py/.test(trimmed);
const hasTool = /\bimage_generate\b/.test(trimmed);
if (hasScript && hasTool) {
  return { needed: true, trigger: 'existing_conflicts' };
}
```

只能检出 `generate_image.py` vs `image_generate` 这一对。其他工具的脚本 vs 内置工具冲突识别不到。

**P1 改为可扩展**：

```typescript
const TOOL_CONFLICTS: Array<[string, string, string]> = [
  ['generate_image\\.py', 'image_generate', '脚本方案已替换为内置工具'],
  ['tts_cli\\.py', 'tts_generate', '脚本方案已替换为内置工具'],
  // 外部配置文件注入
];

export function checkToolConflicts(content: string): { conflict: boolean; reason?: string } {
  for (const [deprecated, current, reason] of TOOL_CONFLICTS) {
    if (new RegExp(deprecated).test(content) && new RegExp(current).test(content)) {
      return { conflict: true, reason };
    }
  }
  return { conflict: false };
}
```

这样新增工具时只需加一行配置，不用改代码逻辑。

---

## 8. 分批落地计划（P0 / P1 / P2）

### 8.1 P0（核心能力，3-4 周）

**目标**：补齐当前系统的工程短板，不添新概念。

| 任务 | 交付物 | 工作量 |
|------|--------|--------|
| **FTS5 派生索引** | DDL + 触发器 + migration | 2 天 |
| | `memory-index.ts` 重建函数 | 0.5 天 |
| | `memory-repo.ts:search()` 改用 FTS5 BM25 | 1 天 |
| | 中文分词测试（unigram 召回实测） | 1 天 |
| **纯函数抽取** | `scorer.ts` | 0.5 天 |
| | `temperature.ts` | 0.5 天 |
| | 相关单元测试 | 1 天 |
| **注入占位符改造** | `memory-injector.ts` 改 `MEMORY_PLACEHOLDER` | 0.5 天 |
| | prompt 模板加占位符 | 0.5 天 |
| | 删历史兼容分支 + 测试 | 0.5 天 |
| **温度计算 + 分档检索** | `loadTopMemories` 集成温度判定 | 1.5 天 |
| | `archiveCold()` 实现 | 0.5 天 |
| **UI 扩展** | MemoriesPage 温度筛选 + 图标 | 1.5 天 |
| | 归档冷记忆按钮 + 重建索引按钮 | 1 天 |
| **IPC 补齐** | 3 个新命令（archiveCold / unarchive / rebuildIndex） | 1 天 |
| **文档修正** | memory-architecture.ts 把 PostgreSQL 改本地文件 | 0.5 天 |
| **提取提示改进** | `general` 描述 + 示例 | 0.5 天 |
| **整理防护补强** | 缩水过半拒绝写入（`memory-consolidation.ts`） | 0.5 天 |
| | 写入前备份 `user-memory.md.bak` | 0.5 天 |
| | 防护逻辑单测（含深度整理路径） | 0.5 天 |
| **集成测试** | E2E：提取→打分→注入→归档 全流程 | 2 天 |

**验收标准**：
- ✅ 搜索中文记忆，10 个真实查询的前 3 位召回率 ≥ 旧 LIKE 方案
- ✅ `scoreMemory` / `computeTemperature` 单测覆盖率 100%
- ✅ 注入测试：占位符缺失时开发期抛错，生产期降级告警
- ✅ 冷记忆归档后，`loadTopMemories` 不再返回它
- ✅ 个人记忆文档超 2400 字时，章节截断正常，无内容被分割到两个章节
- ✅ 构造"LLM 返回缩水 80% 的文档"场景，断言拒绝写入且原文完好
- ✅ 深度整理执行后 `user-memory.md.bak` 存在且内容等于整理前的原文

### 8.2 P1（优化与可观测，2-3 周）

**目标**：让记忆系统可调试、可干预。

| 任务 | 交付物 |
|------|--------|
| **显式 scope 字段** | ALTER TABLE + migration（schema 15→16） |
| | 提取提示扩展（可选标注） |
| | 检索策略集成（`global` 不衰减） |
| **高亮搜索结果** | `snippet()` 返回匹配摘要 |
| | UI 显示高亮 |
| **查重入口** | FTS 相似度查询 |
| | MemoriesPage 疑似重复项并排展示 |
| **记忆使用可视化** | ChatPage 侧栏"本轮注入了什么" |
| | useMemoryUsage 扩展 |
| **整理预览** | UI 触发整理时显示 diff |
| | 用户确认后写入 |
| **整理可见性** | 定时整理产生变化后主动通知用户 |
| | MemoriesPage 显示最近整理时间 + diff 查看 |
| **冲突检测可扩展** | `TOOL_CONFLICTS` 配置化 |
| **温度阈值可配置** | UI 设置项 + 运行时配置持久化 |

### 8.3 P2（语义能力，需先评测，6+ 周）

**前置条件**：建立**中文记忆语义评测集**，至少包含：
- 10 组语义相同但表述不同的记忆对（如"我喜欢爬山" vs "用户爱好是爬山"）
- 20 条查询 + 已知相关记忆 gold standard
- BM25 baseline 的 Recall@5 与 NDCG@10

没有评测集就无法判断向量检索是否真的比 BM25 更好，否则只是盲目跟风。

**P2 能力清单**：

| 任务 | 依赖条件 | 风险 |
|------|---------|------|
| **向量语义去重** | 评测集 + embed API（本地或云） | embed 成本、中文模型选型 |
| **向量语义检索** | 同上 | 需要 hybrid RRF（向量 + FTS5 融合） |
| **可配置衰减公式** | 积累 ≥1000 条真实记忆数据 | 参数过多反而无从调优 |
| **ERO 三元组** | 方案 B 的 stable/dynamic 分类失败后的退路 | 提取难度 × 存储膨胀 |
| **记忆强度联合** | 多来源合并 `w=1-(1-a)(1-b)` | 需先有多来源写入场景 |

**明确不做的事**（过度设计）：
- ❌ **规则引擎式的冲突自动改写**。中文否定语义规则化必爆假阳性
  （"我不太喜欢爬山但偶尔也去" 这类表述规则引擎处理不了）。
  语义级消解交给 LLM（已实现，见 §4.5），启发式只负责**检测**可枚举的互斥对，不负责改写。
- ❌ 记忆图谱可视化（Wiki 的 backlinks 已覆盖关联关系需求）
- ❌ 多跳推理路径跟踪（Wiki 设计里已决定不做 Cascade 自动重写）
- ❌ 把定时整理改成"仅手动触发"。定时整理是已在运行的必要能力，
  见 §4.9；风险靠缩水校验 + 备份控制，不靠取消功能。

---

## 9. 测试策略

### 9.1 单元测试（Vitest）

| 模块 | 测试点 |
|------|--------|
| `scorer.ts` | 固定 `now` 输入，断言分数；边界用例（importance 0/1，days 0/∞） |
| `temperature.ts` | 覆盖 5 类 × 3 档温度的判定；scope P1 字段的影响 |
| `merge.ts` | normalizeKey 的中文标点去除；tags 并集；importance 取最大 |
| `memory-injector.ts` | 占位符替换；占位符缺失时抛错；空记忆不生成块 |
| `estimateTokens` | 中文 / 英文 / 混合文本的 token 估算误差 ±20% |

测试文件命名 `*.test.ts`。现有记忆模块两种放法并存
（`memory/__tests__/` 与 `src/__tests__/memory-provenance.test.ts`），
新增测试跟随所测模块就近放置，共享 fixture 的放 `__tests__/`。

### 9.2 集成测试

| 场景 | 断言 |
|------|------|
| **提取全流程** | 喂一段对话 → 断言产出的候选类别/importance 合理 → 落库 → 能被检索到 |
| **FTS 一致性** | 插入/更新/删除记忆后，FTS 表与真相表 COUNT 一致 |
| **FTS 重建** | 手工清空 FTS 表 → rebuild → 搜索结果恢复 |
| **温度流转** | 构造不同 `last_used` 的记忆 → 断言温度分档 → archiveCold 后不再注入 |
| **注入预算** | 构造超预算记忆集 → 断言截断在条目边界，不切碎单条记忆 |
| **个人记忆整理** | 喂含重复项的文档 → LLM 整理 → 断言重复消除且无内容丢失 |
| **迁移幂等** | 重复执行 migration → 无报错，无重复索引 |

### 9.3 E2E（Playwright）

| 用例 | 路径 |
|------|------|
| 记忆管理页加载 | SettingsPage → 记忆 → 列表渲染 |
| 温度筛选 | 点击温度筛选器 → 列表过滤正确 |
| 溯源查看 | 点击"来源" → 弹出对话原文 |
| 归档与恢复 | 归档一条 → 从列表消失 → 勾选"含归档" → 出现 → 恢复 |
| 个人记忆编辑 | 编辑 Markdown → 保存 → 重新加载内容一致 |
| 搜索 | 输入中文关键词 → 结果按相关性排序 |

---

## 10. 附录

### 10.1 现有实现清单（避免重复开发）

| 能力 | 实现位置 | 状态 |
|------|---------|------|
| 5 类记忆 + 全部元数据字段 | `schema.ts:68-93`、`types.ts` | ✅ 完整 |
| importance 加权 + recency + 相关性门控 | `memory-repo.ts:49-134` | ✅ 有，待抽纯函数 |
| 个人记忆 Markdown 全文 | `main/index.ts:654` / `:732` | ✅ 完整 |
| 个人记忆 LLM 去重合并 | `memory-consolidation.ts` | ✅ 有，缺缩水校验 |
| 定时整理（fast 30min / deep 6h） | `local-companion-handler.ts:423-441` | ✅ 有，缺备份 |
| 冲突检测（启发式） | `memory-consolidation.ts:37-76` | ✅ 有，硬编码待配置化 |
| 冲突消解（LLM 语义） | `memory-consolidation.ts:142-146` 提示词 | ✅ 完整 |
| LLM 异常不静默吞掉 | `local-companion-handler.ts:262-280` | ✅ 完整 |
| 段落分段 + 总结提取 | `segmentation.ts` / `segment-memory-pipeline.ts` | ✅ 完整 |
| 字符串级去重合并 | `merge.ts` | ✅ 有，边界已知 |
| 溯源链路（记忆→对话原文） | `manager.ts:342-390` + 6 处 IPC/UI | ✅ 完整 |
| 宫殿互引（drawer_id） | `content-address.ts` + `archivePalace` | ✅ 完整 |
| 注入预算截断（个人记忆） | `bridge-prompt-composer.ts:413` | ✅ 完整 |
| 归档（软删除） | `memory-repo.ts:276-310` | ✅ 有，缺温度归档 |
| prompt cache 边界 | `bridge-prompt-composer.ts:398` | ✅ 完整 |

### 10.2 已验证的技术结论

1. **MemPalace 向量能力不可从 TS 侧复用**。它是外部 PyPI 包，
   以 Python MCP stdio JSON-RPC 子进程运行，内部用 chromadb，**没有暴露 embed 端点**。
   想在 TS 侧做向量检索必须另找 embedding 方案，不能"借用" MemPalace。
2. **项目当前零 FTS5 使用**。这是第一次引入，需要验证 `node:sqlite` 的
   `DatabaseSync` 与 `better-sqlite3` fallback 两条路径都支持 FTS5 编译选项。
3. **`unicode61` 不做中文分词**，对 CJK 按字切分。这是 P0 的已知折衷，不是 bug。
4. **SQLite 无法 ALTER CHECK 约束**。这是不选方案 B 的硬性技术理由。

### 10.3 许可证边界（红线）

调研报告参考了 11 个开源项目，**只可借鉴设计思路，不可复制实现代码**：

| 项目 | 许可证 | 约束 |
|------|--------|------|
| `mcp-memory-graph` | PolyForm Noncommercial | 禁止商用，不可取代码 |
| `siyuan` | AGPLv3 | 传染性，不可取代码 |
| `chenly255-llm-wiki` | 无许可证文件 | 默认保留全部权利，不可取代码 |
| `erickmbugua-llm-wiki` | 无许可证文件 | 同上 |
| `aaronsb/memory-graph` | ISC/MIT 声明冲突 | 归属不清，不可取代码 |
| `modelcontextprotocol-servers` | 许可证迁移期 | 状态不明，不可取代码 |

**可安全借鉴的是概念**：truth table + derived index 架构、DKR compile 方法论、
ERO 模型、supersede 墓碑、RRF 融合公式、`[[wikilink]]` 语法约定。
这些是公开的设计模式与行业惯例，不受具体项目许可证约束。

---

## 11. 一句话总结

**`agent_memories` 与 `user-memory.md` 是唯一真相；FTS5 索引和温度都是可重建的派生物。
P0 补齐检索（FTS5）、打分（纯函数）、注入（占位符）、整理防护（缩水拒绝+备份）四处工程短板并引入温度分档；
P1 加 `scope` 字段、冲突检测可扩展化与整理可见性；
P2 的语义能力必须先有中文评测集才动手。
定时整理（已有，fast 30min / deep 6h）是必要能力，保留并强化防护，不删除。**
