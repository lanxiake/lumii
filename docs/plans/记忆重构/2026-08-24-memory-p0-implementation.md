# Lumii 记忆系统 P0 实施计划

> 日期：2026-08-24
> 设计来源：`docs/design/记忆设计/2026-08-24-memory-design.md`（方案 A+）
> 范围：P0 核心能力，周期 3-4 周
> 原则：不改 `agent_memories` 表结构，只加派生索引与纯函数抽取

---

## 1. 目标

补齐四处工程短板，引入温度分档：

| 短板 | 现状 | P0 目标 |
|------|------|---------|
| 检索 | `content LIKE '%kw%'`（`memory-repo.ts:317`） | FTS5 + BM25 排序，可重建 |
| 打分 | 内联在 `loadTopMemories` 里，85 行混 6 件事 | 抽 `scoreMemory` 纯函数，`now` 可注入 |
| 注入 | `indexOf("## 工作记忆")` 字符串手术（`memory-injector.ts:176`） | 占位符替换，缺失即报错 |
| 整理防护 | 只拒绝 `<10 字符` / `>maxLength` | 加缩水过半拒绝 + 写入前备份 |
| 生命周期 | 无 | 温度分档（hot/warm/cold）+ 冷归档 |

**可验证性硬要求**：每项交付都能用 `lumii-ui` CLI 对真实数据自测，不只靠单测。

---

## 2. 任务依赖顺序

```
Task 1 纯函数抽取（scorer + temperature）
   ↓ 无依赖，可先做
Task 2 FTS5 派生索引（migration + search 改写）
   ↓
Task 3 注入占位符改造
   ↓
Task 4 温度集成 + 冷归档          ← 依赖 Task 1
   ↓
Task 5 整理防护补强               ← 独立，可与 2-4 并行
   ↓
Task 6 IPC 命令补齐               ← 依赖 Task 2、4
   ↓
Task 7 CLI 命令扩展               ← 依赖 Task 6，验证性交付
   ↓
Task 8 集成 + E2E + 真实数据自测
```

| Task | 工作量 | 关键产出 |
|------|--------|---------|
| 1 纯函数抽取 | 2 天 | `scorer.ts` / `temperature.ts` + 单测 |
| 2 FTS5 索引 | 4.5 天 | migration v15 + `memory-index.ts` + search 改写 + 中文召回实测 |
| 3 注入改造 | 1.5 天 | `MEMORY_PLACEHOLDER` 契约 + 模板改造 |
| 4 温度集成 | 2 天 | 分档检索 + `archiveCold` / `unarchiveById` / `countByTemperature` |
| 5 整理防护 | 1.5 天 | 缩水拒绝 + `.bak` 备份 + 拒绝原因回传 |
| 6 IPC 补齐 | 1 天 | 5 个新命令 + 白名单 + preload 同步 |
| 7 CLI 扩展 | 1 天 | `memory` 命令组 7 个子命令 |
| 8 集成验证 | 3 天 | 集成测试 + E2E + CLI 自测脚本 |

---

## 3. 前置准备（0.5 天）

1. **验证 FTS5 可用性**——Task 2 的全部前提。`node:sqlite` 若未编译 FTS5，整个方案要换退路：

   ```bash
   node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');
   d.exec(\"CREATE VIRTUAL TABLE t USING fts5(c)\");console.log('FTS5 OK')"
   ```

   同样要验 `better-sqlite3` 兜底路径。两者任一不支持，就在 migration 里做能力探测并降级回 `LIKE`。

2. 建分支 `feat/memory-p0-engineering`。

3. **备份真实库**：`cp ~/.lumii/data/lumii.db ~/.lumii/data/lumii.db.pre-p0.bak`。migrate 无回滚，这是唯一退路。

4. 记录基线：`lumii-ui command agent:memories:list --data '{}'` 存下记忆条数，供 Task 2 重建后比对。

---

## 4. Task 1：纯函数抽取（2 天）

### 现状问题

`loadTopMemories`（`memory-repo.ts:49-100`）一个方法 85 行混了 6 件事：SQL 查询、
recency 计算（`:78` 硬编码 `0.1` 与 `30` 天）、相关性 overlap（`:81`）、门控、排序、预算截断。
`Date.now()` 内联导致打分无法固定时间测试。

### 核心产出

