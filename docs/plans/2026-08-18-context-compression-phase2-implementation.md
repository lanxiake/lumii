# Context Compression Phase 2 Implementation Plan
# 上下文压缩多层化 Phase 2：Per-Model 阈值 + Idle Compaction + ProgressFence 双预算（体验优化 + 模型适配）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**前置依赖：** Phase 1 已全部完成并通过验收（proactivePrune / thresholdTokensCap / Rearm / Reclaim Gate 合入）。

**Goal:**
落地三道防线：Per-Model 阈值（最长子串匹配，小/大/超大模型各配各的）、Idle Compaction（用户离开 300s 后台静默压，回来第一条消息不卡）、ProgressFence + withProgressTimeout（idle 120s + ceiling 600s 双预算 + touch_progress 流式续命，慢模型不被墙钟误杀，省 90% 误杀浪费的钱）。

**Architecture:**
- **Per-Model**：在 `policy.ts` 新增 `resolveModelThreshold`，在 Agent 每轮 prompt 前把 `config.model.name` 注入 `CompactConfig.currentModelName`。
- **Idle Compaction（桌面端适配）**：不同于 Hermes「用户回来发消息时阻塞先压」，Lumii 桌面端用「后台 cron 60s 轮询所有会话 + 用户活动 IPC 更新 lastActivityAt」。新增 `idle-trigger.ts` 纯谓词（可单测）。
- **ProgressFence**：新建 `progress-fence.ts`，包含 ProgressFence 类（touchProgress / nextWaitSliceMs / shouldKeepAlive）+ `withProgressTimeout` 异步包装器。`summary-compact.ts` 把 `runSummaryStage` 从简单 timeout 改接 while + wait_slice。

**Tech Stack:**
TypeScript strict、Vitest、现有 `cron-scheduler.ts`（主进程已有基础设施）、现有 `session-manager.ts`、IPC `handleInbound` 事件、现有 `bridge.compactContextAsync`、SummaryGeneratorFn 协议扩展 onProgress。

