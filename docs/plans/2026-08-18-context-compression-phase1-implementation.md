# Context Compression Phase 1 Implementation Plan
# 上下文压缩多层化 Phase 1：Proactive Prune + 绝对阈值 Cap（稳定性 + 成本优化）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:**
落地第一道防线（Proactive Prune 三阶段剪枝）+ 最后一把闸（绝对 thresholdTokensCap），在 0.48× 窗口时用纯确定性操作回收垃圾 tokens，不触发 LLM 调用，并通过 Reclaim Gate + Rearm 跑道避免破坏 Prompt Cache 和抖动连续触发。零用户感知，纯内存操作，不改动现有 DB schema。

**Architecture:**
在现有 `MicroCompact`（0.60）之前插入 `Proactive Prune`，在 `micro-compact.ts` 内新增三个阶段函数 + 一个总包装。`checkCompactionNeeded` 在 `threshold = percent × window` 之后叠加 `min(thresholdTokensCap)`，并加 `<512K 窗口强制 ≥75%` 小窗口地板。`transform-context.ts` 闭包新增 `proactiveRearmTokens` 状态变量防止抖动。

**Tech Stack:**
TypeScript（strict）、Vitest、Node.js `crypto.createHash('md5')`、现有 `estimateTokenCount` 估算器、现有 logger

**规格:**
- 设计文档：`docs/design/2026-08-18-context-compression-multi-layer-engine.md`（v2.0）
- Hermes 参考实现（精确行号，移植时须对照）：
  - 三阶段剪枝：[context_compressor.py:L3491-L3611](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3491-L3611)
  - Reclaim Gate + Rearm：[context_compressor.py:L3690-L3801](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3690-L3801)
  - Cap 应用逻辑：[context_compressor.py:L2736-L2748](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L2736-L2748)

**范围锁：**
本 Phase 1 仅做以下 Task 1–5。
**不做：** Per-Model 阈值、Idle Compaction、ProgressFence、Commit Fence、DB 事务、压力降级 Pass 4、尾部保护区内部降级（以上均在 Phase 2/3）。

**验收基线（开发前先采集，记录到 Issue）：**
- 基线 A：工具密集型会话（bash + file_read × 30 次）每 100 轮的 `onCompaction(strategy=micro)` 触发次数
- 基线 B：连续压缩间隔 <3 turn 的次数 / 100 轮
- 基线 C：`contextWindow=1_000_000, triggerRatio=0.95` 时实际 `threshold` 值

---

### Task 1: CompactConfig 新增 4 个 Proactive + 1 个 Cap 字段（类型层）

**Files:**
- Modify: `packages/agent-runtime/src/compact/types.ts`（在 `CompactConfig interface` 内部追加）

**Step 1: 先运行现有类型测试，确认无回归（如有）**

```bash
cd packages/agent-runtime
# 确认 TypeScript 编译通过
npx tsc --noEmit
```

**Step 2: 追加字段到 `CompactConfig` interface（中文注释对齐现有风格）**

在现有 `postCompactRebuild?: PostCompactRebuild;` 之后、`}` 之前插入以下 5 个字段（保持字母/逻辑序）：