**`packages/agent-runtime/src/memory/scorer.ts`**——`now` 显式注入，无 `db` 依赖：

```typescript
export function scoreMemory(input: MemoryScoreInput, cfg: HotMemoryConfig): number {
  const daysSinceUse = (input.now - input.lastUsedAt) / 86_400_000;
  const recencyBonus = cfg.recencyWeight * Math.max(0, 1 - daysSinceUse / cfg.recencyHalfLifeDays);
  return input.importance * cfg.categoryWeights[input.category]
    + recencyBonus
    + cfg.relevanceBonus * input.relevance;
}
```

**`temperature.ts`**——`computeTemperature(input, thresholds)`，分档规则：

| 温度 | 判定（对齐设计 §3.4，注意是"或"不是"且"） | 检索行为 |
|------|------|------|
| `hot` | 个人类（`user`/`feedback`）；**或** 7 天内用过；**或** `importance >= 0.8` | 优先注入，**跳过**相关性门控 |
| `warm` | 7~30 天未用，且 `importance >= 0.4` | 注入前**须过**相关性门控（overlap ≥ 0.15） |
| `cold` | 超 30 天未用；或 `importance < 0.4` 且 7 天未用 | **不注入**，仅显式搜索可见 |

温度是**派生值不落库**，所以阈值调整立即对全量历史生效，不需要迁移。
个人记忆恒为 hot，不参与温度计算——这条约束同时体现在 `computeTemperature` 与 `archiveCold` 的 SQL 里。

### 验证方式

单测覆盖 5 类 × 3 档判定矩阵，`now` 传固定时间戳。重点用例：
边界日（第 7 天 / 第 30 天整）、高 importance 但久未用（应仍 hot）、
低 importance 刚用过（应 warm 不是 hot）、个人类久未用（应仍 hot）。

---

## 5. Task 2：FTS5 派生索引（4.5 天）

### 业务流程变化

```
改造前：search(kw) → SELECT ... WHERE content LIKE '%kw%'  → 无排序、中文长查询召回≈0
改造后：search(kw) → escapeFtsQuery(kw)
                  → agent_memories_fts MATCH ? JOIN agent_memories
                  → ORDER BY bm25(fts)  → 相关度降序
```

### 核心步骤

1. **加 migration v15**（`schema.ts`，`SCHEMA_VERSION` 14 → 15）。建 external content 虚表
   （`content='agent_memories'` 不复制正文）+ 三个同步触发器 `_ai` / `_ad` / `_au`。

2. **必须带全量重建语句**，否则老用户的历史记忆全都搜不到——触发器只对新写入生效：

   ```sql
   INSERT INTO agent_memories_fts(agent_memories_fts) VALUES('rebuild');
   ```

3. **新增 `memory-index.ts`**：`rebuildFts()` / `checkFtsHealth()`。健康检查比对
   `COUNT(*)` 与 FTS 行数，不一致就报不健康，供 CLI 与 UI 调用。

4. **改写 `search()`**（`memory-repo.ts:317`）为 BM25 查询，`ORDER BY rank`。

5. **转义 MATCH 特殊字符**（`" * ( ) : AND OR NOT`）。用户输入含引号会直接抛 SQL 错误，
   这是最容易漏的一步：把关键词包成 `"..."` 并把内部 `"` 转成 `""`，最省事且语义正确。

### 关键风险：中文分词

`unicode61` **不做中文分词**，对 CJK 等于按字切分（unigram）。
查"爬山"能命中"喜欢爬山"，但也会命中"山上爬行"。比 `LIKE` 强（有 BM25 排序、
`snippet()` 高亮、多词 AND/OR），但不完美。

**落地必须用真实中文记忆做召回实测**（见 §11 CLI 自测）。若误配率不可接受，
退路是 P1 引入 bigram 自定义分词或 `tokenize='trigram'`（索引体积明显更大）。

### 验证方式

- 一致性测试：插入/更新/删除后 `checkFtsHealth()` 恒健康；`rebuildFts()` 后条数与 Task 3 前置记录的基线一致。
- 中文召回测试：真实语料，断言目标记忆在 top-3。
- 降级测试：FTS 表被手动 DROP 后，`search()` 不崩溃（回落 `LIKE` 并告警）。

---

## 6. Task 3：注入占位符改造（1.5 天）

