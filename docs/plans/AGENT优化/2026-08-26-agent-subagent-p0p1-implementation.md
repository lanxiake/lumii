# Agent / 子 Agent 协作 P0+P1 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 打通异步子 Agent 完成投递闭环，统一深度/并发语义，并补齐生命周期控制、摘要护栏、停滞检测与可观测性（不含 worktree / MOA）。

**Architecture:** 在 `packages/agent-runtime` 新增 `SubagentBroker`（并发帽、完成队列、摘要截断、可选 stale），由 `AgentOrchestrator` 驱动；Windows bridge 负责投递泵（idle → `prompt(origin=internal)`，running → `followUp`）、IPC 事件与提示词诚实化。不引入 SQLite 跨进程恢复。

**Tech Stack:** TypeScript、Vitest、`AgentOrchestrator` / `AgentRegistry` / `AgentInstance`、pi-agent-core followUp/prompt、既有 `persistLargeResult`。

**设计来源:** `docs/design/AGENT优化/2026-08-26-hermes-moa-vs-lumii-对比与优化.md` 阶段 A/B  
**原则:** TDD、小步提交、YAGNI（不做 HMAC / worktree / MOA）

---

## 0. 代码实勘结论（实施前必读）

### 0.1 现状锚点

| 能力 | 文件 | 现状 |
|------|------|------|
| spawn sync/async | `packages/agent-runtime/src/agent/orchestrator.ts` | async 仅 `void prompt`，无完成投递、不 destroy |
| 深度 | 同上 `MAX_SPAWN_DEPTH = 3` | bridge **忽略** `spawnDepth`；`createChildInstance` 强制 `canSpawnSubAgents: false` → 实际深度 1 |
| 子工具屏蔽 | `apps/windows/.../bridge-utils.ts` `CHILD_AGENT_DISALLOWED_TOOLS` | `spawn_agent` / `send_message` |
| 并发帽 | `AgentDefinition.subagentMaxConcurrent` | 仅类型/API 映射，**未强制** |
| 父→子控制 | — | 无；仅有用户侧 `AgentInstance.steer` / `abort` |
| 大结果落盘 | `packages/agent-runtime/src/tools/tool-result-storage.ts` | 可复用 `persistLargeResult` |
| 协作提示词 | `.../prompt/sections/agent-collaboration-section.ts` | 仍写「async 后 wait dependsOn」 |

### 0.2 关键运行时约束（易踩坑）

1. **`followUp` 不会在 idle 时自动开跑**  
   pi-agent-core 仅在**已有** `prompt` 循环内通过 `getFollowUpMessages` 消费队列。父已 idle 时只 `followUp` → 消息永不出队。  
   **投递规则必须是：**
   - 父 `state === "running"` → `followUp(msg)`（本轮结束后作为续轮消费）
   - 父 `state === "idle"`（或 paused 恢复后）→ `prompt(msg, undefined, "internal")`（真正新回合）
   - 禁止改写当前 tool_result / 插入 assistant 间隙

2. **并发 `prompt` 会抛错**  
   父正在 streaming 时不可再 `prompt`；必须走 followUp 或入队等待 `agent:end` / idle。

3. **async 子实例目前不 destroy** → 必须在投递完成后 `destroy`，否则 registry 泄漏。

4. **sync 路径已 destroy**；摘要截断应在 destroy **之前**收集完整 output。

---

## 1. 范围与验收

### P0（必须先合）

| ID | 能力 | 验收 |
|----|------|------|
| A1 | 异步完成投递 | 双 async 子 Agent 结束后，父各收到一次内部回合/续轮，并能综合回复 |
| A2 | 深度语义 = 1 | `MAX_SPAWN_DEPTH=1`；提示词与代码一致；深度超限单测绿 |
| A3 | 并发帽 | 超限 spawn 返回明确 error；默认 5、硬顶 10 |
| A4 | 提示词诚实化 | Task Orchestration 描述「系统会注入完成通知」，不再假装模型能 wait async |

### P1（P0 之后）