```typescript
/**
 * Proactive Prune 触发比例阈值（0-1），默认 0.48
 * 在 [proactivePruneRatio, microCompactRatio) 区间仅执行纯确定性剪枝（Dedup+Summarize+Truncate），
 * 不调用任何 LLM，早于 MicroCompact 动手。
 */
proactivePruneRatio?: number;
/**
 * Proactive Summarize 阶段仅处理「单条 tool 结果字符数 >= 此值」的大消息，默认 8000
 * 来源 Hermes proactive_prune_min_result_chars=8000，保证摘要比原文短不震荡。
 * 下界强制 200（对齐 _PRUNE_MIN_CHARS），负数/0 用默认。
 */
proactivePruneMinResultChars?: number;
/**
 * Reclaim Gate：Proactive Prune 实际回收 tokens 数 < 此值则不提交，原样返回 input，
 * 默认 4096。来源 Hermes proactive_prune_min_reclaim_tokens=4096。
 * 防止小打小闹破坏 Prompt Cache（Cache Miss 约 2~3× 成本差价）。
 * 0 关闭 gate（不推荐）；负数按 0。
 */
proactivePruneMinReclaimTokens?: number;
/**
 * Proactive Dedup 阶段最小字符阈值，默认 200
 * 单条 tool 结果 < 200 字符不参与 MD5 去重（MD5 元数据可能比原文还长）。
 * 来源 Hermes _PRUNE_MIN_CHARS=200（context_compressor.py:L537）。
 */
proactivePruneDedupMinChars?: number;
/**
 * 压缩触发阈值绝对天花板（tokens），默认 200_000
 * 最终 threshold = min(percentBasedThreshold, thresholdTokensCap)。
 * 无论 triggerRatio 配多大（例如 1M 窗口 0.95），最后一把闸拦下。
 * 来源 Hermes threshold_tokens_cap（context_compressor.py:L2736-L2748）。
 * 0/null 表示关闭（仅 ratio）。
 */
thresholdTokensCap?: number;
```

**Step 3: 确认编译通过**

```bash
npx tsc --noEmit
```

**Step 4: 提交**

```bash
git add packages/agent-runtime/src/compact/types.ts
git commit -m "feat(compact): CompactConfig 新增 proactivePrune 4 字段 + thresholdTokensCap"
```

---

### Task 2: `policy.ts` 接入 thresholdTokensCap + 小窗口地板（比例层 min 限制）

**Files:**
- Modify: `packages/agent-runtime/src/compact/policy.ts`（`checkCompactionNeeded` 函数）
- Create: `packages/agent-runtime/src/compact/policy.test.ts`（新建，若不存在；否则追加）

**Step 1: 先写失败测试（policy.test.ts）**

覆盖用例表格（每个用例一条 `it`，断言返回值 `.threshold` / `.needsCompaction`）：

| 用例名 | contextWindow | triggerRatio | cap | 输入 tokens | 预期 threshold | 预期 needsCompaction |
|--------|--------------|-------------|-----|------------|----------------|---------------------|
| 配错 1M 95% 被 Cap 拦下 | 1_000_000 | 0.95 | 200_000 | 250_000 | **200_000** | true |
| ratio 比 cap 小，取 ratio | 200_000 | 0.78 | 200_000 | 160_000 | 156_000 | true |
| 小窗口 128K 强制 75% 地板 | 128_000 | 0.70（故意低） | 200_000 | 96_000 | **96_000**（max(0.70,0.75)=0.75×128K） | true |
| 小窗口 128K 用户配 0.80 不被拉低 | 128_000 | 0.80 | 200_000 | 102_400 | 102_400 | true |
| cap=null 走纯 ratio | 1_000_000 | 0.78 | null | 780_000 | 780_000 | true |

**Step 2: 跑测试确认失败**

```bash
cd packages/agent-runtime
npx vitest run src/compact/policy.test.ts
```

**Step 3: 最小实现（修改 `checkCompactionNeeded`）**

现有代码在 `policy.ts:L63-L75`，按以下顺序堆叠（Hermes 语义对齐）：
1. 先解 percentThreshold：`config.triggerRatio`（原始用户配置）
2. 小窗口地板：**若 contextWindow < 512_000 → percentThreshold = max(percentThreshold, 0.75)**
3. 算 byPercent = `Math.floor(contextWindow × percentThreshold)`
4. 若 cap 存在且 > 0 → `threshold = Math.min(byPercent, cap)`
5. 否则 threshold = byPercent

**中文日志/注释要求：** 在计算步骤前加一行注释说明堆叠顺序；改动 < 15 行。

**Step 4: 测试通过后提交**

```bash
npx vitest run src/compact/policy.test.ts
git add packages/agent-runtime/src/compact/policy.ts packages/agent-runtime/src/compact/policy.test.ts
git commit -m "feat(compact): checkCompactionNeeded 新增 thresholdTokensCap min 限制 + <512K 小窗口 75% 地板"
```

