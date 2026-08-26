# Lumii Wiki 知识库 P2 实施计划

> 日期：2026-08-26
> 设计来源：`docs/design/记忆设计/2026-08-25-wiki-design-p0p1p2.md` §5
> 范围：P2 - 知识合成 + 图谱 + 智能检索
> 周期：按能力独立分期（见 §1），不捆绑发布
> 原则：合成仅用户触发、引用保真、图谱先复用 P1 链接索引、向量检索有门槛

---

## 0. 现状核实（2026-08-26）

| 项 | 实际状态 | 对 P2 的影响 |
|---|---|---|
| `wiki_links` 表 | P1 Task 1 落地（V18） | **图谱视图直接以此表为数据源**，无需 ERO 最小模型先行 |
| `wiki_pages.status` 列 | P1 落字段（V18），只落不读 | 页面状态 UI 在 P2 启用，无迁移成本 |
| `@xyflow/react` + `@dagrejs/dagre` | 已装，`CronPage/PipelinesTab/PipelineGraph.tsx` 在用 | 图谱可视化复用既有模式 |
| 向量能力 | 本地无 embedding 运行时（sherpa-onnx 仅 ASR）；MemPalace 为独立插件，向量不可复用 | 向量检索需新引入本地嵌入模型，见 §6 |
| `last_used` / `use_count` | P0 已落，`touchPage()` 已在检索/读取路径更新 | 遗忘排序可直接实现 |
| 合成相关磁盘约定 | 产物目录 `cwd/outputs/`，Wiki 只引用路径不搬移文件 | 综述落盘位置沿用 |

---

## 1. 能力分期与发布门槛（设计 §5.6）

P2 五项能力相互独立，**按各自门槛触发，不捆绑发布**：

| 能力 | 门槛 | 本计划状态 |
|------|------|-----------|
| A. 综述合成（`syntheses/`） | 用户已有足量分类资料且提出跨资料总结需求 | **用户已明确要求（标题→归纳文档→源文件），立即实施** |
| B. 知识图谱视图 | 反链不足以支撑关系导航 | **用户已明确要求（双链图谱），立即实施**；先复用链接索引，ERO 模型按需 |
| C. 页面状态与矛盾提示 | 出现真实的知识过期与冲突场景 | 低成本规则部分可随 A 顺带交付，语义漂移依赖向量（§6） |
| D. 向量检索 | 金标集证明全文召回不足 | 不启动（无金标集）；本计划给出启动路径与决策点 |
| E. 遗忘曲线排序 | 数据已备（use_count/last_used） | 不启动；作为公式实现，随 C 或独立小任务交付 |

**因此本计划的执行范围：A + B 为主体（约 2 周），C 规则层随行（0.5 天），D/E 只写决策与路径不排期。**

---

## 2. 任务依赖顺序

```
Task 0 Schema V19（wiki_syntheses 表）
   ↓
Task 1 综述合成器（A：分块合成 + 落盘 + 引用保真）
   ↓
Task 2 合成候选确认流程 + IPC/CLI
   ↓
Task 3 图谱视图（B：链接索引 → 图数据 → 可视化）
   ↓
Task 4 页面状态扫描（C 规则层）
   ↓
Task 5 合成 UI（触发/进行中/审阅）
   ↓
Task 6 测试与真实数据自测
```

| Task | 工作量 | 关键产出 |
|------|--------|---------|
| 0 Schema V19 | 0.5 天 | `wiki_syntheses` 表 |
| 1 综述合成器 | 3 天 | `WikiSynthesizer`：分块、5000 字上限、落盘、引用追踪 |
| 2 确认流程 + IPC/CLI | 1.5 天 | 4 个新命令 + 3 个 CLI 子命令 |
| 3 图谱视图 | 2.5 天 | `WikiGraphBuilder` + 图谱视图（复用 xyflow+dagre） |
| 4 页面状态扫描 | 1 天 | 规则扫描 + 候选确认（低成本层） |
| 5 合成 UI | 1.5 天 | 合成视图（触发/审阅/接受拒绝） |
| 6 测试自测 | 2 天 | 单测 + E2E + 真实数据验证 |