### 现状缺陷

`memory-injector.ts:170-191` 用 `indexOf("## 工作记忆")` 找注入点再拼字符串，
还带一个 legacy `indexOf("## 你的记忆")` 兼容分支。标题文案一改就**静默失效**，
位置正确性无法测试，兼容分支只会越堆越多。

### 改造

```typescript
export const MEMORY_PLACEHOLDER = "{{LUMII_MEMORY_BLOCK}}";

// 命中即替换；缺失时开发期抛错、生产期告警降级（不能因为模板问题让用户用不了）
if (systemPrompt.includes(MEMORY_PLACEHOLDER)) return systemPrompt.replace(MEMORY_PLACEHOLDER, block);
if (process.env.NODE_ENV !== "production") throw new Error(`system prompt 缺少 ${MEMORY_PLACEHOLDER}`);
console.warn(`[injectMemories] 缺少占位符，记忆未注入`);
return systemPrompt;
```

### 核心步骤

1. 在 prompt 模板里插入占位符，删掉两处 `indexOf` 手术与 legacy 分支。
2. 确认占位符落在 **cache boundary 之后的 dynamic 段**——工作记忆每轮变化，
   放进 static 段会让 prompt cache 每轮失效（`bridge-prompt-composer.ts:398`）。
   个人记忆仍在 static 段，保持可缓存。
3. 全仓搜索残留的 `"## 工作记忆"` 字面量引用，一并清理。

### 验证方式

单测：占位符存在→替换且位置正确；缺失→开发期抛错、生产期返回原串并告警；
空记忆列表→占位符被替换为空而不是留下 `{{...}}` 字面量泄漏到模型输入。

---

## 7. Task 4：温度集成与冷归档（2 天）

### 检索业务流程（改造后完整链路）

```
候选池 SELECT（is_archived=0，有查询时 LIMIT 200 / 无查询 50）
   ↓ 逐行 computeTemperature(row, thresholds)
   ↓ cold → 直接丢弃（不注入）
   ↓ warm → 过相关性门控：overlap < 0.15 丢弃
   ↓ hot  → 跳过门控，直接进排序
   ↓ scoreMemory(row, cfg) 打分排序
   ↓ token 预算截断（maxTokenBudget / maxItems 双上限）
   ↓ 命中的记忆 last_used = now, use_count += 1   ← 温度的输入，闭环
```

注意最后一步的副作用：**被注入才算"用过"**。这让温度反映真实使用，
也为 P1 分析"哪些记忆从未被用"留下数据。

### 新增仓库方法

| 方法 | 语义 |
|------|------|
| `archiveCold(now)` | 批量归档 `last_used` 超 30 天且**类别不属于 `user`/`feedback`** 的记忆，返回影响条数 |
| `unarchiveById(id)` | 恢复归档（`is_archived = 0`） |
| `countByTemperature(now)` | 返回 `{ hot, warm, cold }` 分布，供 CLI `memory stats` 与 UI 展示 |

`archiveCold` 的 SQL 必须带 `AND category NOT IN ('user','feedback')`——
个人记忆不受温度影响，漏了这个条件会把用户名字、偏好这类永久记忆归档掉。

### 验证方式

集成测试构造不同 `last_used` 的记忆 → 断言温度分档正确 → 执行 `archiveCold`
→ 断言冷记忆不再进注入、个人记忆不受影响 → `unarchiveById` 后恢复可见。
**归档不是删除**，数据仍在库里，这点要在测试里明确断言。

---

## 8. Task 5：整理防护补强（1.5 天）

> 定时整理（fast `*/30 * * * *` / deep `0 */6 * * *`，`local-companion-handler.ts:423-441`）
> 是**已有并在生产运行**的能力。本任务是给它加防护，不是新增也不是删除它。

### 风险

深度整理每 6 小时无条件重写整份个人记忆文档（4 次/天，约 120 次/月）。
现有校验只有三条：`< 10` 字符、`> maxLength`、内容未变。
**一次 6000 字 → 500 字的重写会直接通过并写入**，且无备份可回滚。

### 两处补强

1. **缩水过半拒绝**（`memory-consolidation.ts` 返回前）：

   ```typescript
   if (existingContent.trim().length > 200 && cleaned.length < existingContent.trim().length * 0.5) {
     return { content: existingContent, merged: false };  // 拒绝写入，保持原样
   }
   ```

   `> 200` 的前置条件是必要的：短文档整理时缩水比例波动本来就大，一律校验会误拒。