---

### Task 3: `micro-compact.ts` 新增 Dedup + Truncate Arguments 两个阶段函数

**Files:**
- Modify: `packages/agent-runtime/src/compact/strategies/micro-compact.ts`
- Create: `packages/agent-runtime/src/compact/strategies/micro-compact-phase1.test.ts`

**Step 1: 写失败测试（先写）**

A) Dedup 用例（`describe('dedupIdenticalToolResults')`）：
- 3 条 `toolName=file_read`、content=`repeat('x', 3000)` 完全相同 + 1 条不同 + 1 条 content 150 字（<200 跳过）→ 断言：只保留最老/最新一条原文，其余 2 条 content 等于 `[工具结果与更近期调用完全一致，已去重以节省空间]`
- **关键断言**：非 tool role 的消息（user/assistant）绝对不动
- **关键断言**：相同字符串但 <200 字符的不 dedup（避免 MD5 头比原文长）

B) Truncate Arguments 用例（`describe('truncateHeavyToolCallArguments')`）：
- 构造 assistant 消息，含 `tool_calls[0].function.arguments = JSON.stringify({ content: 'x'.repeat(10000), path: 'a.txt' })` → 截断后 arguments 必须是 **合法 JSON**（`JSON.parse(newArgs)` 不 throw），且 `content` 字段长度 ≤ 1500（前后缀 + `...`），`path` 字段不截断
- protectTailCount=20：最后 20 条内的 assistant 不 truncate，超出的才动

**Step 2: 跑失败测试**

```bash
cd packages/agent-runtime
npx vitest run src/compact/strategies/micro-compact-phase1.test.ts
```

**Step 3: 最小实现（micro-compact.ts 内追加函数，严格对齐 Hermes）**

**函数 A：`dedupIdenticalToolResults`**（对齐 Hermes L3491-L3515）
- 遍历方向：**从末尾向前**（保证「最新那条保留原文，老的被去重」）
- 哈希：`crypto.createHash('md5').update(content).digest('hex').slice(0,12)`（12 位十六进制，碰撞率可忽略）
- 去重文案：`[工具结果与更近期调用完全一致，已去重以节省空间]`（中文，对齐现有 Lumii 风格）
- 跳过条件：role !== 'toolResult' / typeof content !== 'string' / content.length < dedupMinChars（默认 200）/ content 已以 `[Duplicate` 或 `[工具结果` 开头
- 纯函数：返回新数组，不改 input（满足 `===` 不变性）

**函数 B：`truncateHeavyToolCallArguments`**（对齐 Hermes L3578-L3596 + `_truncate_tool_call_args_json`）
- 仅处理 role='assistant' 且含 `tool_calls` 的消息
- 对每条 tool_call 的 `function.arguments`：先 `JSON.parse`，递归遍历所有字符串值，对长度 > maxCharsPerArg（默认 1500）的字符串截断为「前 700 + `...（已截断 ${N}字符）` + 后 700」，再 `JSON.stringify`
- **关键不变式**：输出 arguments 必须可被 `JSON.parse`（否则下游 provider 400）
- protectTailCount：最后 N 条 assistant 跳过（由 index 判定：`i < messages.length - protectTailCount`）

**Step 4: 测试通过后提交**

```bash
npx vitest run src/compact/strategies/micro-compact-phase1.test.ts
git add packages/agent-runtime/src/compact/strategies/micro-compact.ts packages/agent-runtime/src/compact/strategies/micro-compact-phase1.test.ts
git commit -m "feat(compact): proactive phase1 新增 dedupIdenticalToolResults + truncateHeavyToolCallArguments"
```

---

### Task 4: `proactivePrune` 总包装 + Reclaim Gate + Rearm 计算

**Files:**
- Modify: `packages/agent-runtime/src/compact/strategies/micro-compact.ts`（追加 `proactivePrune` 主函数）
- Create: `packages/agent-runtime/src/compact/strategies/proactive-prune.test.ts`