---

## 3. Task 0：Schema V19（0.5 天）

### 位置

`packages/agent-runtime/src/storage/schema.ts` —— `MIGRATIONS` 追加 `[19, ...]`，`SCHEMA_VERSION` 18 → 19。

### DDL

```sql
-- wiki_syntheses：综述合成运行记录（合成页与来源的多对多）
CREATE TABLE IF NOT EXISTS wiki_syntheses (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  page_id        TEXT,               -- 接受后建出的 syntheses/ 页面 id
  source_page_ids TEXT NOT NULL,     -- JSON 数组：依据的页面 id
  source_ids     TEXT,               -- JSON 数组：依据的资料条目 id（可空）
  title          TEXT NOT NULL,
  output_path    TEXT,               -- 落盘的 .md 文件路径（生成文件，链接引用）
  candidate_md   TEXT NOT NULL,      -- 候选正文（审阅期内容）
  status         TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'accepted', 'rejected')),
  error          TEXT,
  created_at     TEXT NOT NULL,
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_wiki_syntheses_agent_user
  ON wiki_syntheses (agent_id, user_id, status, created_at DESC);
```

要点：

- **候选是正式数据**：合成结果先落 `candidate_md` + `status='candidate'`，用户接受后才建 `syntheses/` 页面。拒绝的记录保留（可审计「AI 提议过什么、用户否了什么」），不删除。
- 依据溯源：`source_page_ids` / `source_ids` 两个 JSON 数组记录合成输入，页面视图的「来源」区直接读它。
- 落盘文件路径存 `output_path`，页面正文用**链接引用**该文件（`[标题](相对路径)`），符合「带有生成的文件需要使用链接引用」要求。

### 验证方式

- 空库与 V18 库均可迁移，`SCHEMA_VERSION` = 19
- `schema-wiki.test.ts` 追加 V19 断言

---

## 4. Task 1：综述合成器（3 天）

### 位置

新建 `packages/agent-runtime/src/wiki/wiki-synthesizer.ts`。

### 4.1 触发方式（设计 §5.1：仅用户显式触发）

输入为用户选定的一组资料/页面（或某个分类下全部页面）。UI 与 CLI 均提供入口；**Agent 与 organizer 均不自动调用**。

### 4.2 合成管线

```
输入：页面 id 列表（或分类）
  → 读取各页正文（含资料 extracted_text 的来源，如页面过短）
  → 分块：按字符数切分，单块 ≤ 4000 字（给提示词留余量）
  → 逐块 LLM 归纳 → 合并归纳 → 生成综述正文（≤ 5000 字）
  → 落盘 outputs/wiki-syntheses/YYYY-MM-DD/<slug>.md
  → 写 wiki_syntheses 行（status='candidate'）
  → UI 审阅 → 接受：建 syntheses/ 页面（正文 = 链接引用 + 摘要）→ status='accepted'
```

### 4.3 关键设计点

1. **5000 字上限**（用户要求「每个文档不超过5000字」）：
   - 提示词约束 + 代码兜底：生成结果超限时截断到 5000 字并记 `error='truncated'`（不静默）；
   - 输入资料总量超单次上下文时走分块归纳（Map-Reduce 两段式），**逐块归纳是 LLM 调用次数的上界控制点**：块数 = ceil(总字数/4000)，归纳调用 + 生成调用。

2. **引用保真**（设计 §5.1）：提示词要求正文中的数字、日期、引述必须出自来源资料；接受前 UI 展示「来源清单」供用户抽查。P2 不做自动引用校验（需要向量/对齐能力，属 §6 之后的事），**以「来源清单 + 人工抽查」为保真手段**，此简化在 UI 文案中明示。