**规格:**
- 设计文档：`docs/design/2026-08-18-context-compression-multi-layer-engine.md`（v2.0，§3）
- Hermes 参考实现（精确行号，移植时须对照）：
  - Per-Model 最长子串匹配：[context_compressor.py:L1820-L1843](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L1820-L1843)
  - Idle 纯谓词 4 条件 AND：[turn_context.py:L368-L400](file:///D:/open-source/hermes-agent/agent/turn_context.py#L368-L400)
  - Idle 实际触发：[turn_context.py:L782-L851](file:///D:/open-source/hermes-agent/agent/turn_context.py#L782-L851)
  - ProgressFence 核心字段 / 方法：[conversation_compression.py:L457-L505](file:///D:/open-source/hermes-agent/agent/conversation_compression.py#L457-L505)
  - 等待循环 + 动态 wait_slice + 续命：[conversation_compression.py:L943-L973](file:///D:/open-source/hermes-agent/agent/conversation_compression.py#L943-L973)

**范围锁：**
本 Phase 2 仅做以下 Task 1–5。
**不做：** beginCommit() / finishCommit() / commitPhase（Phase 3）、SQLite 事务、failure_cooldown、anti_thrash、Hermes Pass 4 压力降级（全部在 Phase 3）。

**验收基线：**
- 基线 A：小窗口 qwen2.5-7b（8K）每 100 轮达到 7K+ 才压缩的占比（预期 Phase 1/现状 = 100%，一刀切 0.78 = 6240）
- 基线 B：用户闲置 301s 后回来发第一条消息，端到端等待时间（含摘要 = 30~60s）
- 基线 C：模拟摘要流式输出每 5s 一个 token，连续 119s，被墙钟 120s 超时误杀的概率 = 100%

---

### Task 1: Per-Model 阈值（modelThresholds + currentModelName + resolveModelThreshold）

**Files:**
- Modify: `packages/agent-runtime/src/compact/types.ts`（CompactConfig 加 2 字段）
- Modify: `packages/agent-runtime/src/compact/policy.ts`（新增 resolveModelThreshold，接 checkCompactionNeeded）
- Modify: `packages/agent-runtime/src/agent/agent-instance.ts`（每轮 prompt 前注入 currentModelName）
- Create / Append: `packages/agent-runtime/src/compact/policy.test.ts`（Per-Model 用例）

**Step 1: 先写失败测试（policy.test.ts 追加）**

| 用例 | modelName | modelThresholds | default triggerRatio | 预期 resolve 结果 |
|------|-----------|-----------------|---------------------|------------------|
| 更长 key 优先命中 | `"claude-sonnet-4-20250514"` | `{ "claude": 0.50, "claude-sonnet": 0.35 }` | 0.78 | **0.35** |
| 不匹配回退 default | `"gpt-5-6-1M"` | `{ "claude": 0.50 }` | 0.78 | 0.78 |
| key 完全相等匹配 | `"qwen2.5-7b"` | `{ "qwen2.5-7b": 0.70 }` | 0.78 | 0.70 |
| 空 dict / 空 name 回退 | `""` | `{}` | 0.78 | 0.78 |
| null thresholds 回退 | `"qwen2.5"` | `null` | 0.78 | 0.78 |

**Step 2: 跑测试失败**

```bash
cd packages/agent-runtime
npx vitest run src/compact/policy.test.ts
```

**Step 3: 最小实现**

**A) types.ts 加 2 个字段到 CompactConfig（中文 JSDoc）：**
```typescript
/**
 * 模型名→压缩触发比例的映射（最长子串匹配，更长的 key 优先）
 * 例：{ "claude-sonnet": 0.35, "gpt-5.6-1M": 0.60, "qwen2.5-7b": 0.70 }
 * 小模型（<32K）建议配高比例（70%），超大模型建议配低比例（35~50%）。
 * 对齐 Hermes resolve_model_threshold（context_compressor.py:L1820-L1843）。
 */
modelThresholds?: Record<string, number>;
/**
 * 当前轮次使用的模型名（每轮 prompt 前由 AgentInstance 注入）
 * 用于 resolveModelThreshold 查表。未注入时回退全局 triggerRatio。
 */
currentModelName?: string;
```

**B) policy.ts 新增 resolveModelThreshold（直接移植 Hermes Python → TS）：**
```typescript
/**
 * 模型阈值匹配：最长子串匹配算法（更长的匹配 = 更具体 = 优先）
 * 移植 Hermes resolve_model_threshold（L1820-L1843）。
 * @param modelName 当前模型全名（如 "claude-sonnet-4-20250514"）
 * @param modelThresholds 配置映射（如 { "claude-sonnet": 0.35 }）
 * @param defaultRatio 未命中时回退值（CompactConfig.triggerRatio）
 */
export function resolveModelThreshold(
  modelName: string | undefined,
  modelThresholds: Record<string, number> | undefined,
  defaultRatio: number,
): number {
  // 移植：if not model_thresholds or not model: return default
  if (!modelThresholds || !modelName) return defaultRatio;
  let bestKey = "";
  for (const key of Object.keys(modelThresholds)) {
    // 移植：if key in model and len(key) > len(best_key): best_key = key
    if (modelName.includes(key) && key.length > bestKey.length) {
      bestKey = key;
    }
  }
  if (bestKey) {
    return Number(modelThresholds[bestKey]);
  }
  return defaultRatio;
}
```

**C) 修改 checkCompactionNeeded 第一行接入：**
```typescript
// 在 const threshold = Math.floor(...) 之前：
const percentThreshold = resolveModelThreshold(
  config.currentModelName,
  config.modelThresholds,
  config.triggerRatio,
);
// 原 triggerRatio → 替换为 percentThreshold
```

**D) agent-instance.ts 注入 currentModelName：**
在 `agent-instance.ts`（prompt 前，构造 compactConfig 时）追加：
```typescript
// 把当前模型名注入 compact，供 Per-Model 匹配
compactConfig.currentModelName = config.model?.name ?? "";
```