**Step 1: 写失败测试（先写，这是 Phase 1 核心用例）**

| 用例 | 构造 | 断言 |
|------|------|------|
| 三阶段实际提交 | 3000 tokens × 3 相同 bash（去重 2 条）+ 50KB write_file arguments 1 条 + protectTail=20 → 回收 > 4096 | 返回 `changed=true`，`nextRearmTokens = after + max(reclaimed, triggerTokens, 4096)` |
| Reclaim Gate 拒绝（回收 3000 < 4096） | 只构造小回收，after - before = 3000 | **返回对象是原 input 引用**：`result.messages === input`，`changed=false` |
| Rearm 防抖动 | 先跑一次：before=48K, after=40K, reclaimed=8K → nextRearmTokens=48K；再构造 42K 跑第二次 | 第二次 `before(42K) < rearm(48K)` → 直接 return input，不扫描 |
| Rearm 后再涨到阈值可触发 | 接着上例，构造 before=49K 跑第三次 | **可以触发**，不被 rearm 挡 |
| Dedup 全范围（含 tail）无损失 | 3 条相同 file_read，其中 2 条在最后 20 条 tail 内 | 全部 dedup 正确，只保留最新一条；tail 内 dedup 合法（因为无损） |
| Summarize 复用 buildDeterministicToolSummary（Phase 1 复用） | 用 COMPACTABLE_TOOLS 白名单，构造 30 条 file_read 大输出 | protectTailCount=20 之外的 10 条被替换为 `[工具结果已归档…]` 微摘要；不是纯占位符 |

**Step 2: 跑失败测试确认**

```bash
npx vitest run src/compact/strategies/proactive-prune.test.ts
```

**Step 3: 最小实现（严格对齐 Hermes prune_tool_results_only 7 道 Gate）**

`proactivePrune` 主函数签名：
```typescript
export function proactivePrune(
  messages: AgentMessage[],
  opts: {
    contextWindow: number;
    proactivePruneRatio?: number;       // 默认 0.48
    proactivePruneMinResultChars?: number; // 默认 8000，强制下界 200
    proactivePruneMinReclaimTokens?: number; // 默认 4096
    proactivePruneDedupMinChars?: number; // 默认 200
    protectLastN?: number;              // 默认 20，来源 Hermes protect_last_n=20 (L2813)
    keepRecentToolResults?: number;     // 复用 microCompact 的 keepRecent（默认 20，比原 MicroCompact 的 8 大）
    currentRearmTokens?: number | null; // 闭包传入的 rearm 状态
  },
): {
  messages: AgentMessage[];  // 通过 gate → 新数组；拒绝 → 原 input 引用
  changed: boolean;
  reclaimedTokens: number;   // before - after
  nextRearmTokens: number | null;  // 通过 gate → 计算后的值；拒绝 → null
  passStats: { dedupedCount: number; summarizedCount: number; truncatedArgsCount: number };
}
```

**Gate 执行顺序（与 Hermes 对应）：**
1. Gate 1：若 ratio 计算后 triggerTokens ≤ 0 → return input
2. Gate 2：`estimateTokenCount(messages) < triggerTokens` → return input
3. Gate 3：`messages.length <= protectLastN + 3`（还没超出 head+tail）→ return input
4. Gate 4：**⭐ Rearm 跑道未到**（`currentRearmTokens != null && before < currentRearmTokens`）→ **连扫描都不做，直接 return input**（Hermes L3738-L3740 语义）
5. 执行三阶段：
   - Pass 1：`dedupIdenticalToolResults(result, dedupMinChars)`——**全范围，不保护 tail（无损）**
   - 确定 prune_boundary = `messages.length - protectLastN`
   - Pass 2：复用现有 `microcompactToolResults()`，但传 `keepRecentToolResults=protectLastN`、`useSummary=true`——仅作用于 prune_boundary 之前
   - Pass 3：`truncateHeavyToolCallArguments(result, protectLastN)`——仅作用于 prune_boundary 之前