3. **落盘与链接引用**：
   - 输出目录 `outputs/wiki-syntheses/YYYY-MM-DD/`（沿用产物目录约定），文件名 slug 化中文标题（`encodeURIComponent` 风格或拼音不可行，采用「日期+短 id」前缀 + 清洗后的标题，冲突追加序号）；
   - 页面正文结构：
     ```markdown
     # {标题}
     > 本文由 AI 依据 N 份资料合成，源文件：[查看完整文档](outputs/wiki-syntheses/.../xxx.md)
     
     {5000 字以内的归纳正文}
     ```
   - 「标题 → 归纳性文档 → 源文件」链：页面标题 → 正文归纳 + 文档链接 → 文档内/页面「来源」区列出源页面与源文件链接（可点击跳转）。

4. **候选而非直接写入**（设计 §5.1）：合成结果先落候选，用户逐项接受/拒绝。接受后 `WikiRepo.savePage()` 建页（`editor='ai'`，path 落 `syntheses/`），同一事务更新 `wiki_syntheses.status`。

5. **落点约束**：`syntheses/` 不在 `AI_WRITABLE_CATEGORIES`，与 P1 概念页同理 —— 只走确认流程这一条路径。

### 4.4 分块与合并实现

```typescript
class WikiSynthesizer {
  constructor(repo: WikiRepo, callLLM: (prompt: string) => Promise<string>)
  async synthesize(agentId, userId, pageIds: string[]): Promise<string /* synthesisId */>
  // 内部：readInputs → chunkInputs(4000字/块) → summarizeChunks → generateFinal(5000字上限)
  //       → writeOutputFile → insertCandidate
}
```

- 分块边界取段落边界（遇 `\n\n` 就近断开），不硬切句子；
- 归纳调用串行（复用 P0 organizer 的限流理念，不并发抢 LLM 配额）；
- 失败留 `status='candidate'` + `error`，不产生半成品页面。

### 验证方式

- 单测 `wiki-synthesizer.test.ts`：分块边界（段落优先、上限不超）、超 5000 字截断+标记、空输入拒绝、slug 冲突追加序号
- 单测：接受建页路径合法、reject 后无页面产生
- 手工：选 3-5 页真实资料合成，验证归纳质量与来源清单可读

---

## 5. Task 2：合成/状态 IPC 命令 + CLI（1.5 天）

### 5.1 新命令清单

| 命令 | 职责 |
|------|------|
| `wiki:synthesis:create` | 发起合成（入参：页面 id 列表或分类名），返回 synthesisId |
| `wiki:synthesis:list` | 候选列表（按状态筛选） |
| `wiki:synthesis:get` | 读候选正文 + 来源清单（审阅用） |
| `wiki:synthesis:accept` | 接受 → 建 `syntheses/` 页 |
| `wiki:synthesis:reject` | 拒绝 |
| `wiki:graph:data` | 图谱数据（节点/边，限子图规模，见 Task 3） |
| `wiki:status:scan` | 页面状态扫描（Task 4，P2 后半随 C 交付） |
| `wiki:status:confirm` | 状态候选确认/拒绝 |

五步链路同 P1 Task 9：判别联合 → handler（`wiki-commands.ts` 或新文件 `wiki-synthesis-commands.ts`）→ 分派 → 白名单 → `useWikiPage` hook。

### 5.2 CLI 扩展

| 子命令 | 用途 |
|--------|------|
| `wiki synthesis create <pageIds...>` | 发起合成 |
| `wiki synthesis list [--status X]` | 候选列表 |
| `wiki synthesis accept <id>` / `reject <id>` | 审阅决策 |
| `wiki graph [--limit N]` | 图谱 JSON 数据（调试用） |

### 验证方式

- 白名单遗漏检测
- CLI 全流程：create → list → get → accept，退出码正确

---

## 6. Task 3：图谱视图（2.5 天）

### 位置

- 新建 `packages/agent-runtime/src/wiki/wiki-graph.ts`（`WikiGraphBuilder`，纯数据层）
- 前端：`MemoriesPage/components/WikiGraphView.tsx`（复用 `PipelineGraph.tsx` 的 xyflow+dagre 模式）

### 6.1 图谱数据源：先复用链接索引，ERO 模型按需（设计 §5.3 门槛）

设计 §5.3 的 ERO 最小模型（实体/观察/关系）发布门槛是「反链不足以发现跨页关系」。**当前阶段直接用 P1 的 `wiki_links` 表**：