| ID | 能力 | 验收 |
|----|------|------|
| B1 | 生命周期 API | `listChildren` / `interruptChild` / `steerChild`；非后代拒绝 |
| B2 | async stale | 无进度超时 → abort 子 + 向父投递 STALE |
| B3 | 摘要护栏 | sync/async 超长落盘；VERDICT 行保留 |
| B4 | allowedTools ⊆ 父工具集 | 越权参数 error；不能恢复 spawn/send |
| B5 | 可观测性 | IPC `agent:subagent:completed` + activity 字段扩展 + 结构化日志 |

### 非目标

- Git worktree、orchestrator 嵌套深度 >1、MOA、SQLite 跨进程委派恢复、HMAC 句柄

---

## 2. 任务依赖

```
P0-T0  分支 + 基线测试
   ↓
P0-T1  SubagentBroker 骨架（队列/并发/配置常量）+ 单测
   ↓
P0-T2  Orchestrator 接入：深度=1、并发帽、async 完成收集
   ↓
P0-T3  Bridge 投递泵（idle→prompt / running→followUp）+ destroy
   ↓
P0-T4  提示词诚实化
   ↓
P0-T5  P0 集成验收 + 提交
   ↓
P1-T1  生命周期 API（list/interrupt/steer）+ 后代校验
   ↓
P1-T2  Stale 监控
   ↓
P1-T3  摘要截断 + persistLargeResult
   ↓
P1-T4  allowedTools 子集校验
   ↓
P1-T5  IPC / activity / 日志
   ↓
P1-T6  全量测试 + 文档回写设计 README
```

---

## 3. 前置准备（P0-T0）

**Step 1: 建分支**

```bash
cd /e/my-project/open-source/lumii
git checkout -b feat/agent-subagent-p0p1
```

**Step 2: 跑基线**

```bash
pnpm --filter ./packages/agent-runtime test -- src/agent/__tests__/orchestrator.test.ts
pnpm --filter ./apps/windows test -- src/main/agent-runtime/bridge-lifecycle.test.ts
```

预期：现有用例通过（记下失败则先修或记入基线）。

**Step 3: Commit chore（可选）** — 仅当有文档已暂存时再提交；本计划文档可另提交。

---

## 4. P0 任务

### P0-T1: SubagentBroker 骨架

**Files:**
- Create: `packages/agent-runtime/src/agent/subagent-broker.ts`
- Create: `packages/agent-runtime/src/agent/__tests__/subagent-broker.test.ts`
- Modify: `packages/agent-runtime/src/agent/index.ts`（导出）
- Modify: `packages/agent-runtime/src/index.ts`（如需对外导出类型）

**职责（纯编排辅助，无 Electron）：**

```typescript
/** 委派默认配置（写严读宽：调用方缺省走这里） */
export const SUBAGENT_DEFAULTS = {
  maxSpawnDepth: 1,
  maxConcurrentChildren: 5,
  hardMaxConcurrent: 10,
  maxSummaryChars: 24_000,
  staleIdleMs: 180_000,
  staleCheckIntervalMs: 30_000,
} as const;

export type SubagentRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stale";

export interface SubagentRunRecord {
  readonly childId: string;
  readonly parentId: string;
  readonly name: string;
  readonly mode: "sync" | "async";
  status: SubagentRunStatus;
  readonly startedAt: number;
  lastProgressAt: number;
  outputText: string;
  errorMessage?: string;
}

export interface SubagentCompletionPayload {
  readonly childId: string;
  readonly parentId: string;
  readonly name: string;
  readonly status: Exclude<SubagentRunStatus, "running">;
  readonly summary: string;
  readonly spillPath?: string;
}
```

Broker 方法（首版）：

| 方法 | 行为 |
|------|------|
| `tryAcquireSlot(parentId, limit)` | 该父下 `status===running` 计数；超限返回 false |
| `releaseSlot` / `registerRun` / `updateProgress` / `finalizeRun` | 维护 Map |
| `enqueueCompletion` / `drainCompletions(parentId)` | 完成载荷队列 |
| `formatCompletionMessage(payload)` | 生成投递给父的固定模板文案 |
| `countRunning(parentId)` | 供并发帽 |

完成文案模板（固定，便于单测）：