2. **写入前备份**（`local-companion-handler.ts:285` 之前）：把旧内容写 `user-memory.md.bak`，
   只留最近一份。这是整理出问题后唯一的人工恢复途径。

3. **拒绝原因要可见**：cron 结果文本必须区分"缩水拒绝"与"无变化"。
   这与代码里已有的 `llmError` 处理同理——模型失败不能显示成"已跳过"，
   否则用户看不出记忆整理其实一直在失败。

### 验证方式

单测：构造 LLM 返回缩水 80% 的响应 → 断言拒绝写入且原文完好、`merged: false`；
构造正常整理 → 断言写入成功且 `.bak` 内容等于整理前原文；
短文档（<200 字）大幅缩水 → 断言**不**触发拒绝。

---

## 9. Task 6：IPC 命令补齐（1 天）

新增 3 个命令（对齐设计 §6.1）：

| 命令 | 参数 | 功能 |
|------|------|------|
| `agent:memories:archiveCold` | `{ agentId, userId }` | 归档全部冷记忆，返回条数 |
| `agent:memories:unarchive` | `{ memoryId }` | 恢复归档 |
| `agent:memories:rebuildIndex` | `{}` | 重建 FTS 索引 |

另需把 `agent:memories:search` 切到 FTS5 实现，并补 `agent:memories:stats`（温度分布）。

**三处必须同步**（漏一处命令就不通）：IPC handler 注册 → preload 暴露 → `command-allowlist.ts` 白名单。
白名单是**默认拒绝**语义，不加条目等于命令不存在。

安全边界：这批命令只操作本用户自己的记忆元数据，不涉及文件系统与任意内容写入，
可以进白名单；但 `archiveCold` / `rebuildIndex` 是批量写操作，CLI 调用时要有确认或 `--yes`。

---

## 10. Task 7：CLI 命令扩展（1 天）

`apps/windows/resources/app-ui-cli/commands.mjs` 是**声明式注册表**
（`name/group/usage/summary/layer/route/options/build(args)`），加命令只改这个文件 + 白名单。

新增 `memory` 命令组：

| 子命令 | 用途 |
|--------|------|
| `memory list [--archived] [--category C]` | 列出记忆 |
| `memory search <关键词> [--limit N]` | FTS5 搜索，验证中文召回 |
| `memory stats` | 温度分布 + 总数 |
| `memory provenance <id>` | 溯源到来源 segment |
| `memory archive-cold --yes` | 批量冷归档 |
| `memory unarchive <id>` | 恢复 |
| `memory rebuild-index` | 重建 FTS 索引 |

退出码沿用既有约定：`ok:0 / other:1 / usage:2 / appDown:3 / auth:4 / denied:5`。
路由走 `{ method: 'POST', path: '/ipc/agent/memories/...' }`，`group` 填 `'记忆'`。

---

## 11. Task 8：真实数据 CLI 自测（3 天）

这是 P0 的**验收主场**。单测证明逻辑对，CLI 自测证明它在真实库、真实中文语料上确实可用。
自测前确认应用已启动（控制口来自 `~/.lumii/runtime/app-ui.json`）。

> 隔离建议：先用 `LUMII_CLIENT_DATA_DIR` 指向一份真实库的**拷贝**跑一遍全流程，
> 确认无破坏性行为后再对主库执行。`archive-cold` 是批量写操作，这一步别省。

### 自测流程与预期