- 节点 = 页面（title、path、category 着色区分：sources/media/inbox/concepts/entities/syntheses）；
- 边 = 已解析链接（有向）；
- 未解析链接不画边（数据里没目标）。

ERO 模型留待「反链导航确实不够」被观察到后再启动 —— 不在本计划排期，其表结构与抽取管线另行设计。

### 6.2 受限子图（设计 §5.3）

不渲染全库大图：

```
WikiGraphBuilder.buildSubgraph(agentId, userId, centerPageId | category, radius=1):
  { nodes, edges }
```

- 入口：某页的「查看图谱」（该页 ±1 跳邻居）；或按分类的局部图（节点数上限，默认 50，超出提示收窄范围）；
- 节点大小按 `use_count` 映射，边粗细分复用频次（简单视觉，不做 P2 之外的分析）。

### 6.3 前端视图

- 左栏新入口「图谱」：选择中心页或分类 → 渲染有向图（dagre 布局，参照 `PipelineGraph.tsx` 的布局调用）；
- 点击节点 → 右侧页面视图打开该页；
- 节点标签 = 标题（超长截断），颜色 = 分类；
- 空状态：无链接时提示「页面之间还没有链接，编辑页时用 [[标题]] 建立双链」。

### 验证方式

- 单测 `wiki-graph.test.ts`：1 跳子图边界、节点上限截断、方向正确、孤立节点处理
- 手工：真实库选中心页看图，点击跳转；双链图与反链列表数据一致

---

## 7. Task 4：页面状态扫描（1 天，C 能力规则层）

设计 §5.2 的状态变更「只能生成候选由用户确认」；矛盾检测分两层，**本计划只做低成本规则层**，语义层依赖向量（§9）。

### 7.1 规则层扫描

```typescript
scanPageStatus(agentId, userId): PageStatusCandidate[]
// 规则（全部无 LLM 调用）：
// 1. outdated 候选：来源文件已不存在（复用 P1 清理扫描的失效检测）
// 2. archived 候选：复用 P1 清理扫描的「长期未用」判定
// 3. doubtful 候选：否定表述规则 —— 正文含「已失效/已废弃/不再适用/已下线」等词，且页面非 inbox 类别
```

候选存 `wiki_index_meta`（key 前缀 `page_status_candidate:`），UI 列表逐项确认/拒绝，确认后更新 `wiki_pages.status`。

### 7.2 UI（随 Task 5 一并做）

清理视图内嵌「页面状态候选」分栏，或独立入口。**不做**语义漂移检测（向量前提不满足）。

### 验证方式

- 单测：三条规则命中/不命中；确认后 status 更新；拒绝清除候选
- 手工：真实库扫描，抽查候选合理性

---

## 8. Task 5：合成 UI + 状态候选 UI（1.5 天）

### 位置

`MemoriesPage/components/` 新增 `SynthesisView.tsx`（合成视图），WikiTab 左栏加入口。

### 8.1 合成视图

1. **发起区**：选择范围（分类全选 / 页面多选，复用页面列表勾选），显示选中页数与估算输入字数；
2. **进行中**：状态提示（逐块归纳进度：块 i/N）—— 进度由 IPC 轮询 `wiki:synthesis:list` 获取（合成是后台任务，命令返回 synthesisId 后由渲染端轮询状态）；
3. **审阅区**：候选正文（MDEditor preview 模式）+ 来源清单（可点击跳转源页）+ 完整文档链接；接受/拒绝按钮；
4. 接受的合成页在页面视图正常打开，正文下方「来源」区列出依据页面。

### 8.2 状态候选 UI

清理视图内分栏：候选列表（页面、建议状态、命中规则）→ 确认/拒绝。

### 验证方式

- 发起→进行中→审阅→接受 全流程
- 拒绝后候选保留在列表（可重新审阅）
- 窄窗口布局正常

---

## 9. 不排期能力：向量检索（D）与遗忘排序（E）

### 9.1 向量检索（设计 §5.4，发布门槛：金标集证明全文召回不足）

启动路径（达到门槛后）：

