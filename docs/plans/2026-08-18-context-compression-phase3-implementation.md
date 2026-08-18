# Context Compression Phase 3 Implementation Plan
# 上下文压缩多层化 Phase 3：Commit Fence 永不中断 + SQLite 事务化 + 冷却/反抖动（一致性兜底）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**前置依赖：** Phase 1 + Phase 2 已全部完成并验收通过。

**Goal:**
- **Commit Fence（原子提交期）**：一旦 `beginCommit()` 开始写 DB，外层 withProgressTimeout **永不允许中断**，分段继续等 + WARNING→ERROR 日志升级，杜绝「半压缩状态」数据分叉（比超时严重 100 倍）。
- **SQLite 落库事务化**：`bridge.compactContextAsync()` 的 DB 写入用 `BEGIN TRANSACTION / COMMIT / ROLLBACK` 包裹，100 次杀进程压力测试 0 分叉。
- **压缩失败冷却（failure_cooldown）+ 反抖动冷却（anti_thrash）**：连续失败 10min 内不重试 Idle；连续 N 次压缩 savings<10% 冷却 1h。
- **可选（低优先级）**：Hermes Pass 4 尾部压力降级（保护区内部继续降级直到 1.5×软预算内）。

**Architecture:**
- **Commit Fence**：在 Phase 2 的 `ProgressFence` 基础上扩展 `commitPhase`（从字段升级为私有 + beginCommit/finishCommit 方法）+ `revokeCommitAdmission`（Phase 2 withProgressTimeout 外层异常 unwind 路径调用，防止新的 future 再提交）。
- **事务化**：现有 compactContextAsync 的写 DB 操作（如 `archive_and_compact`、rearm tokens 写入）用 SQLite `BEGIN IMMEDIATE` → 所有写入 → `COMMIT`，任何一处异常 → `ROLLBACK` 回滚。
- **冷却**：CompactConfig 闭包加 `failureCooldownUntil` 时间戳；`RecompactionTracker` 加 savings 比例判断。

**Tech Stack:**
TypeScript strict、better-sqlite3 / 现有 SQLite wrapper（项目当前 DB 方案）、vitest + 压力测试循环（100 次）、fake timers、AbortController 模拟超时。