```bash
# ① 基线：与 §3 前置准备记录的条数一致
lumii-ui memory stats
#   预期：总数 = 基线值；输出 hot/warm/cold 三档分布

# ② FTS 索引健康 + 全量重建（验证老数据被索引）
lumii-ui memory rebuild-index
lumii-ui memory stats
#   预期：重建后总数不变（索引是派生物，重建不该丢数据）

# ③ 中文召回实测 —— Task 2 最关键的一步
lumii-ui memory search "爬山"
lumii-ui memory search "项目部署"
#   预期：目标记忆出现在 top-3；对比改造前 LIKE 的召回结果记录差异
#   同时人工评估误配率（unigram 分词会带来"山上爬行"这类噪音）

# ④ 特殊字符不崩
lumii-ui memory search '"引号 AND 测试"'
#   预期：正常返回或空结果，不抛 SQL 异常、不返回 exit 1

# ⑤ 溯源链完整
lumii-ui memory list --limit 5
lumii-ui memory provenance <上一步取的id>
#   预期：能定位到来源 segment（source_segment_id 有值的记忆）

# ⑥ 温度归档闭环
lumii-ui memory stats                    # 记下 cold 数量 N
lumii-ui memory archive-cold --yes       # 预期返回归档条数 ≈ N
lumii-ui memory stats                    # 预期 cold 归零，总数不变（归档≠删除）
lumii-ui memory list --category user     # 预期个人记忆一条没少 ★关键
lumii-ui memory unarchive <id>           # 预期该条恢复可见
```

### 人工验证项（CLI 覆盖不到的）

- **注入生效**：真实对话一轮，确认个人记忆内容体现在回复里，且 prompt 里无 `{{LUMII_MEMORY_BLOCK}}` 残留。
- **整理防护**：手动触发一次 deep 整理，确认 `user-memory.md.bak` 生成且等于整理前原文；
  cron 页面能区分"缩水拒绝"与"无变化"。
- **prompt cache 未被破坏**：连续两轮对话，确认 cache 命中率没有因占位符位置变化而下降。

---

## 12. 验收清单

**功能**

- [ ] `scoreMemory` / `computeTemperature` 纯函数化，`now` 可注入，单测覆盖 5 类 × 3 档矩阵
- [ ] FTS5 虚表 + 3 触发器 + migration v15 含 `rebuild`，老数据可搜
- [ ] `search()` 走 BM25 排序，MATCH 特殊字符已转义
- [ ] 真实中文语料召回优于改造前，误配率人工确认可接受
- [ ] 注入改用 `MEMORY_PLACEHOLDER`，`indexOf` 手术与 legacy 分支已删除
- [ ] 冷记忆不注入；`archiveCold` 不动 `user`/`feedback`
- [ ] 缩水过半拒绝写入 + `.bak` 备份 + 拒绝原因在 cron 结果可见
- [ ] 3 个新 IPC 命令（handler / preload / 白名单三处同步）
- [ ] 7 个 `memory` CLI 子命令可用，退出码符合约定

**质量**

- [ ] `pnpm lint` / `typecheck` / `test` 全绿
- [ ] `agent_memories` 表结构**未改动**（P0 不加列、不改 CHECK）
- [ ] §11 全部 CLI 自测步骤通过，输出留档
- [ ] 未提交数据库、用户数据、密钥（AGENTS.md 约束）

---

## 13. 风险与回滚

| 风险 | 应对 |
|------|------|
| `node:sqlite` 未编译 FTS5 | §3 前置探测；不支持则 migration 内能力探测并降级 `LIKE`，Task 2 缩为"抽象 search 接口" |
| migration 无回滚机制 | 依赖 `LocalDatabase` 备份轮转 + §3 手动 `lumii.db.pre-p0.bak`；FTS 表是派生物，出问题可直接 DROP 重建 |
| 中文 unigram 误配率过高 | 先实测（§11 ③）。不可接受则 P1 上 bigram/trigram 分词；BM25 排序本身已比 `LIKE` 改善明显 |
| 占位符漏配导致记忆不注入 | 开发期抛错（不可能悄悄漏过测试）；生产期降级告警不阻断用户 |
| `archiveCold` 误归档个人记忆 | SQL 硬编码 `category NOT IN ('user','feedback')` + 集成测试断言 + §11 ⑥ 真实数据复核 |
| 定时整理丢内容 | 缩水拒绝 + `.bak` 备份；**不取消定时整理**，靠防护控制风险 |

**回滚顺序**：`DROP TABLE agent_memories_fts` 与 3 个触发器 → `search()` 回退 `LIKE`
→ 必要时恢复 `lumii.db.pre-p0.bak`。纯函数抽取与占位符改造是无状态改动，git revert 即可。

---

## 14. 一句话总结

P0 不动表结构，只补四处工程短板（FTS5 检索、纯函数打分、占位符注入、整理防护）
并引入不落库的温度分档；所有成果都能用 `lumii-ui memory *` 对真实数据自测验证。