1. 建立中文+中英混合金标集（30-50 条查询，标注理想命中页）；
2. 引入本地嵌入运行时与多语言小模型（须支持中文；sherpa-onnx 为 ASR 专用不可复用，需评估 transformers.js 或 ONNX 嵌入模型）；
3. 向量层可关闭，失败降级全文检索且 UI 显式提示（无静默降级）；
4. 融合策略：倒数排名融合（RRF）；
5. 从少量页面线性相似度开始，性能瓶颈出现后再引入索引扩展；
6. 新增向量派生表并纳入 `WikiIndexRepo` 重建骨架。

**决策点**：P1+P2A/B 落地后，用真实库跑「全文检索失败的查询样本」评估；召回不足才启动。

### 9.2 遗忘曲线排序（设计 §5.5，无发布门槛）

公式实现（半天量，可随任何一轮顺手交付）：

```
score = recency_weight × 时间衰减 + importance_weight × log(1 + use_count)
衰减速率随 use_count 增长而减慢
```

服务检索排序、相关页面推荐与 P1 清理建议。`last_used`/`use_count` 已在检索与读取路径更新，无需数据层改动。

---

## 10. Task 6：测试与真实数据自测（2 天）

### 10.1 单测清单

| 测试点 | 覆盖内容 |
|--------|---------|
| synthesizer 分块 | 段落边界、4000 字上限、空输入 |
| synthesizer 截断 | 超 5000 字截断 + error 标记 |
| synthesis 状态流转 | candidate → accepted（建页+更新状态同事务）/ rejected（无页面） |
| slug 冲突 | 追加序号不覆盖 |
| graph builder | 1 跳边界、上限截断、方向、孤立节点 |
| status scanner | 三规则 + 确认/拒绝 |
| schema V19 | 迁移断言 |

### 10.2 E2E（手工）

选 3 页资料 → 发起合成 → 进度可见 → 审阅候选 → 接受 → `syntheses/` 页出现 → 来源清单可跳转 → 落盘 .md 存在且 ≤5000 字 → 图谱视图显示新页与链接 → 点击跳转。

### 10.3 真实数据自测

- 备份库：`cp ~/.lumii/data/lumii.db ~/.lumii/data/lumii.db.pre-p2.bak`
- 真实库合成一个主题（如「微信语音」相关页面），验证归纳质量、引用保真抽查、双链图谱
- 输出留档

---

## 11. 验收清单

**功能（A+B+C 规则层）**

- [ ] 合成仅能由用户显式触发（无任何自动调用路径）
- [ ] 每个合成文档 ≤5000 字，落盘到专用文件夹，页面经链接引用
- [ ] 「标题 → 归纳性文档 → 源文件」链完整可点
- [ ] 候选审阅流程完整：接受建页可溯源，拒绝保留记录
- [ ] 双链图谱视图可用：子图规模受限、点击跳转、与反链数据一致
- [ ] 页面状态候选仅规则层，确认后才更新

**质量**

- [ ] `pnpm typecheck` / `pnpm test` 全绿
- [ ] 向量检索、ERO 模型确认未实现（门槛未达）
- [ ] 未提交数据库、用户数据、密钥

---

## 12. 风险与回滚

| 风险 | 应对 |
|------|------|
| 合成质量差（归纳失真/幻觉） | 来源清单 + 人工抽查；候选确认制，坏结果不落库 |
| 5000 字上限被突破 | 代码兜底截断 + error 标记，UI 明示 |
| 大资料集合成 LLM 调用过多 | 分块归纳串行限流；单次合成块数上限（默认 20 块，超出提示分批） |
| 全库大图性能 | 受限子图（半径 1 / 节点上限 50），不渲染全库 |
| 落盘文件与库不一致（用户移动/删除） | 输出目录固定于 `outputs/wiki-syntheses/`；文件缺失时页面链接降级为失效提示 |
| 状态扫描误报 | 只生成候选不自动改；规则透明可解释 |

**回滚顺序**：`wiki_syntheses` 为增量表，`git revert` 即可；落盘文件独立于数据库，删库不影响文件、删文件不影响库（链接降级）。
