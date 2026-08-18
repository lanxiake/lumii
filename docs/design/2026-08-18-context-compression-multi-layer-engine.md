# 上下文压缩多层化引擎：从「阈值触发」到「分层渐进、无感自愈」的架构升级方案

> 日期：2026-08-18  
> 状态：v2.0，逐行代码对比，分 Phase 1/2/3 三次落地  
> 参考架构文档：[01_压缩引擎多层化_架构深度剖析.md](file:///D:/open-source/hermes-agent/docs/mydocs/architecture-layer/compression/01_压缩引擎多层化_架构深度剖析.md)  
> **Lumii 代码证据**：
> - 主编排：[transform-context.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/transform-context.ts#L1-L243)
> - 类型/配置：[types.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/types.ts#L1-L276)
> - MicroCompact：[micro-compact.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/strategies/micro-compact.ts#L1-L138)
> - Summary 摘要：[summary-compact.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/strategies/summary-compact.ts#L1-L149)
> - Hard-Trim：[hard-trim.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/strategies/hard-trim.ts#L1-L159)
> - 阈值/断路器：[policy.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/policy.ts#L1-L108)
> - 落库形态：[compact-persist.ts](file:///d:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/compact-persist.ts#L1-L36)
>
> **Hermes 参考实现（精确引用）**：
> - Proactive Prune + Dedup/Summarize/Truncate + Reclaim Gate + Rearm：[context_compressor.py:L3398-L3801](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3398-L3801)
> - Per-Model 阈值匹配：[context_compressor.py:L1820-L1843](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L1820-L1843)
> - Progress-Aware 双预算 + Commit Fence：[conversation_compression.py:L450-L1050](file:///D:/open-source/hermes-agent/agent/conversation_compression.py#L450-L1050)
> - Idle Compaction 触发判断：[turn_context.py:L368-L400](file:///D:/open-source/hermes-agent/agent/turn_context.py#L368-L400) + [turn_context.py:L773-L851](file:///D:/open-source/hermes-agent/agent/turn_context.py#L773-L851)

---

## 0. 结论摘要（v2.0）

| 维度 | Lumii 当前实现 | Hermes 参考实现 | 本方案差距 | 落地 Phase |
|------|----------------|----------------|-----------|-----------|
| **Proactive Prune（主动剪枝）** | ❌ 无（直接跳到 MicroCompact 0.60） | ✅ Dedup(无损) → Summarize → Truncate 三阶段 | **三阶段 + Reclaim Gate 4096 + Rearm 跑道** | **Phase 1** |
| **MicroCompact 工具清理** | ✅ 微摘要/占位符替换（0.60 窗口） | ⚠️ 直接合并在 _prune_old_tool_results 中 | **Dedup 阶段直接复用现有微摘要函数** | **Phase 1** |
| **Reclaim Gate（回收门控）** | ❌ 无（每次触发都改消息，无意识破坏 Cache） | ✅ `proactive_prune_min_reclaim_tokens=4096`，不够就原样返回 | **新增 1 个 if 判断，3 行代码** | **Phase 1** |
| **Rearm 跑道（防抖动）** | ❌ 无（48K→剪到 44K→加 5K→又触发，抖动循环） | ✅ `next_rearm_tokens = after + max(reclaimed, trigger, min_reclaim)` | **闭包内加 1 个变量，5 行代码** | **Phase 1** |
| **绝对阈值天花板** | ❌ 无（配置错了 1M 窗口 95% 才触发就完蛋） | ✅ `threshold_tokens_cap`，最后一把闸 min 限制 | **新增 1 个配置字段，2 行代码** | **Phase 1** |
| **Per-Model 阈值覆盖** | ❌ 全局 0.78，小模型/大模型一刀切 | ✅ 最长子串匹配 + 小窗口地板 + 绝对 Cap 堆叠 | **新增 modelThresholds 配置，15 行匹配函数** | **Phase 2** |
| **Idle Compaction 空闲压缩** | ❌ 无（用户必卡第一条消息） | ✅ 挂钟空闲 ≥ 300s + 超地板 + 冷却未激活 + 无锁 | **新增 lastActivityAt + 主进程轮询** | **Phase 2** |
| **Progress-Aware 超时** | ⚠️ 无（简单 Promise.race 可能杀慢但活着的摘要） | ✅ idle=120s + ceiling=600s + touch_progress 流式续命 | **新建 ProgressFence 类，~90 行** | **Phase 2** |
| **Commit Fence（原子提交）** | ❌ 无（写 DB 中途超时会造成半压缩分叉） | ✅ begin_commit() 后永不中断，分段等 + WARNING→ERROR 升级 | **Phase 2 的超时类扩展一个 flag** | **Phase 3** |
| **压缩落库事务化** | ⚠️ bridge.compactContextAsync 无显式事务 | ✅ archive_and_compact 原子写入 | **SQLite 事务包裹，~10 行** | **Phase 3** |

---

## 1. 现状代码事实核查（逐行对比）

### 1.1 Lumii 压缩管线三层架构（主编排）

**来源**：[transform-context.ts createTransformContext](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/transform-context.ts#L85-L242)

```
用户消息到达 → createTransformContext() 被 pi-agent-core 自动调用
  │
  ├─ Step 1（L112）: checkCompactionNeeded 判断 totalTokens >= threshold
  │     threshold = contextWindow × 0.78
  │     未超 → 进入 Step 1a MicroCompact；超 → 跳到 Step 2
  │
  ├─ Step 1a（L117-L147）: MicroCompact 第一级（contextWindow × 0.60）
  │     调用 [microcompactToolResults](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/strategies/micro-compact.ts#L60-L138)
  │     ├─ COMPACTABLE_TOOLS 白名单（8 类幂等工具）
  │     ├─ 保留最近 8 个工具结果
  │     └─ 替换为 [buildDeterministicToolSummary](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/strategies/micro-compact.ts#L32-L50)
  │         （确定性微摘要：共 N 行/N 字符 + 首尾 2 行线索 + 提示重新调用）
  │
  ├─ Step 2（L153-L190）: Summary 全摘要（≥ 0.78）
  │     ├─ CircuitBreaker 连续失败 3 次熔断跳过（[policy.ts:L84-L108](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/policy.ts#L84-L108)）
  │     ├─ partitionMessages 分 old/recent 两段
  │     ├─ 调用 [runSummaryStage](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/strategies/summary-compact.ts#L70-L149)
  │     │   ├─ 剥离图片 stripImagesFromMessages
  │     │   ├─ PTL 重试 maxPtlRetries=3：truncateHeadForPtlRetry 丢最老 20% 轮
  │     │   └─ 失败 → 返回 null 由调用方降级占位
  │     ├─ 失败则调用 [createFallbackPlaceholder](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/summary-message.ts)
  │     └─ PostCompactRebuild.buildAttachments：可选注入附加消息（SessionActivityIndex 等）
  │
  └─ Step 3（finalizeHistoryMessages）: Hard-Trim 兜底
        调用 [iterativeDropUntilUnder](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/strategies/hard-trim.ts#L72-L121)
        ├─ 微压缩工具结果（仅保留最近 4 个）
        ├─ truncateHeavyToolResults > 8000 字符
        ├─ dropOldestRoundsUntilUnder 整轮丢弃（B1 新增）
        └─ 逐条丢弃最老消息（48 次循环上限）
```

### 1.2 Hermes 对应实现的关键差异（Proactive Prune 对比）

**Hermes 的 prune_tool_results_only 完整流程**：[context_compressor.py:L3690-L3801](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3690-L3801)

```python
# 精确代码摘录（核心判断逻辑）
def prune_tool_results_only(self, messages, current_tokens=None):
    # ① Gate 1: 配置的 proactive_prune_tokens（例 48K）未开 → 跳过
    if self.proactive_prune_tokens <= 0: return messages, 0
    # ② Gate 2: 当前 rough_tokens < 48K → 跳过
    if current_tokens is not None and current_tokens < self.proactive_prune_tokens:
        return messages, 0
    # ③ Gate 3: 消息数太少（还没超出保护尾部）→ 跳过
    if len(messages) <= self.protect_last_n + self._protect_head_size(messages) + 1:
        return messages, 0
    before = sum(_estimate_msg_budget_tokens(m) for m in messages)
    # ④ Gate 4（⭐ Rearm 跑道）：还没跑满一条跑道 → 原样返回，连扫描都不做
    if before < self._proactive_prune_rearm_tokens:
        return messages, 0
    # ... 能力 gate（DB 支持 archive_and_compact 才做）...
    # ⑤ 执行三阶段 _prune_old_tool_results
    pruned_msgs, pruned_count = self._prune_old_tool_results(
        messages, protect_tail_count=self.protect_last_n,
        protect_tail_tokens=None,
        min_prune_chars=self.proactive_prune_min_result_chars,  # 默认 8000 字符
    )
    if not pruned_count: return messages, 0
    after = sum(_estimate_msg_budget_tokens(m) for m in pruned_msgs)
    reclaimed = max(0, before - after)
    # ⑥ Gate 5（⭐ Reclaim Gate 回收门控）：回收 < 4096 tokens → 不值得破坏缓存，原样返回
    if reclaimed < self.proactive_prune_min_reclaim_tokens:
        return messages, 0
    # ⑦ ⭐ Rearm 跑道计算：下次必须再涨满一条跑道才允许再触发
    runway = max(reclaimed, self.proactive_prune_tokens,
                 self.proactive_prune_min_reclaim_tokens)
    next_rearm_tokens = after + runway
    # ... DB 写入 next_rearm_tokens（可持久化）...
    self._proactive_prune_rearm_tokens = next_rearm_tokens
    return pruned_msgs, pruned_count
```

**Hermes 的 _prune_old_tool_results 三阶段具体实现**：[context_compressor.py:L3398-L3688](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3398-L3688)

| 阶段 | Hermes 精确代码位置 | Lumii 现状 | 差距 |
|------|-------------------|-----------|------|
| **① Dedup**（无损去重） | [L3491-L3515](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3491-L3515)：MD5 哈希 content，重复 → 改为 `[Duplicate tool output — same content as a more recent call]`；**全范围可做（含 tail，因为无损）** | ❌ **完全没有**。相同 `file_read("config.json")` 读 5 次各占一份，白白浪费 | **Phase 1 新增** |
| **② Summarize**（非 tail 大 tool 结果→摘要行） | [L3598-L3601](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3598-L3601)：对 `i < prune_boundary` 调用 `_demote_tool_result_at` → `_summarize_tool_result`（1 行：退出码+行数+字符数） | ✅ `microcompactToolResults` + `buildDeterministicToolSummary` 已实现且**更优**（含首尾行线索） | **直接复用 Lumii 现有函数** |
| **③ Truncate**（非 tail assistant 超大 arguments→截断） | [L3602-L3611](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3602-L3611)：对 `i < prune_boundary` 调用 `_truncate_tool_call_args_at` → `_truncate_tool_call_args_json`（在 JSON 结构内截断仍合法） | ❌ **完全没有**。`write_file` 50KB 内容写进 tool_call.arguments 永远占着，从不修剪 | **Phase 1 新增**（参考 [message-ops.ts:L75-L100](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/message-ops.ts#L75-L100) 已有截断思路，扩展到 tool_call arguments） |
| **④ Pass 4 尾部压力降级** | [L3613-L3686](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3613-L3686)：保护区仍超 1.5×软预算时，内部继续降级，直到最后 1 个最新 tool 都不放过 | ⚠️ Hard-Trim 兜底有微压缩（仅保留 4 个），但 Proactive 阶段不做 | **Phase 3 可选优化**（低优先级） |

### 1.3 Per-Model 阈值匹配（Hermes vs Lumii）

**Hermes 精确代码**：[resolve_model_threshold](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L1820-L1843)
```python
# 最长子串匹配：更长的匹配 = 更具体，优先
def resolve_model_threshold(model, model_thresholds, default):
    if not model_thresholds or not model: return default
    best_key = ""
    for key in model_thresholds:
        if key in model and len(key) > len(best_key):
            best_key = key
    if best_key:
        return float(model_thresholds[best_key])
    return default
```

**Lumii 对应位置**：[checkCompactionNeeded](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/policy.ts#L63-L75)
```typescript
export function checkCompactionNeeded(messages, config): TokenEstimation {
  const totalTokens = estimateTokenCount(messages);
  // ❌ 只用了全局 triggerRatio（0.78），没有 per-model 逻辑
  const threshold = Math.floor(config.contextWindow * config.triggerRatio);
  return { totalTokens, threshold, needsCompaction: totalTokens >= threshold };
}
```

### 1.4 Idle Compaction（Hermes vs Lumii）

**Hermes 触发判断（纯谓词，可单测）**：[_should_idle_compact](file:///D:/open-source/hermes-agent/agent/turn_context.py#L368-L400)
```python
def _should_idle_compact(*, enabled, idle_after_seconds, idle_gap_seconds,
                          tokens, floor_tokens, cooldown_active):
    # ① 开关未开/0 → 不做
    if not enabled or idle_after_seconds <= 0: return False
    # ② 挂钟空闲时间还没到 → 不做
    if idle_gap_seconds < idle_after_seconds: return False
    # ③ 上次压缩刚失败，冷却中 → 不做
    if cooldown_active: return False
    # ④ 上下文已经比压缩目标还小 → 压啥？不做
    return tokens > floor_tokens
```

**Hermes 实际触发位置（用户回来发第一条消息时）**：[turn_context.py:L782-L851](file:///D:/open-source/hermes-agent/agent/turn_context.py#L782-L851)
- 读取 `agent.compression_idle_compact_after_seconds`（默认 0，配置开才启用）
- 计算挂钟间隙：`time.time() - agent._last_activity_ts`
- 间隙 ≥ 配置秒 → 先压缩再跑用户消息（**把延迟从用户回来后的第一条消息，搬到用户还没回来的时间缝里的下一条**）

### 1.5 Progress-Aware 双预算 + Commit Fence（Hermes 核心）

**CompressionCommitFence 核心字段**：[conversation_compression.py:L457-L505](file:///D:/open-source/hermes-agent/agent/conversation_compression.py#L457-L505)
```python
class CompressionCommitFence:
    # _commit_phase：begin_commit() 后 set，finish_commit() 后 clear
    # 🔒 语义：一旦 set，宿主永不允许中断 / 杀线程
    _commit_phase = threading.Event()
    
    # _last_progress：流式摘要每收到 1 个 token 就 touch 一次（单调前进）
    _last_progress = time.monotonic()
    
    def touch_progress(self):           # 流式 token 到达 → 更新时间戳
        self._last_progress = time.monotonic()
    
    def seconds_since_progress(self):   # 距上次进度多久？
        return max(0.0, time.monotonic() - self._last_progress)
    
    def begin_commit(self):             # 原子提交期开始：持锁 + set commit_phase
        self._lock.acquire()            # 锁会一直持有到 finish_commit()
        # ... 取消/撤销检查
        self._commit_started = True
        self._commit_phase.set()        # ⭐ 对外信号：开始写 DB，不要杀我
        return True
    
    def finish_commit(self):            # 原子提交期结束：clear + 释放锁
        self._commit_phase.clear()
        self._lock.release()
```

**等待循环（Progress-Aware 核心）**：[run_compress_context_with_progress_timeout](file:///D:/open-source/hermes-agent/agent/conversation_compression.py#L822-L1050)
```python
# while True 循环（L943-L973）：
waited = time.monotonic() - wait_started
remaining_ceiling = ceiling - waited  # ceiling = 600s（绝对封顶）
if remaining_ceiling <= 0: break
# ⭐ 关键：wait_slice 不是固定值，而是「还能无进展多久」与「距封顶多久」取 min
since_progress = fence.seconds_since_progress()  # idle 预算
wait_slice = min(max(idle - since_progress, 0.005), remaining_ceiling)
try:
    result = future.result(timeout=wait_slice)  # 只等一小片时间
    return result
except TimeoutError:
    waited = time.monotonic() - wait_started
    since_progress = fence.seconds_since_progress()
    # ⭐ 续命条件：期间有新 token（since_progress < idle）且 没到封顶 → 继续
    if since_progress < idle and waited < ceiling:
        continue  # 🌟 自动续命！
    break  # 真的挂了 → 跳出循环
```

**Commit-Phase 永不中断**：[conversation_compression.py:L1008-L1050](file:///D:/open-source/hermes-agent/agent/conversation_compression.py#L1008-L1050)
```python
# 跳出等待后，如果 fence.commit_in_flight（即已经 begin_commit 了）：
if fence.commit_in_flight:
    # ❌ 绝对不能杀线程！DB 半写 = 会话数据分叉
    # 改为分段继续等，每次 30s，并打 WARNING → ERROR 升级日志
    while True:
        waited = time.monotonic() - wait_started
        remaining = ceiling - waited
        if remaining <= 0:
            remaining = min(_COMMIT_OVERRUN_WAIT_SLICE_SECONDS, max(ceiling, 0.05))
            overrun_reports += 1
            log = logger.warning if overrun_reports <= 2 else logger.error
            log(  # ⬆️ 每 30s 打一次，从 WARNING→ERROR
                "SessionDB commit still running %.1fs past ceiling "
                "(waited %.1fs, ceiling %.1fs); cannot abandon mid-flight",
                waited - ceiling, waited, ceiling
            )
            # 调用 on_commit_overrun 回调通知 UI（一次性）
            if not overrun_surfaced and on_commit_overrun:
                on_commit_overrun(waited, ceiling)
                overrun_surfaced = True
        # 分段再等一小会儿，不允许跳出去杀 worker
        try:
            result = future.result(timeout=remaining)
            return result
        except concurrent.futures.TimeoutError:
            continue
```

---

## 2. Phase 1：稳定性 + 成本优化（零用户感知，先稳后台）

**实施时间估算**：1.5 ~ 2 天  
**验收核心**：Prompt Cache 命中率↑30%；无抖动连续触发；大窗口配错不炸

### 2.1 P1-1：Proactive Prune 三阶段（Dedup + Summarize + Truncate）

**触发阈值**：`config.contextWindow × 0.48`（低于 MicroCompact 的 0.60，更早动手零成本清垃圾）  
**插入位置**：[transform-context.ts:L114-L117](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/transform-context.ts#L114-L117) 之间，在 MicroCompact 判断**之前**
**关键默认值来源（Hermes）**：
- `proactive_prune_min_result_chars=8000` → [context_compressor.py:L2827](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L2827) + [L2874-L2875](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L2874-L2875)（同时保证 ≥ _PRUNE_MIN_CHARS=200，见 [L537](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L537)）
- `proactive_prune_min_reclaim_tokens=4096` → [context_compressor.py:L2828](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L2828)（Prompt Cache Miss 代价论证：2~3×价差）
- Dedup 最小字符 ≥ 200 → [context_compressor.py:L3507-L3508](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3507-L3508)（`len(content) < _PRUNE_MIN_CHARS` 跳过）

#### 改动清单

| 改动 | 文件 | 精确位置 | 代码量 |
|------|------|---------|--------|
| ① 新增配置字段 | [types.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/types.ts#L149-L261) CompactConfig interface | `proactivePruneRatio?: number // 默认 0.48`；`proactivePruneMinResultChars?: number // 默认 8000`；`proactivePruneMinReclaimTokens?: number // 默认 4096` | +6 行 |
| ② Dedup（无损去重，全局范围不保护 tail） | [micro-compact.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/strategies/micro-compact.ts#L60-L138) | `export function dedupIdenticalToolResults(messages): AgentMessage[]`（使用 `crypto.createHash('md5')` 或简单哈希；`content >= 200 字符` 才参与；相同 → 改为 `[工具结果与更近期调用完全一致，已去重以节省空间]`） | +35 行 |
| ③ Truncate tool_call arguments（非 tail 截断） | [micro-compact.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/strategies/micro-compact.ts) | `export function truncateHeavyToolCallArguments(messages, protectTailCount, maxCharsPerArg=1500): AgentMessage[]`（截断 JSON 长字符串值，保留前后缀 `...`；结果仍须为合法 JSON） | +45 行 |
| ④ 三阶段流水线包装 + Reclaim Gate + Rearm | [micro-compact.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/strategies/micro-compact.ts) | `export function proactivePrune(messages, config, rearmState): { messages, changed, nextRearmTokens }`：先 Dedup（全范围）→ 取 protectTailCount=20 边界（**来源 Hermes protect_last_n 默认=20，见 [context_compressor.py:L2813](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L2813)**）→ Summarize（复用已有 microcompactToolResults 的 buildDeterministicToolSummary，但 protect=20 而非原 MicroCompact 的 8）→ Truncate → 计算 reclaim < 4096 就返回原数组 | +70 行 |
| ⑤ transform-context 插入调用 + 维护 Rearm 状态 | [transform-context.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/transform-context.ts#L85-L100) createTransformContext 闭包 | 新增 `let proactiveRearmTokens: number \| null = null` 状态；在 checkCompactionNeeded 返回 false 之后、MicroCompact 之前，插入 proactivePrune 判断与调用；回收不够 → 返回原数组不触发 onCompaction | +30 行 |

**Hermes 可直接复用的精确逻辑**：
- 三阶段调用顺序：[context_compressor.py:L3491-L3611](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3491-L3611)
- Reclaim Gate 4096 判断：[context_compressor.py:L3763-L3769](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3763-L3769)
- Rearm 跑道计算（三者取 max）：[context_compressor.py:L3774-L3779](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3774-L3779)

### 2.2 P1-2：绝对阈值天花板（防配置错最后一把闸）

**堆叠顺序（来源 Hermes，见 [context_compressor.py:L2736-L2748](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L2736-L2748) `_apply_threshold_tokens_cap`）**：Per-Model % → 全局默认 0.78 → 小窗口地板（`< 512K 强制 ≥ 75%`，**Lumii 新增**）→ **min(thresholdTokensCap)** 最后一把闸  
**默认值**：`200_000`（200K tokens，足够 1M 窗口的大模型在 ~20% 就被拦下）（Hermes cap 参数定义见 [L2825](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L2825) / [L2859-L2861](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L2859-L2861)）

#### 改动清单

| 改动 | 文件 | 精确位置 | 代码量 |
|------|------|---------|--------|
| ① 新增字段 | [types.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/types.ts#L149-L261) | `thresholdTokensCap?: number // 默认 200_000` | +2 行 |
| ② checkCompactionNeeded 加 min | [policy.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/policy.ts#L63-L75) | `const byPercent = Math.floor(config.contextWindow * percentThreshold); const cap = config.thresholdTokensCap ?? 200_000; const threshold = Math.min(byPercent, cap);` | +4 行 |
| ③ 小窗口地板（同位置） | [policy.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/policy.ts#L63-L75) | `if (config.contextWindow < 512_000) percentThreshold = Math.max(percentThreshold, 0.75);` | +2 行 |

### 2.3 Phase 1 验收标准（单测 + 日志可证）

| 测试 | 断言 |
|------|------|
| `proactive-prune.test.ts / Dedup 无损` | 3 条相同 bash 输出（各 3000 字符）→ 只保留最新 1 条原文，其余改引用；语义无损（因为完全相同） |
| `proactive-prune.test.ts / Reclaim Gate 不破坏` | 回收 3000 tokens（<4096）→ 返回原数组，`result === input`（同一对象引用）；onCompaction 不触发 |
| `proactive-prune.test.ts / Rearm 不抖动` | 先触发一次（回收 8K tokens → after=40K）；再构造 42K tokens（<40K+8K=48K 跑道）→ **不触发**；涨到 49K → 才允许再触发 |
| `policy.test.ts / 绝对 Cap 拦下配错` | contextWindow=1_000_000，triggerRatio=0.95 → threshold 应取 min(950K, 200K) = 200K |
| `transform-context 集成日志` | `totalTokens >= microThreshold 但 < triggerRatio` 时，日志打印 `ProactivePrune 触发: Dedup X 条 + Summarize Y 条 + Truncate Z 条，回收 N tokens（通过 Reclaim Gate/Rearm 或被拒绝）` |

---

## 3. Phase 2：体验优化（用户不再卡）+ 模型适配

**实施时间估算**：2 ~ 3 天  
**验收核心**：空闲回来发第一条消息不阻塞；慢模型 119s 不白花钱；小 8K 窗口模型在 70% 就压缩

### 3.1 P2-1：Per-Model 阈值覆盖

#### 改动清单

| 改动 | 文件 | 精确位置 | 代码量 |
|------|------|---------|--------|
| ① 新增配置字段 | [types.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/types.ts#L149-L261) | `modelThresholds?: Record<string, number> // 例 { "claude-sonnet": 0.35, "gpt-5.6-1M": 0.60 }`；`currentModelName?: string // 每轮 prompt 前由宿主注入` | +4 行 |
| ② 实现 resolveModelThreshold（最长子串匹配） | [policy.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/policy.ts#L63-L75) 前新增 | 直接移植 Hermes [L1820-L1843](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L1820-L1843) 的 Python → TypeScript：for-in 遍历 keys，`modelName.includes(key)` 且更长则覆盖 | +15 行 |
| ③ checkCompactionNeeded 接入 | [policy.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/policy.ts#L63-L75) | `percentThreshold = resolveModelThreshold(config.currentModelName, config.modelThresholds, config.triggerRatio);` | +2 行 |
| ④ AgentInstance 每轮注入 currentModelName | [agent-instance.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/agent/agent-instance.ts#L63-L150) | prompt 前将 `config.model.name` 写入 compactConfig.currentModelName | +3 行 |

### 3.2 P2-2：Idle Compaction（空闲触发）

**触发时机设计（Lumii 桌面端场景）**：
- 用户活动：每次 IPC（发送消息、点击 UI、切换会话）→ 刷新 `sessionManager.sessions[sessionKey].lastActivityAt = Date.now()`
- 后台轮询：主进程已有的 `cron-scheduler`（60s 间隔）→ 扫所有会话：
  1. `Date.now() - lastActivityAt >= idleCompactAfterSeconds`（默认 300s / 5 分钟）
  2. `estimateTokenCount(messages) > floorTokens`（floor = threshold × summaryTargetRatio，比压缩目标还小就不压）
  3. 无 `isCompacting` 锁且 failureCooldown 未激活
- 满足 → 异步调用 `bridge.compactContextAsync()`（非阻塞，后台跑）

#### 改动清单

| 改动 | 文件 | 代码量 |
|------|------|--------|
| ① CompactConfig 新增 `idleCompactAfterSeconds?: number // 默认 300；0=关闭` | [types.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/types.ts) | +2 行 |
| ② session-manager 维护 lastActivityAt：每次 handleInbound / 会话事件 → set | `apps/windows/src/main/channel/session-manager.ts` | +10 行 |
| ③ 移植 Hermes _should_idle_compact 纯谓词（可单测） | `packages/agent-runtime/src/compact/idle-trigger.ts`（新建） | +20 行 |
| ④ cron-scheduler 新增 60s 任务：扫会话 → 调 idle 谓词 → try bridge.compactContextAsync() | `apps/windows/src/main/agent-runtime/cron-scheduler.ts` + `bridge.ts` 新增 tryIdleCompact() | +50 行 |
| ⑤ UI：主窗底部 Toast 「后台压缩完成：释放 N tokens」（可选，仅在用户回来时显示） | `apps/windows/src/renderer/hooks/useChat/index.ts` 监听 onCompaction 事件 + idle 标记 | +15 行 |

**Hermes 参考实现**：
- 纯谓词 _should_idle_compact：[turn_context.py:L368-L400](file:///D:/open-source/hermes-agent/agent/turn_context.py#L368-L400)
- 触发位置（用户回来时先压再跑）：[turn_context.py:L782-L851](file:///D:/open-source/hermes-agent/agent/turn_context.py#L782-L851)

### 3.3 P2-3：Progress-Aware 双预算超时

#### 改动清单

| 改动 | 文件 | 代码量 |
|------|------|--------|
| ① 新建 ProgressFence 类（对应 Hermes CompressionCommitFence 简化版） | `packages/agent-runtime/src/compact/progress-fence.ts`（新文件） | ~90 行 |
| ② SummaryGeneratorFn 协议扩展：支持 onProgress 回调（touch_progress 钩子） | [types.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/types.ts#L65-L69) SummaryGeneratorFn 新增可选第 4 个参数 options `{ onProgress?: () => void }` | +4 行 |
| ③ runSummaryStage 接入：while 循环 + wait_slice 而非简单 setTimeout | [summary-compact.ts](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/strategies/summary-compact.ts#L70-L149) | +60 行 |

**ProgressFence 类 TypeScript 实现骨架（移植 Hermes [L450-L505](file:///D:/open-source/hermes-agent/agent/conversation_compression.py#L450-L505) + 等待循环 [L943-L1050](file:///D:/open-source/hermes-agent/agent/conversation_compression.py#L943-L1050)）**：

```typescript
// progress-fence.ts（新建）
export class ProgressFence {
  private lastProgressAt = Date.now();
  private startedAt = Date.now();
  private commitPhase = false;  // Phase 3 用，Phase 2 先搭接口

  constructor(
    readonly idleTimeoutMs = 120_000,   // 距上次"看到进度"120s 才认为挂了
    readonly totalCeilingMs = 600_000,  // 无论如何最多 10min
  ) {}

  /** 流式摘要每收到一个新 token 调用一次 */
  touchProgress(): void { this.lastProgressAt = Date.now(); }

  /** 当前距上次进度（秒），供日志 */
  secondsSinceProgress(): number { return (Date.now() - this.lastProgressAt) / 1000; }

  /** 计算下一次等待的时间片（min(剩余idle, 剩余ceiling)） */
  nextWaitSliceMs(): number {
    const waited = Date.now() - this.startedAt;
    const remainingCeiling = this.totalCeilingMs - waited;
    const remainingIdle = this.idleTimeoutMs - (Date.now() - this.lastProgressAt);
    if (remainingCeiling <= 0) return 0;
    return Math.max(5, Math.min(remainingIdle, remainingCeiling));
  }

  /** 是否还有命（还有进度 且 没到封顶）→ 续命返回 true */
  shouldKeepAlive(): boolean {
    const waited = Date.now() - this.startedAt;
    const sinceProgress = Date.now() - this.lastProgressAt;
    return sinceProgress < this.idleTimeoutMs && waited < this.totalCeilingMs;
  }
}

/**
 * 包装一个 Promise + ProgressFence 的等待循环（对应 Hermes while 循环）
 * @param promiseFactory 每次传 fence 给调用方，调用方在流式摘要中调 fence.touchProgress()
 * @returns 成功时的结果；超时返回 null（由上层降级占位）
 */
export async function withProgressTimeout<T>(
  fence: ProgressFence,
  promiseFactory: (fence: ProgressFence) => Promise<T>,
): Promise<T | null> {
  const race = (ms: number) => new Promise(r => setTimeout(() => r('TIMEOUT'), ms));
  const workerPromise = promiseFactory(fence);

  while (true) {
    const slice = fence.nextWaitSliceMs();
    if (slice <= 0) {
      // 到绝对封顶了：如果 commitPhase=true（Phase3）→ 继续分段等；否则 → 超时放弃
      if (!fence.commitPhase) return null;
      // commit phase: 永不中断，继续分段等，日志由调用方或这里打 WARNING→ERROR
    }
    const result = await Promise.race([workerPromise, race(slice)]);
    if (result !== 'TIMEOUT') return result as T;
    // 时间片到了 → 检查能否续命
    if (!fence.shouldKeepAlive() && !fence.commitPhase) return null;
  }
}
```

### 3.4 Phase 2 验收标准

| 测试 | 断言 |
|------|------|
| `per-model-threshold.test.ts / 最长子串` | modelThresholds=`{ "claude": 0.50, "claude-sonnet": 0.35 }`；modelName=`"claude-sonnet-4-20250514"` → 命中 0.35（更长 key 优先） |
| `idle-trigger.test.ts / _should_idle_compact 谓词` | idleGap=299s → false；301s → true；tokens=5K < floor=20K → false；cooldown=true → false |
| 手动模拟：空闲 301s 后回来 | 后台日志打印「Idle Compaction 触发：会话 X 空闲 301s ≥ 300s，tokens Y ≥ Z floor」且用户发第一条消息不等待摘要 |
| `progress-fence.test.ts / 慢模型续命` | fence.touchProgress() 每 5s 调一次 → 200s 后 shouldKeepAlive() 仍 true；停止调 → 121s 后 shouldKeepAlive()=false |
| 集成：模拟摘要 119s 仍在输出 token → 不被杀，第 121s 返回成功；无 token 121s → 超时降级占位 |

---

## 4. Phase 3：一致性兜底（永不丢数据）+ 打磨优化

**实施时间估算**：1 ~ 2 天  
**验收核心**：SessionDB 无半压缩分叉；压缩失败回滚零副作用；压力测试不崩溃

### 4.1 P3-1：Commit Fence + 落库原子化

**对应 Hermes 机制**：`CompressionCommitFence.begin_commit()` 后永不中断（[conversation_compression.py:L539-L565](file:///D:/open-source/hermes-agent/agent/conversation_compression.py#L539-L565)），配合 SessionDB 事务

#### 改动清单

| 改动 | 文件 | 代码量 |
|------|------|--------|
| ① ProgressFence.commitPhase + beginCommit() + finishCommit() 方法扩展 | `packages/agent-runtime/src/compact/progress-fence.ts` | +15 行 |
| ② bridge.compactContextAsync() 的落库操作 BEGIN TRANSACTION / COMMIT / ROLLBACK 包裹 | `apps/windows/src/main/agent-runtime/bridge.ts`（compactContextAsync 方法） | +12 行 |
| ③ beginCommit() 时序：调 DB 写入**之前** set，写入完成后 clear；写入过程中 fence.commitPhase=true → withProgressTimeout 永不中断外层循环 | `bridge.ts` compactContextAsync + 调用 withProgressTimeout 处 | +10 行 |
| ④ overrun WARNING→ERROR 升级日志：commitPhase 超时后每 30s 打一次，第 1/2 次 WARNING，第 3 次起 ERROR | `progress-fence.ts` wait 循环 + logger | +15 行 |

### 4.2 P3-2：压缩失败回滚与重试冷却增强

| 改动 | 说明 | 代码量 |
|------|------|--------|
| ① failure_cooldown：上次压缩失败后 N 分钟（默认 10min）内不再尝试 Idle Compaction | 对应 Hermes `_should_idle_compact` 的 `cooldown_active` 参数；在 compact failure 后设置时间戳，下次触发前检查 | +10 行 |
| ② anti_thrash：连续 N 次压缩后 savings < 10% → 冷却 1 小时，防无限压缩链 | 复用已有 [RecompactionTracker](file:///d:/my-project/open-source/lumii/packages/agent-runtime/src/compact/post-compact.ts#L20-L38)，加 savings 比例检查 | +20 行 |

### 4.3 P3-3（可选低优先级）：Hermes Pass 4 尾部压力降级逻辑移植

对应 Hermes [context_compressor.py:L3613-L3686](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3613-L3686) 的压力降级 pass。在 Lumii 的 hard-trim 已经兜底的前提下，此优化 P3 再做。代码量 +60 行。

---

## 5. 决策记录（逐行代码核查后的最终结论）

| 决策点 | 选项 A | 选项 B | 选择 | 依据（附精确代码引用） |
|--------|--------|--------|------|----------------------|
| Dedup 保护范围 | 保护 tail 20 条 | **全范围可做** | **B** | Hermes [L3491-L3515](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3491-L3515) 从末尾到开头遍历 Dedup，无 prune_boundary 判断；注释明确：「dedup 100% 无损，不需要保护范围」 |
| Proactive 触发 | 到线就做 | **到线 + 跑道复位** | **B** | Hermes [L3738-L3740](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L3738-L3740) 硬检查 `before < _proactive_prune_rearm_tokens → return`；Hermes 还做了 DB 持久化 rearm（L3780-L3789），Lumii Phase1 可进程内先只内存存 |
| Reclaim Gate 阈值 | 1024 | **4096** | **4096** | Hermes 默认 4096（[L2828](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L2828)），其设计文档论证：「2~3 倍 Cache Miss 差价 × 后续 1M tokens ≈ 省下 $2，1024 抵不上」 |
| 超时模式 | 简单墙钟 120s | **双预算 + progress-aware** | **B** | Hermes 等待循环 [L943-L1050](file:///D:/open-source/hermes-agent/agent/conversation_compression.py#L943-L1050)，wait_slice 每次动态 `max(idle - since_progress, ceiling - waited)` 的 min；而非固定 |
| commit-phase 可中断？ | 到点就杀 | **永不中断** | **永不中断** | Hermes [L1008-L1050](file:///D:/open-source/hermes-agent/agent/conversation_compression.py#L1008-L1050) 分段继续等 + WARNING→ERROR 升级，绝不杀 |
| idle 触发窗口 | 30s | **300s 默认 + 可配** | **300s** | Hermes 由配置 `idle_compact_after_seconds` 控制，文档明确 300s 防止「每 30s 倒杯水就触发一次」 |
| threshold 匹配 | 精确全名匹配 | **最长子串匹配** | **B** | Hermes [resolve_model_threshold](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L1820-L1843) 用 `if key in model and len(key) > len(best_key)` 兼容日期后缀 |
| absolute threshold_tokens 位置 | 最外层包裹 | **最末 min 限制** | **最末** | Hermes `_apply_threshold_tokens_cap` 在 ratio 计算完后再 `min(cap, window)` 覆盖（[L2736-L2748](file:///D:/open-source/hermes-agent/agent/context_compressor.py#L2736-L2748)），保证「无论配置什么，绝不超过 200K」 |

---

## 6. 风险与 Killswitch 降级策略

| 风险 | 发生条件 | 降级开关（新增 killswitch） |
|------|---------|--------------------------|
| Dedup 哈希碰撞误判（极端） | 不同 tool 输出 MD5 前 12 位一致（概率 < 1e-15） | `compactConfig.enableProactiveDedup = false` → 跳过 Dedup 阶段，走 Summarize/Truncate 两阶段 |
| Reclaim Gate 太严（回收 4095 永远不提交） | 每次只回收一点点 | `compactConfig.proactivePruneMinReclaimTokens = 1024` 临时调低 |
| ProgressFence onProgress 钩子未被调用（provider 不支持流） | 降级到墙钟超时（等效现状） | 自动降级：未调 fence.touchProgress() 120s 后正常超时，与现状一致 |
| Idle Compaction 撞车用户发消息 | isCompacting 锁 + check lastActivityAt | 发现 lastActivityAt < 3s 前 → 放弃本次后台压缩 |
| beginCommit 后 SQLite 写真挂了（极端） | fence.commitPhase=true 永久等 | 主进程 watchdog 打 ERROR 并弹 UI「压缩执行时间过长，请检查磁盘」，但**仍不杀线程**（等 SQLite 自己超时或返回） |

---

## 7. 可量化验收指标（每个 Phase 结束后跑）

| Phase | 指标 | 基线（当前） | 目标 |
|-------|------|-------------|------|
| **Phase 1** | 每 100 轮 Proactive Prune 实际提交次数 / 触发扫描次数 比 | ？（待采集基线） | ≥ 40% 触发通过 Reclaim Gate（<40% 说明回收效率低，调整阈值） |
| | 连续压缩（<3 turn 又触发）次数 / 100 轮 | ？ | **0**（Rearm 跑道保证） |
| | 人为配错 1M 窗口 triggerRatio=0.95 时实际触发阈值 | 950K（现状炸） | **≤ 200K**（绝对 Cap 拦下） |
| **Phase 2** | 用户回来后第一条消息的端到端延迟（Idle 命中场景） | 30~60s 阻塞（现状先压后跑） | **< 2s**（压完了） |
| | 慢模型摘要因墙钟超时被误杀的费用损失（模拟测试） | 假设 $X | **减少 90% 以上** |
| | 8K 窗口小模型（如 `qwen2.5-7b`）达到 6K 才触发的占比 | 100%（一刀切 0.78 → 6240） | **改为 0.70 → 5600 触发，永不 8K 顶爆** |
| **Phase 3** | 模拟压缩中途杀进程后的 SessionDB 数据分叉率（100 次压力测试） | 可能发生（无事务） | **0 次**（BEGIN/COMMIT 保证原子） |
| | beginCommit 超过 600s 后线程仍存活 + 日志正确升级 | 无 | WARNING→ERROR 日志可见，会话数据完整不丢 |