**规格:**
- 设计文档：`docs/design/2026-08-18-context-compression-multi-layer-engine.md`（v2.0，§4）
- Hermes 参考实现（精确行号）：
  - CompressionCommitFence 完整实现（begin_commit/finish_commit/commit_in_flight/revoke_commit_admission）：[conversation_compression.py:L457-L632](file:///D:/open-source/hermes-agent/agent/conversation_compression.py#L457-L632)
  - commit-in-flight 永不中断循环 + WARNING→ERROR 升级：[conversation_compression.py:L1008-L1054](file:///D:/open-source/hermes-agent/agent/conversation_compression.py#L1008-L1054)
  - 失败冷却 + anti-thrash 失效保护（见 turn_context.py:L368 cooldown_active 参数）：[turn_context.py:L397-L399](file:///D:/open-source/hermes-agent/agent/turn_context.py#L397-L399)
  - 尾部压力降级 Pass 4：[context_compressor.py:L3613-L3688](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3613-L3688)

**范围锁：**
本 Phase 3 任务 1–4 为一致性兜底 MVP；Task 5（Pass 4 尾部压力降级）标「可选低优先级」，出问题时才做。

**验收基线：**
- 基线 A：模拟压缩中途杀进程（process.exit）100 次，手动查 SQLite 会话完整性 → 可能出现半压缩数据分叉（Phase 1/2 现状无事务）
- 基线 B：SessionDB 写入 600s 还没返回（模拟极端慢盘）→ 现状超时后杀 worker，DB 锁占死，新会话压不进去
- 基线 C：网络抖动 → Summary 连续失败 5 次，Idle Compaction 每 5 分钟仍重试一次，API 浪费

---

### Task 1: ProgressFence 扩展 beginCommit / finishCommit / revokeCommitAdmission

**Files:**
- Modify: `packages/agent-runtime/src/compact/progress-fence.ts`（扩展类，加 4 个新方法 + commitPhase 私有化）
- Modify: `packages/agent-runtime/src/compact/progress-fence.test.ts`（追加 commit phase 用例）

**Step 1: 先写失败测试**

| 用例 | 构造 | 断言 |
|------|------|------|
| beginCommit → commitInFlight=true；finishCommit → 变 false | 调 beginCommit() | `fence.commitInFlight === true`；finishCommit() 后变 false |
| cancel_before_commit 赢了 race：先 revoke 再 begin → begin 返回 false | `revokeCommitAdmission()` 先调，再 `beginCommit()` | begin 返回 false；DB 写入代码不执行 |
| beginCommit 已经在飞 → revoke 不影响当前提交，但禁止后续新提交 | begin 后 revoke，再 finish，再 begin | 第二次 begin 返回 false（已 revoked） |
| commitInFlight 属性 lock-free 可读（不需要持锁，语义保证） | begin 期间另一个线程读 | 属性立刻返回 true，不阻塞 |
| beginCommit 与 finishCommit 正确配对：不泄漏锁（配对数相等） | begin/finish 各 10 次循环 | 最后 commitInFlight=false；无死锁 |

**Step 2: 跑测试失败**

```bash
cd packages/agent-runtime
npx vitest run src/compact/progress-fence.test.ts
```

**Step 3: 最小实现（移植 Hermes L457-L632 核心语义，去掉 threading.Lock 的 Python 特有写法，TypeScript 用 Promise/事件）**

**修改 `progress-fence.ts` 的 ProgressFence 类：**
```typescript
export class ProgressFence {
  // ... 原有字段保留 ...

  /** Phase 3 新增：私有化 commitPhase，只能通过 begin/finish 改 */
  private _commitPhase = false;

  /** Phase 3 新增：revokeCommitAdmission 后设为 true，禁止后续 beginCommit 通过（类似 Hermes _admission_revoked，lock-free bool 原子写） */
  private _admissionRevoked = false;

  /** Phase 3 新增：cancel_before_commit 赢 race 后置 true，语义等同 Hermes _cancelled */
  private _cancelledBeforeCommit = false;

  /** Lock-free 读：是否有提交正在执行中（对应 Hermes commit_in_flight 属性，L576-L586） */
  get commitInFlight(): boolean {
    return this._commitPhase;
  }

  /**
   * 开始原子提交期：调 DB 写入之前必须先调这个。
   * 返回 true = 拿到入场权，可以写 DB；返回 false = 已被 cancel/revoke，不能写。
   * 语义对齐 Hermes begin_commit（L539-L560）。
   */
  beginCommit(): boolean {
    if (this._cancelledBeforeCommit || this._admissionRevoked) {
      // 入场权已被抢占/撤销
      return false;
    }
    // ⭐ 设为 true = 对外信号：开始写 DB，永不允许中断/杀线程
    this._commitPhase = true;
    return true;
  }

  /**
   * 结束原子提交期：DB 写入无论成功/失败（catch 内也必须调）都必须配对调用。
   * 语义对齐 Hermes finish_commit（L562-L574）。
   */
  finishCommit(): void {
    this._commitPhase = false;
    // 如果期间有 revoke deferred release，在这里处理（TypeScript 简化：Phase3 先不加 durable lock）
  }

  /**
   * 撤销「未来的」提交入场权（当前正在飞的提交不受影响）。
   * Phase2 withProgressTimeout 的任何异常 unwind 路径（finally）必须调这个，
   * 防止 detached worker 之后再偷偷写 DB 分叉会话。
   * 语义对齐 Hermes revoke_commit_admission（L593-L631）。
   */
  revokeCommitAdmission(): void {
    this._admissionRevoked = true;
  }

  /** 取消提交（只能在 beginCommit 之前赢 race）；语义对齐 cancel_before_commit */
  cancelBeforeCommit(): boolean {
    if (this._commitPhase) return false;  // 已经开始写了 → cancel 输了 race
    this._cancelledBeforeCommit = true;
    return true;
  }

  // ... 原有 touchProgress/secondsSinceProgress/nextWaitSliceMs/shouldKeepAlive 保留不变 ...
}
```

**Step 4: 测试通过后提交**

```bash
npx vitest run src/compact/progress-fence.test.ts
git add packages/agent-runtime/src/compact/progress-fence.ts packages/agent-runtime/src/compact/progress-fence.test.ts
git commit -m "feat(compact): ProgressFence 扩展 beginCommit/finishCommit/revokeCommitAdmission 原子提交期语义"
```

---

### Task 2: withProgressTimeout 扩展 commit-in-flight 永不中断 + WARNING→ERROR 升级日志

**Files:**
- Modify: `packages/agent-runtime/src/compact/progress-fence.ts`（`withProgressTimeout` 函数重写 commit phase 分支）
- Modify: `packages/agent-runtime/src/compact/progress-fence.test.ts`（追加 commit phase overrun 用例）

**Step 1: 写失败测试（用 vitest fake timers + 永不 resolve 的 Promise）**

| 用例 | 构造 | 断言 |
|------|------|------|
| ceiling 到了但 commitInFlight=true → 不返回 null，继续分段等 | worker 在 599s 时调 beginCommit()，永不 resolve/fence.finishCommit() 不调 | withProgressTimeout 到 1000s 仍不返回（永不中断）；打印 WARNING→ERROR 日志 |
| commit phase overrun：第 1/2 次 WARNING，第 3 次起 ERROR | 永不 resolve，advance time 到 ceiling+120s | 日志中 WARNING 出现 2 次；第 3 次开始是 ERROR |
| cancelBeforeCommit 赢了 race（begin 之前 cancel）→ 立即返回 null，worker 调 begin 拿不到入场权 | cancel → begin 返回 false | 返回 null；_admissionRevoked=true 后续新 begin 也禁止 |

**Step 2: 跑失败测试**

```bash
npx vitest run src/compact/progress-fence.test.ts
```

**Step 3: 重写 withProgressTimeout 的 commit phase overrun 分支（对齐 Hermes L1008-L1054）**

```typescript
// 在 withProgressTimeout 的 while (true) 内，当 slice<=0 且 _commitPhase=true 时：
if (fence.commitInFlight) {
  // ❌ 绝对不能退出循环 / return null！DB 正在写 → 杀了 = 半写 = 会话数据分叉
  // 改为分段继续等，每 30s 一段，WARNING→ERROR 升级（对齐 Hermes L1008-L1054）
  // overrun 统计
  let overrunReports = 0;
  const OVERRUN_SLICE_MS = 30_000;  // 30s 一段
  while (true) {
    const waited = Date.now() - fence['startedAt'];  // startedAt 需改成包外可访问（改类）
    const remaining = fence.totalCeilingMs - waited;
    let waitMs: number;
    if (remaining <= 0) {
      // 已经越界，按 30s 继续等，日志升级
      waitMs = OVERRUN_SLICE_MS;
      overrunReports += 1;
      const past = waited - fence.totalCeilingMs;
      const msg = `[CommitFence] SessionDB 提交仍在进行中，已越界 ${(past/1000).toFixed(1)}s（总等 ${(waited/1000).toFixed(1)}s，ceiling ${(fence.totalCeilingMs/1000).toFixed(0)}s）；**永不中断**，继续等下一段 ${(waitMs/1000).toFixed(0)}s，请检查磁盘/数据库健康`;
      if (overrunReports <= 2) logger.warn(msg);
      else logger.error(msg);
      // 可选：第一次越界时调用 onCommitOverrun 回调一次性通知 UI Toast 显示
    } else {
      waitMs = Math.min(OVERRUN_SLICE_MS, remaining);
    }
    const r = await Promise.race([workerPromise, raceTimeout(waitMs)]);
    if (r !== 'TIMEOUT') return r as T;
    // 否则继续 while(true)，下一段再等
  }
}
```

**withProgressTimeout 必须加 finally 块（关键 Hermes F2 语义）：**
```typescript
try {
  // ... 原有 while(true) ...
} finally {
  // F2: 任何异常 unwind 路径（KeyboardInterrupt/任务取消/未捕获异常）都要撤销未来提交入场权
  // 防止 detached worker 之后偷偷写 DB 造成分叉
  fence.revokeCommitAdmission();
}
```

**Step 4: 测试通过后提交**

```bash
npx vitest run src/compact/progress-fence.test.ts
git add packages/agent-runtime/src/compact/progress-fence.ts packages/agent-runtime/src/compact/progress-fence.test.ts
git commit -m "feat(compact): withProgressTimeout commit-phase 永不中断 + 30s 分段 WARNING→ERROR 升级 + finally revoke 防分叉"
```

---

### Task 3: bridge.compactContextAsync 落库事务化（BEGIN/COMMIT/ROLLBACK）

**Files:**
- Modify: `apps/windows/src/main/agent-runtime/bridge.ts`（compactContextAsync 方法）
- Create: `apps/windows/src/main/agent-runtime/compact-transaction.test.ts`（事务 + 压力测试 100 次）

**Step 1: 写压力测试（100 次循环，模拟半写故障）**

| 用例 | 构造 | 断言 |
|------|------|------|
| 写 DB 中途抛异常 → ROLLBACK，会话 messages 保持旧版本不变 | mock SQLite `run(sql)` 第 2 条语句抛错 | 会话 messages === 旧版本（无半写）；DB 无脏数据 |
| 100 次压缩事务循环，随机在任何语句抛错（模拟网络/磁盘瞬错） | 循环 100 次，随机 throw | 每次都能 ROLLBACK，最终会话状态一致不丢；0 分叉 |
| beginCommit 在事务前调，finishCommit 在 COMMIT/ROLLBACK 之后调 | 断言时序 | fence.commitInFlight=true 仅在事务期间为 true；结束恒 false |
| ROLLBACK 后 failure_cooldown 被写入（Task4 会用） | 事务失败后 | compactConfig.failureCooldownUntil = now + 10min |

**Step 2: 失败测试**

```bash
cd apps/windows
npx vitest run src/main/agent-runtime/compact-transaction.test.ts
```

**Step 3: 最小实现（wrap compactContextAsync 写 DB 操作）**

```typescript
async compactContextAsync(sessionKey: string): Promise<{ ok: boolean; reclaimed?: number }> {
  // ... 前置检查、锁、消息加载、Proactive 检查、摘要生成 ...

  const fence = new ProgressFence(120_000, 600_000);
  try {
    // ======== 摘要阶段（可取消）========
    // 这里 runSummaryStage 用 withProgressTimeout(fence, ...) → 可超时
    const summaryResult = await withProgressTimeout(fence, async (f) => {
      return runSummaryStage(...);  // 内部会在每个流式 token 调 f.touchProgress()
    });
    if (summaryResult === null) {
      // 摘要阶段超时：取消入场权
      fence.cancelBeforeCommit();
    }

    // ======== DB 写入阶段（beginCommit 之后 = 原子期，永不中断）========
    if (!fence.beginCommit()) {
      // cancel/revoke 赢了 race → 不写 DB，直接返回
      return { ok: false };
    }
    try {
      // ⭐ 用 SQLite 事务包裹所有写入
      db.exec('BEGIN IMMEDIATE;');  // 立刻拿写锁，避免读-写竞争死锁

      // 1. 写 archive_and_compact：旧消息归档 + 新 summary 注入 + 新消息落盘
      db.run(`
        INSERT INTO session_messages (session_id, idx, role, content, ...)
        VALUES (?, ?, ?, ?, ...)
      `, [sessionKey, ...]);

      // 2. 写 proactiveRearmTokens / failureCooldownUntil 配置到 session_config
      db.run(`
        INSERT OR REPLACE INTO session_config (session_id, key, value)
        VALUES (?, ?, ?)
      `, [sessionKey, 'proactive_rearm_tokens', String(nextRearmTokens ?? 0)]);

      // 3. ... 任何其他写入 ...

      db.exec('COMMIT;');  // ⭐ 原子提交
      logger.info(`[compact-transaction] 会话 ${sessionKey} 压缩事务提交成功`);
      return { ok: true, reclaimed: before - after };
    } catch (err) {
      // ⭐ 任何异常：ROLLBACK，不留下半写
      db.exec('ROLLBACK;');
      logger.error(`[compact-transaction] 会话 ${sessionKey} 压缩事务异常，已 ROLLBACK：${err instanceof Error ? err.message : String(err)}`);
      // ⭐ 写入失败冷却时间戳（Task4 用）
      await this._writeFailureCooldown(sessionKey, 10 * 60 * 1000);  // 10 min
      return { ok: false };
    } finally {
      fence.finishCommit();  // ⭐ 无论 COMMIT/ROLLBACK 都必须配对调 finishCommit
    }
  } finally {
    fence.revokeCommitAdmission();
  }
}
```

**Step 4: 压力测试通过 + 手动杀进程验证**

```bash
# 专项
npx vitest run src/main/agent-runtime/compact-transaction.test.ts
# 100 次压力测试（需 extra 配置）
npx vitest run src/main/agent-runtime/compact-transaction.test.ts --reporter=verbose
```

**提交**

```bash
git add apps/windows/src/main/agent-runtime/bridge.ts apps/windows/src/main/agent-runtime/compact-transaction.test.ts
git commit -m "feat(compact): compactContextAsync 落库事务化（BEGIN IMMEDIATE/COMMIT/ROLLBACK）+ failureCooldown 写入 10min"
```

---

### Task 4: 失败冷却（failure_cooldown）+ 反抖动冷却（anti_thrash savings<10%）

**Files:**
- Modify: `packages/agent-runtime/src/compact/types.ts`（加 3 字段）
- Modify: `packages/agent-runtime/src/compact/idle-trigger.ts`（shouldIdleCompact 新增 cooldown 接入；但 Task2 已经加了参数，这里只是 bridge 侧用）
- Modify: `packages/agent-runtime/src/compact/post-compact.ts`（在 RecompactionTracker 里加 savings 判断）
- Modify: `apps/windows/src/main/agent-runtime/bridge.ts`（_writeFailureCooldown + Idle 读取 cooldown）
- Create: `packages/agent-runtime/src/compact/cooldown-protection.test.ts`

**Step 1: 写测试**

| 用例 | 构造 | 断言 |
|------|------|------|
| failure_cooldown=10min：刚失败 → Idle shouldIdleCompact 拒绝 cooldownActive=true | now() < failureCooldownUntil | shouldIdleCompact 返回 false；11min 后再试 → true |
| anti_thrash：连续 N=3 次压缩 savings<10%（压缩了等于没压）→ 冷却 1h | 构造三次 reclaimed/(before-after)<10% 记录 | Idle shouldIdleCompact 的 cooldown 再叠加 1h |
| 冷却在成功压缩一次后清零 | 先 anti_thrash 冷却，再一次成功 savings=50% | cooldown 立刻清零，下次 Idle 可正常触发 |

**Step 2: 失败测试**

```bash
cd packages/agent-runtime
npx vitest run src/compact/cooldown-protection.test.ts
```

**Step 3: 最小实现**

**A) types.ts CompactConfig 加字段：**
```typescript
/**
 * 压缩失败冷却：上次压缩失败后 N ms 内不再触发 Idle Compaction（默认 10min）
 * 防止网络/模型瞬时故障 → 每 5 分钟重试一次浪费 API
 */
failureCooldownMs?: number;

/**
 * Anti-thrash 冷却：连续 N 次压缩 savings<阈值，冷却 X ms（默认 1h）
 * 防止"越压越小/等于没压"的循环浪费 API
 */
antiThrashConsecutiveThreshold?: number; // 默认 3 次
antiThrashCooldownMs?: number;          // 默认 3_600_000 = 1h
antiThrashMinSavingsRatio?: number;     // 默认 0.10 = 10%（低于就算"等于没压"）
```

**B) post-compact.ts RecompactionTracker 扩展：**
```typescript
class RecompactionTracker {
  // ... 原有字段 ...
  private savingsRatios: number[] = [];  // 最近 N 次 savings 比例

  record(turnCounter: number, beforeTokens?: number, afterTokens?: number): RecompactionDiag {
    // ... 原有逻辑 ...
    if (typeof beforeTokens === 'number' && typeof afterTokens === 'number' && beforeTokens > 0) {
      const ratio = (beforeTokens - afterTokens) / beforeTokens;
      this.savingsRatios.push(ratio);
      if (this.savingsRatios.length > (config?.antiThrashConsecutiveThreshold ?? 3)) {
        this.savingsRatios.shift();
      }
    }
    return { ... };
  }

  /** 最近 N 次压缩是否都 savings<minRatio → anti-thrash 冷却 */
  isAntiThrashCooldownNeeded(minRatio = 0.10, consecutive = 3): boolean {
    if (this.savingsRatios.length < consecutive) return false;
    return this.savingsRatios.slice(-consecutive).every(r => r < minRatio);
  }
}
```

**C) bridge.ts 读取 cooldown 接入 tryIdleCompact：**
```typescript
async tryIdleCompact(sessionKey: string) {
  // ... 现有检查 ...
  // 检查 failure_cooldown
  const cooldownUntil = await this._readFailureCooldown(sessionKey);
  if (cooldownUntil && Date.now() < cooldownUntil) {
    logger.debug(`IdleCompact 放弃[失败冷却中]：会话 ${sessionKey} 冷却至 ${new Date(cooldownUntil).toISOString()}`);
    return false;
  }
  // 检查 anti-thrash
  const thrash = session.recompactionTracker?.isAntiThrashCooldownNeeded(
    session.compactConfig.antiThrashMinSavingsRatio,
    session.compactConfig.antiThrashConsecutiveThreshold,
  );
  if (thrash) {
    logger.debug(`IdleCompact 放弃[反抖动冷却]：连续 N 次 savings<10%，1h 内不重试`);
    return false;
  }
  // ... 现有 shouldIdleCompact 调用，cooldownActive=(failureCooldown||antiThrash) ...
}
```