**Step 4: 测试通过后提交**

```bash
npx vitest run src/compact/policy.test.ts
npx tsc --noEmit
git add packages/agent-runtime/src/compact/types.ts packages/agent-runtime/src/compact/policy.ts packages/agent-runtime/src/agent/agent-instance.ts packages/agent-runtime/src/compact/policy.test.ts
git commit -m "feat(compact): Per-Model 阈值最长子串匹配（modelThresholds + currentModelName 注入）"
```

---

### Task 2: CompactConfig 加 idleCompactAfterSeconds + idle-trigger 纯谓词

**Files:**
- Modify: `packages/agent-runtime/src/compact/types.ts`（加 2 个 idle 字段）
- Create: `packages/agent-runtime/src/compact/idle-trigger.ts`（纯谓词 + 测试）
- Create: `packages/agent-runtime/src/compact/idle-trigger.test.ts`

**Step 1: 写 idle-trigger.test.ts（先写，对应 Hermes L368-L400）**

| 用例 | enabled | idleAfter | idleGap | tokens | floorTokens | cooldown | 预期返回 |
|------|---------|-----------|---------|--------|-------------|----------|---------|
| 关闭 enabled=false | false | 300 | 10000 | 100K | 20K | false | **false** |
| 关闭 idleAfter=0 | true | 0 | 10000 | 100K | 20K | false | **false** |
| 时间不够 299s < 300s | true | 300 | 299 | 100K | 20K | false | **false** |
| 时间刚到 301s ✓ | true | 300 | 301 | 100K | 20K | false | **true** |
| cooldown 激活（上次失败在冷却内） | true | 300 | 301 | 100K | 20K | true | **false** |
| tokens=5K < floor=20K 压了也白压 | true | 300 | 301 | 5000 | 20000 | false | **false** |
| tokens=21K > floor=20K ✓ | true | 300 | 301 | 21000 | 20000 | false | **true** |

**Step 2: 失败测试**

```bash
npx vitest run src/compact/idle-trigger.test.ts
```

**Step 3: 最小实现**

**A) types.ts CompactConfig 加字段：**
```typescript
/**
 * Idle Compaction：挂钟空闲 N 秒后触发后台压缩，默认 300s（5 分钟）
 * 设为 0 / undefined = 关闭。对齐 Hermes idle_compact_after_seconds。
 * 过小（<60s）会导致"倒杯水回来就触发"的过度压缩。
 */
idleCompactAfterSeconds?: number;
/**
 * Idle Compaction：压缩目标地板 tokens（比这个还小就不压，免得空跑花时间）
 * 默认 = threshold × summaryTargetRatio（≈ threshold × 0.20）。
 * 对齐 Hermes _idle_floor 计算（turn_context.py:L794-L796）。
 */
idleCompactFloorTokens?: number;
```

**B) idle-trigger.ts 实现纯谓词：**
```typescript
/**
 * Idle Compaction 触发判断：纯谓词，4 条件 AND，可单测。
 * 移植 Hermes _should_idle_compact（turn_context.py:L368-L400）。
 * @returns true 表示可以跑后台压缩
 */
export function shouldIdleCompact(params: {
  enabled: boolean;
  idleAfterSeconds: number;
  idleGapSeconds: number;  // 实际挂钟间隙 = now - lastActivityAt
  tokens: number;          // 当前会话估算 tokens
  floorTokens: number;     // 目标地板（比这个小就不压）
  cooldownActive: boolean; // 是否在失败冷却中（Phase3 才启用，Phase2 恒 false）
}): boolean {
  const { enabled, idleAfterSeconds, idleGapSeconds, tokens, floorTokens, cooldownActive } = params;
  // ① 开关未开/0 → 不做
  if (!enabled || idleAfterSeconds <= 0) return false;
  // ② 挂钟间隙未到 → 不做
  if (idleGapSeconds < idleAfterSeconds) return false;
  // ③ 冷却中 → 不做
  if (cooldownActive) return false;
  // ④ 上下文比地板还小 → 不压
  return tokens > floorTokens;
}
```