```text
[SUBAGENT_COMPLETE]
name: <name>
instanceId: <childId>
status: succeeded|failed|cancelled|stale
summary:
<summary>
```

**Step 1: 写失败单测**（acquire 超限、enqueue/drain、format）

**Step 2: 实现最小 Broker**

**Step 3: 跑测**

```bash
pnpm --filter ./packages/agent-runtime test -- src/agent/__tests__/subagent-broker.test.ts
```

**Step 4: Commit**

```bash
git add packages/agent-runtime/src/agent/subagent-broker.ts \
  packages/agent-runtime/src/agent/__tests__/subagent-broker.test.ts \
  packages/agent-runtime/src/agent/index.ts packages/agent-runtime/src/index.ts
git commit -m "$(cat <<'EOF'
feat(agent-runtime): add SubagentBroker for concurrency and completion queue

EOF
)"
```

---

### P0-T2: Orchestrator 接入深度 / 并发 / async 收尾钩子

**Files:**
- Modify: `packages/agent-runtime/src/agent/orchestrator.ts`
- Modify: `packages/agent-runtime/src/agent/__tests__/orchestrator.test.ts`
- Modify: `packages/agent-runtime/src/types/agent-definition.ts`（注释：`subagentMaxConcurrent` 默认语义）

**改动要点：**

1. `MAX_SPAWN_DEPTH`：**改为 `1`**（与产品扁平委派一致）。注释写明：更深委派属 P2，且需 bridge 放开 `canSpawnSubAgents`。

2. 构造 `AgentOrchestrator` 时持有 `SubagentBroker`（可 `new` 内部默认，或 deps 注入便于测）。

3. `spawnAgent` 开头：
   - 解析 `limit = clamp(parentDef?.subagentMaxConcurrent ?? DEFAULT, 1, HARD_MAX)`  
     （父定义需 `deps.getInstance(parentId)` → 若拿不到 definition，用 DEFAULT）
   - `if (!broker.tryAcquireSlot(parentId, limit)) return { status:"error", message: "..." }`

4. **async 路径重写骨架：**

```typescript
// 伪代码 — 实现时补全错误路径
broker.registerRun({ childId, parentId, name, mode: "async", ... });
const child = deps.getInstance(childInstanceId);
const unsub = child?.subscribe((ev) => {
  if (ev.type === "message:delta" || ev.type === "tool:start") {
    broker.updateProgress(childInstanceId);
  }
  if (ev.type === "message:end") {
    // 累积 output（与 sync 相同）
  }
});
void (async () => {
  try {
    await deps.prompt(childInstanceId, params.prompt);
    await child?.waitForIdle();
    broker.finalizeRun(childInstanceId, "succeeded", outputText);
  } catch (e) {
    broker.finalizeRun(childInstanceId, "failed", "", String(e));
  } finally {
    unsub?.();
    const payload = broker.buildCompletion(childInstanceId); // 含 format summary
    broker.enqueueCompletion(payload);
    deps.onAsyncSubagentComplete?.(payload); // bridge 注入投递泵
    // destroy 由 bridge 投递后再调，或在此调 deps.destroy — 推荐 bridge 投递成功后再 destroy
  }
})();
```

5. 扩展 `AgentOrchestratorDeps`：

```typescript
readonly onAsyncSubagentComplete?: (payload: SubagentCompletionPayload) => void;
readonly getParentMaxConcurrent?: (parentInstanceId: string) => number | undefined;
```

6. sync 路径：同样 `registerRun` / `release`（可用 finalize 后立即释放槽，不入完成队列）。

**单测追加：**
- depth>=1 再 spawn（模拟 `_spawnDepth: 1`）→ error  
- 并发：连续 async 超过 limit → 第 N+1 个 error  
- async：mock child waitForIdle 后 → `onAsyncSubagentComplete` 被调用一次  

**跑测：**

```bash
pnpm --filter ./packages/agent-runtime test -- src/agent/__tests__/orchestrator.test.ts
```

**Commit:** `feat(agent-runtime): enforce subagent depth=1, concurrency, async completion hook`

---

### P0-T3: Bridge 投递泵

