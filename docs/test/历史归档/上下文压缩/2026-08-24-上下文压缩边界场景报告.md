# 上下文压缩 — 边界与全场景覆盖报告

**日期**: 2026-08-24
**依据需求**: ①CLI 建会话需在页面可见 ②全程真实数据、真实模型、真实 DB ③压缩覆盖所有情况，避免潜在 BUG
**说明**: 会话 key 一律脱敏为前 8 位；不记录消息原文与密钥。

---

## 一、压缩收益随规模变化（真实模型调用 + 真实 DB）

| 场景 | 会话 | 对话 tokens（压缩前 → 压缩后） | 结论 |
|------|------|------|------|
| 2 轮短对话 | `26f4b5d6…` | 98 → 965 | ❌ 反增 867 |
| 10 轮短对话 | `3c8b4502…` | 483 → 1386 | ❌ 反增 903 |
| 灌入 53950 字符长文 | `a71af16e…` | 11554 → 1920 | ✅ 回收；usage 口径 19303 → 2206，净回收 **17097** |

**判定**: 压缩引擎本身正确。摘要有固定开销（约 900–1200 tokens），内容量不足时净收益为负。这解释了原报告 B-04「压缩后 token 未下降」——不是缺陷，是规模效应。

---

## 二、新确认缺陷

### 缺陷 #9: 重复压缩不收敛（中高）

**真实观测**（连续对同一会话执行 `context compact`，对话 tokens）:

```
1920 → 1965
987  → 1246
1246 → 1391
1673 → 1821
1588 → 1765
```

每次压缩都**增加** token，且每次都真实消耗一次 LLM 摘要调用。

**根因**: `apps/windows/src/main/agent-runtime/bridge-context-compactor.ts:252`

```ts
// 尝试 LLM 摘要：手动压缩无论消息多少都发出摘要请求
```

手动压缩路径**无最小收益闸（reclaim gate）**——不判断「压缩后是否真的更小」，无条件发摘要请求并落库。自动压缩路径有 Reclaim Gate 4096，手动路径没有。

**影响**: 用户连点压缩会持续膨胀上下文并烧钱；无上限。

**建议修复**: 手动路径复用 Reclaim Gate——摘要生成后比对 `usageBefore` 与预估 after，收益 ≤ 0 则丢弃摘要、返回 `messagesRemoved: 0` 并附原因（如 `low_yield`）。`usageBefore` 已在 `:250` 取到，无需新增依赖。

---

### 缺陷 #10: 不存在的 sessionKey 静默成功（中）

对一个纯属编造的 key 执行三条命令，全部返回成功：

| 命令 | 返回 | 期望 |
|------|------|------|
| `context usage` | `{"usedTokens":0,…}` exit 0 | `not_found` |
| `context messages` | `{"items":[],"hasMore":false}` exit 0 | `not_found` |
| `context compact` | `{"success":true, messagesRemoved:0, …}` exit 0 | `not_found` |

**影响**: 拼错 key 与空会话不可区分。自动化脚本会把「打错字」当成「压缩成功」，测试用例可能全程验证了一个不存在的会话。这也是最容易掩盖真实缺陷的一类问题。

**建议修复**: 三个 handler 入口统一校验会话存在性，不存在返回 `{"ok":false,"error":"not_found"}`（exit 1）。

---

### 缺陷 #11: `--keep` 缺少参数校验（低）

| 输入 | 实际行为 | 问题 |
|------|----------|------|
| `--keep abc` | 静默回落默认值 6 | 应 exit 2 |
| `--keep -1` | 接受，`policy.ts:45` 的 `Math.max(0, …)` 夹到 0 | 行为已定义，但无提示 |
| `--keep 9999` | 接受 | 无上限提示 |
| `--keep 0` | 接受，全量压缩 | 行为合理 |

**根因**: `commands.mjs:19` 的 `num()` 对非数字返回 `undefined`，build 里 `if (keep !== undefined)` 直接跳过该字段，非法输入退化为「未传」。

**建议修复**: `context compact` 的 build 中，`--keep` 存在但 `num()` 解析失败或为负则 `return null`（CLI 契约 exit 2）。

---

## 三、需求①：CLI 建会话在前端不可见

**结论**: 会话确实建成了（DB 已写入，`conversation list` 能查到），但**前端不会自动出现**，需手动刷新或切换页面回 chat 才显示。

**链路排查（只读）**:

| 环节 | 位置 | 现状 |
|------|------|------|
| 主进程建会话 | `conversation-commands.ts:85-118` | 写库 → 建实例 → `return { sessionKey }`，**无任何事件广播** |
| 控制口路径 | `app-ui-control/server.ts:437-469` | 走同一 `handleCommand`，同样不广播 |
| 事件类型 | `agent-runtime-events.ts:276/283` | `conversation:created` / `conversation:updated` **已定义但从未发出** |
| 渲染端处理 | `event-handler.ts:1343-1346` | 对应 case **是空的** |
| 会话列表状态 | `ChatPage.tsx:165/208-211` | 普通 `useState`，仅在挂载、`runtime:ready`、切回 chat 视图时重取，无轮询、无订阅 |