**Step 4: 测试通过后提交**

```bash
npx vitest run src/compact/idle-trigger.test.ts
git add packages/agent-runtime/src/compact/types.ts packages/agent-runtime/src/compact/idle-trigger.ts packages/agent-runtime/src/compact/idle-trigger.test.ts
git commit -m "feat(compact): Idle Compaction shouldIdleCompact 纯谓词 + idleCompactAfterSeconds 配置"
```

---

### Task 3: 桌面端 lastActivityAt 维护 + cron 60s 轮询后台压

**Files:**
- Modify: `apps/windows/src/main/channel/session-manager.ts`（每个会话加 lastActivityAt 字段 + 每次 inbound 更新）
- Modify: `apps/windows/src/main/agent-runtime/cron-scheduler.ts`（追加 60s idle scan 任务）
- Modify: `apps/windows/src/main/agent-runtime/bridge.ts`（新增 tryIdleCompact 内部方法）
- Create: `apps/windows/src/main/agent-runtime/idle-compact.test.ts`（集成模拟，用 fake timers）

**Step 1: 写集成测试（idle-compact.test.ts，sinon fake timers 或 vitest.useFakeTimers）**

| 用例 | 构造 | 断言 |
|------|------|------|
| 会话空闲 301s → 触发 idle compact | lastActivityAt=now-301s，tokens=100K，floor=20K，enabled=true | bridge.compactContextAsync 被调用 1 次 |
| 会话空闲 299s → 不触发 | lastActivityAt=now-299s | 不调 compactContextAsync |
| 用户 1 秒前有活动（<3s）→ 撞车放弃 | idleGap=301s 但 lastActivityAt 又在 cron 扫描前被 IPC 更新到 1s 前 | 判断放弃，不调 compact |
| isCompacting 锁激活 → 跳过 | 同一会话已有 compact 在跑 | 第二次 cron 周期跳过 |
| tokens=5K < floor → 不压 | lastActivityAt=10 分钟前，tokens=5K | 不调 compact |

**Step 2: 跑失败测试**

```bash
cd apps/windows
npx vitest run src/main/agent-runtime/idle-compact.test.ts
```

**Step 3: 最小实现（按文件拆分）**

**A) session-manager.ts 维护 lastActivityAt：**
- Session 类型追加 `lastActivityAt: number`（ms 时间戳）
- 在每次 `handleInbound()`（用户发消息）、会话焦点切换、UI 点击等事件入口处：`session.lastActivityAt = Date.now()`