**Files:**
- Modify: `apps/windows/src/main/agent-runtime/bridge-lifecycle.ts`（`ensureOrchestrator` 注入回调）
- Create: `apps/windows/src/main/agent-runtime/subagent-delivery.ts`（纯函数/小类，便于单测）
- Create: `apps/windows/src/main/agent-runtime/subagent-delivery.test.ts`
- Modify: 必要时 `bridge.ts` 导出/转发

**投递算法（必须写进单测）：**

```typescript
/**
 * 将子 Agent 完成载荷投递给父实例。
 * running → followUp；idle → prompt(origin=internal)；其他 → 延后队列。
 */
export async function deliverSubagentCompletion(opts: {
  parent: AgentInstance;
  payload: SubagentCompletionPayload;
  format: (p: SubagentCompletionPayload) => string;
}): Promise<"followUp" | "prompt" | "deferred"> {
  const msg = opts.format(opts.payload);
  const state = opts.parent.state;
  if (state === "running") {
    opts.parent.followUp(msg);
    return "followUp";
  }
  if (state === "idle") {
    await opts.parent.prompt(msg, undefined, "internal");
    return "prompt";
  }
  // paused / error / aborted：由调用方把 payload 留在 broker 队列，等 idle 再 drain
  return "deferred";
}
```

**bridge 接线：**

1. `onAsyncSubagentComplete`：
   - 取 parent instance  
   - `deliverSubagentCompletion`  
   - 若 `deferred`，监听父 `agent:state-change` → idle 时 `drainCompletions` 再投  
   - 成功后 `destroy(childId)` + `pushActivitySnapshot`  
2. 父 `prompt` 使用已有 `deps.prompt` 包装（若需 conversation 落库，走与 cron/internal 相同路径；若 `AgentInstance.prompt` 直接调即可先通，再视 UI 是否显示内部消息微调）。

**注意：** 内部回合文案会进入用户可见对话——这是预期（主 Agent 才能综合）。若未来要隐藏，再加 `meta.internal`（本阶段不做）。

**单测：** mock parent.state 三种分支。

**跑测：**

```bash
cd apps/windows && npx vitest run src/main/agent-runtime/subagent-delivery.test.ts
```

**Commit:** `feat(windows): deliver async subagent completions via followUp or internal prompt`

---

### P0-T4: 提示词诚实化

**Files:**
- Modify: `packages/agent-runtime/src/prompt/sections/agent-collaboration-section.ts`
- Create: `packages/agent-runtime/src/prompt/sections/__tests__/agent-collaboration-section.test.ts`（若目录惯例不同，就近放 `prompt/__tests__/`）

**改写 `buildTaskOrchestrationSection` 中 async 相关句，例如：**

```text
Prefer `spawn_agent mode=sync` when you need the result in the same turn.
Use `mode=async` only for parallel long work; the system will inject a
`[SUBAGENT_COMPLETE]` follow-up/new turn when each child finishes.
Do not invent results before that notification arrives.
When using todos with async children, mark tasks complete only after the
corresponding `[SUBAGENT_COMPLETE]` arrives.
```

删除或改写「wait for all dependsOnIndex」中暗示模型能同步等待 async 的表述。

**单测：** section 字符串包含 `SUBAGENT_COMPLETE`，不包含旧的误导短语（选定一个旧短语做 `not.toContain`）。

**Commit:** `fix(agent-runtime): align task orchestration prompt with async delivery`

---

### P0-T5: P0 验收清单

手动 / 半自动：

1. 单元：broker + orchestrator + delivery + prompt section 全绿。  
2. （可选）Dev 启动后：主对话要求「并行两个 explore async」，确认两条 `[SUBAGENT_COMPLETE]` 出现且主 Agent 综合回复。  
3. 超并发：临时把 limit 设 1，连 spawn 两个 async，第二个立即 error。

```bash
pnpm --filter ./packages/agent-runtime test -- src/agent
pnpm --filter ./apps/windows test -- src/main/agent-runtime/subagent-delivery.test.ts
pnpm --filter ./packages/agent-runtime exec tsc --noEmit
```