6. Gate 5：三阶段 0 改动 → return input
7. 算 `reclaimed = max(0, before - after)`
8. Gate 6：**⭐ Reclaim Gate** `reclaimed < minReclaimTokens` → return **原 input 引用**（Hermes L3763-L3769，**必须 `=== input`，不能返回没改动的新数组**）
9. **⭐ 计算 Rearm 跑道**：
   ```typescript
   const runway = Math.max(
     reclaimed,
     Math.floor(contextWindow * (proactivePruneRatio ?? 0.48)),  // trigger size
     minReclaimTokens,
   );
   const nextRearmTokens = after + runway;
   ```
10. 返回新数组 + changed=true + nextRearmTokens

**日志要求：**
- Gate 4/Rearm 挡下时 logger.debug 打印原因
- 三阶段后统计 `passStats.dedupedCount/summarizedCount/truncatedArgsCount`
- 通过 Gate 6 提交时 logger.info 打印：`ProactivePrune 提交: Dedup X 条 + Summarize Y 条 + TruncateArgs Z 条，回收 ${reclaimed} tokens（before=${before}→after=${after}，runway=${runway}，下次触发阈值 nextRearmTokens=${nextRearmTokens}）`
- Gate 6 拒绝时 logger.debug 打印：`ProactivePrune 回收不足 Gate 拒绝：${reclaimed} < ${minReclaimTokens}，不提交以保留 Prompt Cache`

**Step 4: 测试通过后提交**

```bash
npx vitest run src/compact/strategies/proactive-prune.test.ts
git add packages/agent-runtime/src/compact/strategies/micro-compact.ts packages/agent-runtime/src/compact/strategies/proactive-prune.test.ts
git commit -m "feat(compact): proactivePrune 总包装 + Reclaim Gate 4096 + Rearm 跑道计算（对齐 Hermes 7 道 Gate）"
```

---

### Task 5: `transform-context.ts` 闭包接入 + 端到端集成验证

**Files:**
- Modify: `packages/agent-runtime/src/compact/transform-context.ts`
- Create: `packages/agent-runtime/src/compact/transform-context-phase1.test.ts`（集成用例）

**Step 1: 写失败集成测试**

| 用例 | 构造 | 断言 |
|------|------|------|
| 0.48≤tokens<0.60 区间触发 Proactive，不触发 Micro | tokens=0.54×window，构造大量可 dedup 工具结果 | onCompaction 回调收到 **strategy='proactive'**，usedSummary=false |
| tokens<0.48 什么都不做 | tokens=0.40×window | onCompaction 不被调用，返回消息 === input 引用 |
| 连转两轮 48K→40K→42K：第二轮 Rearm 挡下不触发 | 见 Task 4 用例 | 第二次 transform 返回 input 引用，onCompaction 不触发 |
| 0.60≤tokens<0.78：Proactive（先跑一轮）→ MicroCompact（再跑一轮）级联 | tokens=0.70×window | 日志里先看到 ProactivePrune 提交，再看到 MicroCompact 触发 |

**Step 2: 跑集成测试确认失败**

```bash
npx vitest run src/compact/transform-context-phase1.test.ts
```

**Step 3: 最小实现（插入 transform-context.ts:L114-L117 之间）**

**闭包状态新增**（在 `turnCounter` 之后附近）：
```typescript
/** Proactive Prune Rearm 跑道状态：下次再触发前 tokens 必须涨到 >= 此值（Phase 1 进程内） */
let proactiveRearmTokens: number | null = null;
```

**在 `if (!estimation.needsCompaction) {` 块内部、`// 第一级 MicroCompact` 注释之前插入 Proactive 判断**：