对比：`user:send` 在 `bridge-lifecycle.ts:342/357` 是**会**推 `conversation:message:new` / `conversation:navigate` 的——说明广播机制齐备，只是建会话这条路没接上。

**最小修复方案（未实施，等确认）**:
1. `conversation-commands.ts:117` 的 `return` 前，用现成的 `bridge.forwardIpcEvent` 发一条 `conversation:created`。
2. `event-handler.ts:1343` 那个空 case 里递增一个 `sessionListRevision` 计数，`ChatPage` 订阅它触发 `refreshLocalSessions`。

顺带把同样空转的 `conversation:updated`（重命名）也修好。约 10 行，不新增依赖、不新增抽象。

---

## 四、覆盖矩阵（真实数据）

| 场景 | 结果 |
|------|------|
| 空会话压缩幂等 | ✅ `messagesRemoved:0`, exit 0，可重复执行 |
| 短对话压缩 | ✅ 执行成功（token 反增，见 §1） |
| 长文本压缩 | ✅ 净回收 17097 tokens |
| 压缩后继续对话 | ✅ 正常收发 |
| 压缩后历史可读 | ✅ `contextExcluded:true` 标记，`--limit 99` 可取回原文 |
| 摘要就位 | ✅ `id: "compact-summary"` |
| `--session` 缺失/空 | ✅ exit 2 |
| `--session` 不存在 | ❌ 缺陷 #10 |
| `--keep` 非法值 | ❌ 缺陷 #11 |
| 重复压缩 | ❌ 缺陷 #9 |

**仍未覆盖**（成本/环境限制，非缺陷）:
- D-03 idle 轮询日志 — 未找到主进程日志文件
- D-05 真实 idle 触发 — 需 390K+ tokens、6+ 分钟
- D-08 冷却跨重启 — 需只读 DB 查询
- E-04 压缩中 abort — 需长压缩窗口；代码审查确认 AbortController 独立
- F-02 `apps/windows` compact 单测 — vitest 路径过滤问题

---

## 五、原报告更正

1. **测试文件缺失结论作废**：`idle-trigger.test.ts`(7)、`progress-fence.test.ts`(14)、`cooldown-protection.test.ts`(8) **均存在且通过**。此前判定失误源于 bash 工作目录残留导致的 `cd` 失败。真正缺失的只有 `summary-compact-progress.test.ts` 与 `compact-transaction.test.ts`。
2. **B-04 不是缺陷**：见 §1 规模效应。
3. **F-03 类型检查实为通过**：`pnpm typecheck` exit 0、0 errors；此前报告的「存在类型错误」是我的 `grep -c` 计数判断写错导致的误报。
4. **脱敏**：本轮报告中会话 key 一律截断为前 8 位。

---

## 六、修复优先级

| 优先级 | 缺陷 | 位置 | 工作量 |
|--------|------|------|--------|
| 🟠 中高 | #9 重复压缩不收敛 | `bridge-context-compactor.ts:252` | 加最小收益闸，约 10 行 |
| 🟡 中 | #10 不存在会话静默成功 | 三个 conversation handler 入口 | 加存在性校验 |
| 🟡 中 | ①CLI 会话前端不可见 | `conversation-commands.ts:117` + `event-handler.ts:1343` | 约 10 行 |
| 🟢 低 | #11 `--keep` 校验 | `commands.mjs` compact build | 2 行 |
| 🟢 低 | #8 遗留 4 个过时用例 | `transform-context-phase1.test.ts` | 改 async/await |

**未改任何业务代码**（遵循 F-04「确认前不改业务代码」）。已改的只有 CLI 字段名（缺陷 #7）与测试文件导入路径（缺陷 #8）。

---

## 七、修复实施记录（2026-08-24，用户已授权改业务代码）

### #9 重复压缩不收敛 → 已修复

`bridge-context-compactor.ts` 手动压缩路径加最小收益闸：摘要生成后，用「保留段 tokens + 摘要 tokens」与压缩前对话 tokens 比对，收益 ≤ 0 则丢弃摘要、不开事务、返回 `reason: 'low_yield'`。闸门放在落库前而非 LLM 调用前——必须先拿到摘要才知道实际开销。

回归测试：`bridge-context-compactor.test.ts` 新增「摘要开销 ≥ 原文时放弃压缩」，断言 `reason=low_yield`、`messagesRemoved=0`、摘要未落库、`execSink` 为空（事务根本没开）。

同时修正该文件的 harness：原 `makePiMessages` 正文只有 `msg-N`（5 字符），任何真实摘要都必然触发新闸门，导致 5 个既有用例失败。正文改为 600 字符，并加 `messageChars` 选项供收益闸用例构造「短正文 + 长摘要」。