**Step 4: 测试通过后提交**

```bash
npx vitest run src/compact/cooldown-protection.test.ts
git add packages/agent-runtime/src/compact/types.ts packages/agent-runtime/src/compact/post-compact.ts apps/windows/src/main/agent-runtime/bridge.ts packages/agent-runtime/src/compact/cooldown-protection.test.ts
git commit -m "feat(compact): 失败冷却 10min（failure_cooldown）+ Anti-Thrash 连续 N 次 savings<10% → 冷却 1h"
```

---

### Task 5（可选，低优先级）: Hermes Pass 4 尾部压力降级移植

**Files:**
- Modify: `packages/agent-runtime/src/compact/strategies/micro-compact.ts`（在 proactivePrune 三阶段之后追加 Pass 4）
- Create: `packages/agent-runtime/src/compact/strategies/proactive-pressure-demote.test.ts`

**做之前先判断是否需要：** 如果 Phase1/2 验收后 hard-trim 兜底仍然频繁触发（说明 protected tail 内部有巨型 200KB tool 结果锁死）→ 做；否则跳过。

**对齐 Hermes L3613-L3688 语义：**
```
if 保护区 token 估算 > protect_tail_tokens × 1.5 (软预算):
  从 prune_boundary 到 demote_end 逐条 demote(含 skill 保护取消)
  if 仍超:
    除最后 1 条 tool 外全部保护区内也 demote
  if 仍超（极端：最新 tool 自己就 200KB）:
    最后 1 条也 demote（最后手段）
```