```typescript
// 【Phase 1 新增】Proactive Prune：在 [0.48, 0.60) 区间先动手三阶段纯确定性剪枝，
// 不调用 LLM，早于 MicroCompact，通过 Reclaim Gate 才提交，Rearm 防抖动
const proactivePruneRatio = config.proactivePruneRatio ?? 0.48;
const proactiveThreshold = Math.floor(config.contextWindow * proactivePruneRatio);
if (estimation.totalTokens >= proactiveThreshold) {
  const pr = proactivePrune(working, {
    contextWindow: config.contextWindow,
    proactivePruneRatio: config.proactivePruneRatio,
    proactivePruneMinResultChars: config.proactivePruneMinResultChars,
    proactivePruneMinReclaimTokens: config.proactivePruneMinReclaimTokens,
    proactivePruneDedupMinChars: config.proactivePruneDedupMinChars,
    protectLastN: 20,
    keepRecentToolResults: 20,
    currentRearmTokens: proactiveRearmTokens,
  });
  if (pr.changed) {
    proactiveRearmTokens = pr.nextRearmTokens!;
    // 不调用 onCompaction（Proactive 是后台静默清理，不暴露 UI 事件）
    // 但是要 finalizeHistoryMessages
    return finalizeHistoryMessages(pr.messages, config, "ProactivePrune-三阶段剪枝");
  } else if (pr.nextRearmTokens !== null) {
    // Gate 挡下了但算好了下次 rearm（实际不发生，当前实现 nextRearmTokens 只有 changed 时非空；留注释防未来坑）
  } else {
    // Gate 挡下（含 rearm 跑道未到）→ 更新 rearm 状态？不需要，保持原 rearm
  }
}
```

**⚠️ 关键不变性校验：** 必须保证 `proactivePrune` 在 Gate 挡下时返回的 `messages === working`（即不新建数组），这样 `finalizeHistoryMessages(working, ...)` 走基准路径，Prompt Cache 不失效。

**Step 4: 集成测试 + 全量 compact 子系统回归**

```bash
# Phase 1 专项
npx vitest run src/compact/policy.test.ts src/compact/strategies/micro-compact-phase1.test.ts src/compact/strategies/proactive-prune.test.ts src/compact/transform-context-phase1.test.ts
# 回归
npx vitest run src/compact
```

**Step 5: 验收基线对比（开发完填数字）**

| 指标 | 基线 | 验收目标 | 实际值（填） |
|------|------|---------|-------------|
| 工具型会话每 100 轮 Micro 触发数 | 待填 | ↓≥30% |  |
| 连续 <3 turn 再压缩次数 / 100 轮 | 待填 | **0** |  |
| 1M 窗口 95% 时 threshold | 950K | **≤200K** |  |

**提交**

```bash
git add packages/agent-runtime/src/compact/transform-context.ts packages/agent-runtime/src/compact/transform-context-phase1.test.ts
git commit -m "feat(compact): transform-context 接入 Proactive Prune（MicroCompact 之前）+ Phase 1 验收用例通过"
```

---

## Phase 1 最终交付检查清单（Review 时一项项勾）

- [ ] CompactConfig 5 个新字段都有中文 JSDoc，默认值写明 Hermes 来源
- [ ] checkCompactionNeeded 堆叠顺序：Per-Model→ratio→小窗口地板→**最后 cap min**；小窗口 <512K 强制 ≥75%
- [ ] Dedup 方向：从后向前，最新保留，老的改引用；<200 字符不参与；非 tool role 不动
- [ ] Truncate Arguments 输出必须 `JSON.parse()` 通过；最后 20 条保护
- [ ] proactivePrune **7 道 Gate 完整**：含 Gate4 Rearm（连扫描都不做）、Gate6 Reclaim <4096（返回原 input 引用，`===` 必须成立）
- [ ] Rearm 跑道 = `after + max(reclaimed, trigger, minReclaim)`，三者取 max 正确
- [ ] transform-context 插入位置在 MicroCompact 判断之前；回调不触发 onCompaction（后台静默）
- [ ] 全部 4 个 test 文件通过；全量 `src/compact` Vitest 回归 0 失败
- [ ] TypeScript strict `tsc --noEmit` 通过
- [ ] 日志信息含中文，关键决策点（Gate 挡下 / 通过提交 / 跑道计算）都打 logger.info/debug