**日志侧独立印证**：`~/.lumii/logs/app/mtbot-2026-08-24.log` 15:56–15:58 有 5 次连续压缩，摘要长度 2836 → 5589 → 5912 → 6135 → 6135 字符，每次都「压缩事务提交成功: 移出 1 条」——即修复前的膨胀行为。

### #10 不存在的 sessionKey 静默成功 → 已修复

三条命令入口加会话存在性校验，抛 `not_found: conversation <key> does not exist`：
- `conversation-commands.ts` 新增 `assertConversationExists`，用于 `handleConversationMessages` 与 `handleConversationContextUsage`
- `user-commands.ts` 的 `handleUserCompactContext` 在取 instance 前校验

### 需求① CLI 建会话前端可见 → 已修复

1. `bridge.ts` 新增公开 `forwardIpcEvent`（`ipcChannel` 是 private，handler 够不到）。
2. `conversation-commands.ts:117` 建会话后广播 `conversation:created`。
3. `agent-runtime-store.ts` 加 `sessionListRevision` 计数。
4. `event-handler.ts` 原本空转的 `conversation:created` / `conversation:updated` case 改为递增该计数（顺带修好重命名不刷新）。
5. `ChatPage.tsx` 订阅 `sessionListRevision` 变化触发 `refreshLocalSessions`。

### 需求④ CLI 发的消息前端只见 Agent 回复、不见用户提问 → 已修复

**根因**：`user-commands.ts` 的用户消息广播条件是 `win && !win.isDestroyed() && command.msgId`。前端发消息会带 `msgId`，CLI / 控制口不带，于是这条 `conversation:message:new` 被静默跳过——但 Agent 回复走的是另一条流式链路，不受影响，所以表现为「只有回复没有提问」。

**修复**：改用 `saveMessage()` 返回的落库 id（不传 id 时仓库自动生成），去掉 `command.msgId` 前提。

### #11 `--keep` 无校验 → 已修复

`commands.mjs` 的 compact `build`：`--keep` 传了就必须是非负整数，否则 `return null`（exit 2）。

实测（CLI 是 `.mjs`，无需重启即生效）：

| 输入 | 退出码 |
|------|--------|
| `--keep abc` | 2 ✅ |
| `--keep -1` | 2 ✅ |
| `--keep 1.5` | 2 ✅ |
| `--keep 0` | 0 ✅（0 = 全部纳入摘要，是有效值） |
| `--keep 6` | 0 ✅ |
| 不传 | 0 ✅（默认 6） |

### #8 遗留 4 个过时用例 → 已修复

`transform-context-phase1.test.ts` 4/4 通过。修的不只是 async/await，原用例有三处与实现不符的前提：

1. **返回值恒为新数组** — `finalizeHistoryMessages` 内部 copy，原用例断言 `result).toBe(messages)`（引用相等）永远失败。改为断言 token 不变。
2. **序列不能以 toolResult 开头** — `stripLeadingOrphanToolResults` 会把整串纯 toolResult 削空（26 条 → 2 条）。fixture 改为首条 assistant 打底。
3. **Proactive 与 Micro 不会同轮级联** — Proactive 一旦提交就 `return`。要观察 Micro 必须让 Proactive 被 Reclaim Gate 拒绝（把 `proactivePruneMinReclaimTokens` 拉到不可达）。原用例名「级联」本身就是对实现的误解，已改名。
4. **token 估算是 0.30/字符不是 0.25**（DeepSeek 口径，中文 0.6）。原用例按 0.25 算的消息条数落在错误档位：30 条 ≈ 65K 落在 Micro 区间而非 Proactive 区间。已按实测值重标（20 条≈43K、25 条≈54K、30 条≈65K）。

---

## 八、回归验证结果

| 检查 | 结果 |
|------|------|
| `packages/agent-runtime` compact 全量 | ✅ 18 files / **149 tests** passed（修复前 17 files + 1 导入失败 / 145 tests） |
| `apps/windows` main 进程（ipc + agent-runtime） | ✅ 30 files / 261 passed / 51 skipped |
| `apps/windows` renderer | ✅ 22 files / 171 passed |
| `pnpm typecheck`（4 个 workspace） | ✅ 全部 Done，0 error |
| `pnpm --filter lumii-windows build` | ✅ built in 26.65s |

### D-03 Idle 轮询存活 → 从阻塞变为通过

用户提供日志路径后解除阻塞。`scanIdleInstances` **736 条**决策记录，60s 固定间隔，四条件齐全：

```
[scanIdleInstances] agent-…-s4ejr2 决策=跳过 idle=32s/300s used=25096
                    固定开销=21640 可压缩=3456/161976(×0.78) 冷却=无
```

- ✅ 轮询存活，间隔稳定 60s
- ✅ 四条件 AND 决策可见（idle 时长 / used / 可压缩量 / 冷却）
- ✅ 736/736 决策=跳过、冷却=无 — 与「未达 300s 或可压缩量不足」一致
- ⚠️ 日志里 idle 阈值显示 `/300s`，仍是硬编码（候选问题 #1，未修）