**B) bridge.ts 新增 tryIdleCompact(sessionKey): boolean：**
```typescript
/**
 * 尝试对某会话执行 Idle 后台压缩（非阻塞，异步调度）
 * 返回：true = 已提交执行；false = 被条件 Gate 拒绝
 */
async tryIdleCompact(sessionKey: string): Promise<boolean> {
  const session = sessionManager.get(sessionKey);
  if (!session) return false;
  // 撞车检查：用户最近 3 秒内刚有活动 → 放弃（否则后台压 + 前台跑 = 双倍 LLM 开销）
  const gapSec = (Date.now() - session.lastActivityAt) / 1000;
  if (gapSec < 3) {
    logger.debug(`IdleCompact 放弃[撞车用户活动]：会话 ${sessionKey} 仅空闲 ${gapSec.toFixed(0)}s < 3s`);
    return false;
  }
  // isCompacting 锁（已存在 compactContextAsync 内的锁，复用）
  if ((session as any).isCompacting) {
    logger.debug(`IdleCompact 放弃[锁占用]：会话 ${sessionKey}`);
    return false;
  }
  // 调 shouldIdleCompact 纯谓词
  const tokens = estimateTokenCount(session.messages);
  const threshold = Math.floor(session.config.contextWindow * 0.78); // 或 Phase1 算过的最终 threshold
  const floor = session.compactConfig.idleCompactFloorTokens
    ?? Math.floor(threshold * 0.20);  // Hermes _idle_floor = threshold × summary_target_ratio ≈ ×0.20
  const should = shouldIdleCompact({
    enabled: (session.compactConfig.idleCompactAfterSeconds ?? 0) > 0,
    idleAfterSeconds: session.compactConfig.idleCompactAfterSeconds ?? 0,
    idleGapSeconds: gapSec,
    tokens,
    floorTokens: floor,
    cooldownActive: false,  // Phase 2 恒 false，Phase 3 加冷却
  });
  if (!should) return false;
  logger.info(
    `IdleCompaction 触发：会话 ${sessionKey} 空闲 ${gapSec.toFixed(0)}s ≥ ${session.compactConfig.idleCompactAfterSeconds}s，` +
    `tokens ${tokens} > floor ${floor}，后台异步压缩中`
  );
  // 异步调 compactContextAsync（**不 await**，后台非阻塞跑）
  setImmediate(async () => {
    try {
      await this.compactContextAsync(sessionKey);
      logger.info(`IdleCompaction 完成：会话 ${sessionKey}`);
      // UI Toast（可选）：广播 onCompaction 事件 + idle=true 标记，Renderer 可选显示
    } catch (err) {
      logger.error(`IdleCompaction 失败：会话 ${sessionKey}，err=${err}`);
      // Phase 3 在这里设 failure_cooldown
    }
  });
  return true;
}
```

**C) cron-scheduler.ts 追加 60s idle scan：**
在现有 60s cron 任务的回调中追加：
```typescript
// Idle Compaction 后台扫描：遍历所有非活跃会话（每 60s 一次）
for (const sessionKey of sessionManager.listSessionKeys()) {
  try {
    await bridge.tryIdleCompact(sessionKey);
  } catch (err) {
    logger.error(`IdleCompact cron 扫描异常 ${sessionKey}: ${err}`);
  }
}
```

**Step 4: 测试通过 + 手动验证（开发机）**
- 打开 DevTools，会话闲置 5 分钟 → 看主进程日志 `IdleCompaction 触发：...`
- 在 4 分钟时发一条消息 → 重置 lastActivityAt → 再等 1 分钟（= 总 5 分钟但间隙 1 分钟）→ **不触发**
- 回来发第一条消息 → **不等待压缩**（后台已经压完了）

**提交**

```bash
git add apps/windows/src/main/channel/session-manager.ts apps/windows/src/main/agent-runtime/cron-scheduler.ts apps/windows/src/main/agent-runtime/bridge.ts apps/windows/src/main/agent-runtime/idle-compact.test.ts
git commit -m "feat(compact): Idle Compaction 桌面端落地：lastActivityAt 维护 + cron 60s 扫描 + bridge.tryIdleCompact"
```

---

### Task 4: ProgressFence 类 + withProgressTimeout 包装器（新建文件）

**Files:**
- Create: `packages/agent-runtime/src/compact/progress-fence.ts`（含类 + 包装器）
- Create: `packages/agent-runtime/src/compact/progress-fence.test.ts`（fake timers）

**Step 1: 写测试（vitest.useFakeTimers）**