**Commit:** 若有修修补补，`test(agent-runtime): cover P0 subagent delivery acceptance`

---

## 5. P1 任务

### P1-T1: 生命周期 API

**Files:**
- Modify: `packages/agent-runtime/src/agent/orchestrator.ts`（或 `subagent-broker.ts` + orchestrator 委托）
- Modify: `packages/agent-runtime/src/agent/agent-registry.ts`（若需 `isDescendant(ancestor, node)`）
- Modify: `packages/agent-runtime/src/agent/__tests__/orchestrator.test.ts`

**API：**

```typescript
listChildren(parentId: string): readonly { childId; name; status; mode; startedAt; lastProgressAt }[]
interruptChild(parentId: string, childId: string): { ok: true } | { ok: false; message: string }
steerChild(parentId: string, childId: string, text: string): { ok: true } | { ok: false; message: string }
```

规则：

- `isDescendant`：沿 `registry.getParentId` 上行，必须命中 `parentId`。  
- `interruptChild`：`child.abort()` + `finalizeRun(..., "cancelled")` + 入完成队列（让父知道）。  
- `steerChild`：`child.steer(text)`，不中断当前工具。

Bridge（可选本阶段）：IPC command 暂可不做；先保证 runtime API + 单测。若 Chat UI 已有中断入口，再挂 `bridge` 方法。

**Commit:** `feat(agent-runtime): add subagent interrupt/steer/listChildren APIs`

---

### P1-T2: Stale 监控

**Files:**
- Modify: `packages/agent-runtime/src/agent/subagent-broker.ts`
- Modify: `packages/agent-runtime/src/agent/__tests__/subagent-broker.test.ts`
- Modify: bridge 启动/销毁时 `broker.startStaleMonitor` / `stop`

**逻辑：**

- 每 `staleCheckIntervalMs` 扫描 `status===running` 且 `mode===async` 的 run。  
- 若 `now - lastProgressAt > staleIdleMs` → 回调 `onStale(childId)` → orchestrator/bridge `abort` + finalize `stale` + 投递。  
- 单测用注入 `nowFn` / 短阈值，**不要**真 sleep 180s。

默认 `staleIdleMs: 180_000`（桌面可比 Hermes 450s 更紧；可后续配置化）。

**Commit:** `feat(agent-runtime): stale-detect idle async subagents`

---

### P1-T3: 摘要护栏

**Files:**
- Create: `packages/agent-runtime/src/agent/subagent-summary.ts`
- Create: `packages/agent-runtime/src/agent/__tests__/subagent-summary.test.ts`
- Modify: orchestrator sync 返回前、async finalize 前调用

**行为：**

```typescript
/**
 * 截断子 Agent 输出；超长则 persistLargeResult；保留末尾 VERDICT 行（若有）。
 */
export function guardSubagentSummary(
  text: string,
  opts: { maxChars?: number; toolName?: string; cwd?: string },
): { summary: string; spillPath?: string }
```

- `maxChars` 默认 `SUBAGENT_DEFAULTS.maxSummaryChars`（24_000）。  
- 若存在 `VERDICT:` 行：截断正文时把该行追加回 summary 末尾。  
- 落盘复用 `persistLargeResult`（`toolName: "subagent_summary"`）。

sync：`output` 使用 guard 后文本。  
async：completion `summary` 使用 guard 后文本。

**Commit:** `feat(agent-runtime): cap subagent summary with spill and VERDICT keep`

---

### P1-T4: allowedTools 子集校验

**Files:**
- Modify: `packages/agent-runtime/src/agent/orchestrator.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge-lifecycle.ts`（确保 createChild 继续剥 spawn/send）
- Modify: tests

**规则：**

```typescript
const FORBIDDEN = new Set(["spawn_agent", "send_message"]);
const parentTools = new Set(deps.getInstance(parentId)?.getTools().map(t => t.name) ?? []);

if (params.allowedTools?.length) {
  for (const raw of params.allowedTools) {
    const name = raw.replace(/\(.*\)$/, ""); // 支持 bash(git:*) → bash
    if (FORBIDDEN.has(name) || (parentTools.size > 0 && !parentTools.has(name))) {
      return { status: "error", message: `allowedTools contains unauthorized tool: ${raw}` };
    }
  }
}
```