参考设计文档 §4.3 P3-3。代码量 +60 行。

---

## Phase 3 验收（压力测试 + 极端场景）

| 测试 | 方法 | 验收标准 |
|------|------|---------|
| 半写分叉 0 率 | 100 次循环：随机在 SQLite 第 N 条语句 throw → ROLLBACK，读回会话状态 | 100/100 次 messages 与压缩前一致，**0 分叉** |
| beginCommit 超 600s 不杀线程 | mock DB write 永不 resolve；advance time 到 1200s | fence.commitInFlight 仍 true；WARNING/ERROR 日志升级（2 WARNING 后 ERROR），循环不退出；不 throw |
| finally revokeAdmission + 异常 unwind | 在 withProgressTimeout 等待中 throw new Error('测试取消') | worker 在 catch 之后调 beginCommit → 返回false（入场权已撤销），**没有偷偷写 DB** |
| failure_cooldown 正确生效 | 连续 5 次压缩失败（mock throw），Idle cron 扫描 600s | 10min 内 tryIdleCompact 全部 return false（10min 冷却）；11min 后可以触发 |
| anti_thrash 正确生效 | 连续 3 次压缩 savings=5%（等于没压），之后 Idle 扫描 | 1h 内 Idle 不触发；一次成功压缩 savings=60% 后清零冷却 |