| 用例 | 构造 | 断言 |
|------|------|------|
| touchProgress 续命：每 5s 调一次，200s 后 shouldKeepAlive()=true | 循环 40 次 touch + advance 5s | shouldKeepAlive() = true；200s 远超 idle=120s 但仍活着 |
| 停止 touch 后 121s 超时死亡 | 先 touch 一次，advance 121s | shouldKeepAlive() = false |
| ceiling 600s 绝对封顶：哪怕每 5s touch，601s 后必须死 | 每 5s touch 循环到 601s | shouldKeepAlive() = false |
| nextWaitSliceMs 在 1s/10ms 量级收敛 | advance 到 119s 无 touch | nextWaitSliceMs ≈ 1000（剩余 idle 1s）；advance 到 599s → ≈ 1000（剩余 ceiling 1s） |
| withProgressTimeout 在 fence.touch 时成功续命不超时 | promiseFactory 内部每 5s touch，总耗时 200s | 最终返回结果不是 null；没有在 120s 被掐 |
| withProgressTimeout 在 121s 无 touch 时超时返回 null | promiseFactory 永不 touch | 结果 = null（超时放弃，由上层降级占位） |

**Step 2: 跑失败测试**

```bash
cd packages/agent-runtime
npx vitest run src/compact/progress-fence.test.ts
```

**Step 3: 最小实现（对齐 Hermes CompressionCommitFence L457-L505 + while L943-L973）**

**`progress-fence.ts` 完整实现（~95 行，Phase 2 先搭骨架，Phase 3 扩展 commitPhase）：**

```typescript
/**
 * Progress-Aware 双预算 + Commit Fence 骨架（Phase 3 扩展 beginCommit/finishCommit）
 * 移植 Hermes CompressionCommitFence + run_compress_context_with_progress_timeout。
 *
 * 两个预算（两者取 min 才等）：
 *   - idleTimeoutMs：距上次"看到进度"多久才算挂了（默认 120s）—— 慢模型流式 token 到达时 touchProgress()，自动续命
 *   - totalCeilingMs：无论如何绝对最多等多久（默认 600s = 10min）——防死等
 */
export class ProgressFence {
  private lastProgressAt = Date.now();
  private readonly startedAt = Date.now();
  /** Phase 3 用：beginCommit() 后置 true，永不中断外层循环；Phase 2 恒 false */
  commitPhase = false;

  constructor(
    readonly idleTimeoutMs: number = 120_000,   // 120s 无进度判死
    readonly totalCeilingMs: number = 600_000,  // 10min 绝对封顶
  ) {
    // 中文 JSDoc 在类注释上已写
  }

  /** 流式摘要每收到一个新 token 调用一次（单调前进；touch ≠ 死亡计时重置） */
  touchProgress(): void {
    this.lastProgressAt = Date.now();
  }

  /** 距上次进度多少秒（供日志打印） */
  secondsSinceProgress(): number {
    return (Date.now() - this.lastProgressAt) / 1000;
  }

  /**
   * 计算下一次等待的时间片 = min(剩余 idle 预算, 剩余 ceiling 预算)
   * 对应 Hermes wait_slice = min(max(idle - since_progress, 0.005), remaining_ceiling)
   */
  nextWaitSliceMs(): number {
    const waitedMs = Date.now() - this.startedAt;
    const remainingCeiling = this.totalCeilingMs - waitedMs;
    const remainingIdle = this.idleTimeoutMs - (Date.now() - this.lastProgressAt);
    if (remainingCeiling <= 0) return 0;
    // 最小等 5ms，避免 1ms busy loop
    return Math.max(5, Math.min(remainingIdle, remainingCeiling));
  }

  /** 是否还有命（两个预算都没耗尽）→ true = 继续续命循环 */
  shouldKeepAlive(): boolean {
    const waitedMs = Date.now() - this.startedAt;
    const sinceProgressMs = Date.now() - this.lastProgressAt;
    return sinceProgressMs < this.idleTimeoutMs && waitedMs < this.totalCeilingMs;
  }
}

/**
 * 包装 Promise + ProgressFence 的等待循环（对应 Hermes while True L943-L973）。
 * 使用方：runSummaryStage 把原来的 Promise.race(timeout) 替换成这个。
 *
 * @returns 成功时 T；超时放弃返回 null（由上层降级占位）
 */
export async function withProgressTimeout<T>(
  fence: ProgressFence,
  promiseFactory: (fence: ProgressFence) => Promise<T>,
): Promise<T | null> {
  const raceTimeout = (ms: number) =>
    new Promise<'TIMEOUT'>((r) => setTimeout(() => r('TIMEOUT'), ms));
  const workerPromise = promiseFactory(fence);

  while (true) {
    const slice = fence.nextWaitSliceMs();
    if (slice <= 0) {
      // 到 ceiling：commitPhase=false → 超时放弃；commitPhase=true → 永不中断（Phase3 处理）
      if (!fence.commitPhase) return null;
      // commit phase：分段继续等（每 30s 一段，打 WARNING→ERROR 日志；Phase 3 实现升级日志）
      continue;
    }
    const result = await Promise.race([workerPromise, raceTimeout(slice)]);
    if (result !== 'TIMEOUT') {
      return result as T;  // 真拿到了
    }
    // 时间片用完了 → 检查是否能续命
    const alive = fence.shouldKeepAlive();
    if (!alive && !fence.commitPhase) {
      return null;  // 真挂了
    }
    // alive=true → 继续循环（Hermes L962-L972：打印 still streaming 日志后 continue）
  }
}
```