父尚无 tools（测试 mock）时：至少拒绝 FORBIDDEN；子集校验在 `parentTools.size>0` 时启用。

**Commit:** `fix(agent-runtime): validate spawn allowedTools against parent tool set`

---

### P1-T5: IPC 与 activity 可观测性

**Files:**
- Modify: `apps/windows/src/shared/agent-runtime-events.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge-lifecycle.ts` `pushActivitySnapshot`
- Modify: 投递成功处 `forwardIpcEvent`

**新增事件：**

```typescript
export interface AgentSubagentCompletedEvent {
  readonly type: 'agent:subagent:completed'
  readonly parentInstanceId: string
  readonly childInstanceId: string
  readonly name: string
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'stale'
  readonly summaryPreview: string // 截断到 200 字供 UI
}
```

**扩展 activity snapshot agent 项（可选字段，向后兼容）：**

```typescript
mode?: 'sync' | 'async'
status?: string
startedAt?: number
lastProgressAt?: number
```

日志：`[Subagent] spawn|complete|stale|interrupt` + ids。

渲染进程：本阶段**可不改 UI**（事件先可达即可）；若 `ToolCallCard` 易接则加 preview（非阻塞）。

**Commit:** `feat(windows): emit agent:subagent:completed and richer activity snapshot`

---

### P1-T6: 收尾验收

```bash
pnpm --filter ./packages/agent-runtime test -- src/agent
pnpm --filter ./apps/windows test -- src/main/agent-runtime/subagent-delivery.test.ts
pnpm --filter ./packages/agent-runtime typecheck
# 若 windows 有独立 typecheck：
pnpm --filter ./apps/windows typecheck
```

回写：

- `docs/design/AGENT优化/README.md` 增加「P0/P1 计划已输出，实施状态：…」  
- 本计划文首勾选完成项

**Commit:** `docs: mark agent subagent P0/P1 plan progress`

---

## 6. 建议模块落点总览

```
packages/agent-runtime/src/agent/
  subagent-broker.ts          # 新建：并发/队列/stale/format
  subagent-summary.ts         # 新建：截断+spill
  orchestrator.ts             # 改：深度/并发/async 钩子/生命周期 API
  agent-registry.ts           # 改：isDescendant（可选）
  index.ts                    # 导出

apps/windows/src/main/agent-runtime/
  subagent-delivery.ts        # 新建：投递策略
  bridge-lifecycle.ts         # 改：回调接线、snapshot、destroy
  bridge-utils.ts             # 一般不动（屏蔽列表已够）

packages/agent-runtime/src/prompt/sections/
  agent-collaboration-section.ts  # 改：诚实提示词

apps/windows/src/shared/
  agent-runtime-events.ts     # 改：新 IPC 事件类型
```

---

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| idle 误用 followUp 导致「完成了但父永不读」 | delivery 单测锁定两分支；代码注释引用 pi-agent 行为 |
| 内部 prompt 与用户输入竞态 | 投递前检查 state；running 只用 followUp |
| destroy 过早导致 UI 丢子轨迹 | 先 IPC completed，再 destroy；activity 推送 |
| 摘要截断弄丢 VERDICT | `guardSubagentSummary` 单测强制保留 |
| stale 误杀慢模型 | 阈值可配；仅 async；进度事件刷新 lastProgressAt |

---

## 8. 工作量估计

| 阶段 | 任务 | 估计 |
|------|------|------|
| P0 | T0–T5 | 2–3 天 |
| P1 | T1–T6 | 2–3 天 |
| **合计** | | **约 4–6 天** |

---

## 9. 执行方式

Plan complete and saved to `docs/plans/AGENT优化/2026-08-26-agent-subagent-p0p1-implementation.md`.

**两种执行选项：**

1. **Subagent-Driven（本会话）** — 每任务新开 subagent，任务间审查，快速迭代  
2. **Parallel Session（独立会话）** — 新会话按 `executing-plans` 逐步执行并设检查点  

需要我按哪一种开始实施？