## Phase 3 最终交付检查清单

- [ ] ProgressFence._commitPhase 私有，只能通过 beginCommit()/finishCommit() 改
- [ ] finally 块必调 revokeCommitAdmission()：任何异常路径不允许 detached worker 之后写 DB
- [ ] withProgressTimeout 的 commitPhase overrun 分支：**永不 return null / 永不 break 外循环**，30s 分段等，WARNING(1/2次)→ERROR(≥3次) 升级
- [ ] bridge.compactContextAsync 写 DB 全部用 BEGIN IMMEDIATE/COMMIT/ROLLBACK 包裹
- [ ] COMMIT 和 ROLLBACK 两个分支之后**都配对 finishCommit()**
- [ ] ROLLBACK 后写入 failureCooldownUntil（Date.now()+10min），非忘记
- [ ] anti_thrash：RecompactionTracker 记录的 savings 比例数组 >=3 次时判断，<10% 都触发 1h 冷却
- [ ] 100 次压力测试事务 ROLLBACK 0 失败，0 分叉
- [ ] beginCommit 后 SQLite write 故意 hang 20min，日志正确升级；DB 回来后正常 COMMIT（不死锁不杀线程）
- [ ] 全部 3 个 Phase 回归（Phase1+Phase2+Phase3 测试套件一次性通过），`src/compact` + `apps/windows/src/main/agent-runtime` 0 失败