**Step 4: 测试通过后提交**

```bash
npx vitest run src/compact/progress-fence.test.ts
git add packages/agent-runtime/src/compact/progress-fence.ts packages/agent-runtime/src/compact/progress-fence.test.ts
git commit -m "feat(compact): ProgressFence 双预算 + withProgressTimeout 循环包装器（120s idle + 600s ceiling + touchProgress 续命）"
```

---

### Task 5: runSummaryStage 接入 ProgressFence + SummaryGeneratorFn 协议扩展 onProgress

**Files:**
- Modify: `packages/agent-runtime/src/compact/types.ts`（SummaryGeneratorFn 加 options 第 4 参数）
- Modify: `packages/agent-runtime/src/compact/strategies/summary-compact.ts`（runSummaryStage 用 withProgressTimeout 替换原 timeout）
- Create: `packages/agent-runtime/src/compact/strategies/summary-compact-progress.test.ts`（mock 流式摘要每 5s touch + 200s 成功）

**Step 1: 先写测试（模拟慢模型续命成功 / 无 token 超时）**

| 用例 | 构造 | 断言 |
|------|------|------|
| 慢模型每 5s 输出 token，耗时 200s → 不被掐，最终返回摘要 | mock generateSummary 内部 setInterval 每 5s 调 onProgress()，200s resolve | 返回非 null；不是在 120s 被超时 |
| 模型挂死：永不调 onProgress → 121s 超时降级占位 | mock generateSummary 永不 resolve，永不 touch | 121s 后返回 null → 上层 createFallbackPlaceholder 生效 |
| ceiling 600s 强制超：哪怕每 5s touch，到 601s 必须放弃 | 每 5s touch 永不 resolve | 601s 后返回 null |

**Step 2: 失败测试**

```bash
npx vitest run src/compact/strategies/summary-compact-progress.test.ts
```

**Step 3: 最小实现**

**A) types.ts 扩展 SummaryGeneratorFn：**
```typescript
/** 原：type SummaryGeneratorFn = (prompt, oldMessages, signal) => Promise<...> */
export type SummaryGeneratorFn = (
  systemPrompt: string,
  oldMessages: AgentMessage[],
  signal?: AbortSignal,
  /** Phase 2 新增：流式摘要时，每收到 N 个 token 调用一次 options.onProgress() → ProgressFence.touchProgress 续命 */
  options?: {
    onProgress?: () => void;
  },
) => Promise<{ summaryMessage: AgentMessage | null; ptlRetries?: number; failed?: boolean }>;
```

**B) summary-compact.ts 的 runSummaryStage 改造：**
- 原 `await Promise.race([generateSummary(...), timeoutPromise(120s)])` → 替换为：
  ```typescript
  const fence = new ProgressFence(120_000, 600_000);  // idle 120s, ceiling 600s
  const stage = await withProgressTimeout(fence, async (f) => {
    // 内部调用 generateSummary(..., { onProgress: () => f.touchProgress() })
    return generateSummary!(systemPrompt, oldMessages, signal, {
      onProgress: () => f.touchProgress(),
    });
  });
  // stage === null → 等价于原超时 → failed=true，上层降级占位
  if (stage === null) {
    logger.warn(`Summary 阶段 ProgressFence 超时：距上次进度 ${fence.secondsSinceProgress().toFixed(1)}s，放弃（降级占位）`);
    return { summaryMessage: null, failed: true, ptlRetries: 0 };
  }
  return stage;
  ```

**Step 4: 端到端回归 + 验收基线对比**

```bash
# Phase 2 专项
npx vitest run src/compact/policy.test.ts src/compact/idle-trigger.test.ts src/compact/progress-fence.test.ts src/compact/strategies/summary-compact-progress.test.ts apps/windows/src/main/agent-runtime/idle-compact.test.ts
# 全量
npx vitest run src/compact
# TS 严格编译
npx tsc --noEmit
```

**验收基线对比（填实际值）：**

| 指标 | 基线 | 目标 | 实际 |
|------|------|------|------|
| 小模型 qwen2.5-7b（8K）6K 前触发占比 | 0%（都是 0.78×8K=6240 才触发） | **100% 在 70%=5600 触发，永不 8K 顶爆** | |
| 用户回来第一条消息延迟（Idle 命中） | 30~60s（先压后跑） | **<2s（后台已压完）** | |
| 慢模型 119s 仍在流 token 被误杀率 | 100%（120s 墙钟） | **<10%（被 touchProgress 续命）** | |

**提交**

```bash
git add packages/agent-runtime/src/compact/types.ts packages/agent-runtime/src/compact/strategies/summary-compact.ts packages/agent-runtime/src/compact/strategies/summary-compact-progress.test.ts
git commit -m "feat(compact): runSummaryStage 接入 withProgressTimeout，SummaryGeneratorFn 扩展 onProgress 钩子（慢模型续命）"
```

---

## Phase 2 最终交付检查清单

- [ ] resolveModelThreshold：`key in modelName` 用 `includes`，更长 key 优先；空值正确回退 default
- [ ] currentModelName：Agent 每轮 prompt 前注入 model.name，检查 bridge 里 config.model 存在与否都不抛
- [ ] shouldIdleCompact：4 条件 AND 顺序与 Hermes 一致（开关-时间-冷却-地板），纯谓词无副作用
- [ ] lastActivityAt 在所有 inbound IPC 入口（发消息/切换会话/UI 点击）都更新，不是只在 handleUserMessage
- [ ] cron 60s 扫描：撞车 gap<3s 放弃；isCompacting 锁复用，同会话不并发压两次
- [ ] ProgressFence.nextWaitSliceMs：Math.max(5, min(剩 idle, 剩 ceiling))，避免 0/负
- [ ] withProgressTimeout：时间片耗尽 → shouldKeepAlive()=true → continue（续命），否则 return null
- [ ] commitPhase=false（Phase 2），ceiling 到直接 return null，永不分段等（Phase 3 才加）
- [ ] SummaryGeneratorFn 的 options.onProgress 是可选；bridge 注入的 generateSummary 实现里**必须在每个流式 token 到达时调 onProgress()**（否则续命不生效，自动回退到墙钟 120s）
- [ ] 全部测试通过；`src/compact` 回归 0 失败；`tsc --noEmit` 通过
