# 上下文压缩多层引擎 — 测试用例文档

- 日期：2026-08-21
- 覆盖：`docs/design/2026-08-18-context-compression-multi-layer-engine.md`（设计）
  `docs/plans/2026-08-18-context-compression-phase{1,2,3}-implementation.md`（阶段计划）
- 执行方式：全部用例由 lumii-ui CLI 自动执行；真实模型测试纳入主套件（B 套件）；单元测试只作辅助证据，不伪装成 CLI E2E。
- 代码基线：`apps/windows/resources/app-ui-cli/`（当前分支，禁止读取旧 worktree）。

## 0. 通用约定

### 0.1 CLI 契约（实测自 `lumii-ui.mjs` / `commands.mjs`）

| 项 | 值 |
|---|---|
| 退出码 | 0 成功 / 1 其它错误 / 2 参数错误 / 3 应用未运行 / 4 认证失败 / 5 被拒绝 |
| 控制口 | `http://127.0.0.1:<port>/command`，POST，Bearer token |
| 运行配置 | `<dataRoot>/runtime/app-ui.json`（`{port:number, token:string}`）；dataRoot 默认 `~/.lumii`，可用 `LUMII_CLIENT_DATA_DIR` 覆盖 |
| 大文本注入 | `send --session <key> --data -`，正文走 stdin（`readStdin`，TTY 下返回空串 → 命令构建返回 null → 参数错误） |
| 长命令匹配 | 按空格数降序匹配（`context usage` 先于 `context`） |
| 白名单第一道闸 | `command-allowlist.ts` 默认拒绝，`isCommandExposed(type)` 通过才放行 |
| 第二道闸 | `COMMAND_FIELD_DENYLIST`：`user:send` 只允许 `sessionKey + content + msgId`，附件类字段一律 `field_protected` 拒绝 |

可用命令（组：上下文压缩）：
- `conversation list` → `conversation:list`
- `conversation create [--title <t>]` → `conversation:create`，返回 sessionKey
- `send --session <key> [--text <t>|--data -] [--model <id>]` → `user:send`
- `send abort --session <key>` → `user:abort`
- `context usage --session <key>` → `conversation:context-usage`，返回 `{usedTokens, contextWindow, triggerThreshold, breakdown?}`
- `context compact --session <key> [--keep <n>]` → `user:compact-context`，返回压缩前后消息数
- `context abort --session <key>` → `user:abort-compact-context`
- `context messages --session <key> [--limit <n>]` → `conversation:messages`

已知瑕疵（记入报告，不影响用例设计）：`send` 的 usage 文本写有 `[--wait]` 但 `build()` 不解析它；命令均为 fire-and-forget 或同步查询，轮询结果靠重复查询命令。

### 0.2 关键常量（以代码为准）

| 常量 | 值 | 出处 |
|---|---|---|
| 自动压缩触发比 `DEFAULT_COMPACTION_TRIGGER_RATIO` | 0.78 | `compact/types.ts:21` |
| Idle 空闲阈值 `idleCompactAfterSeconds` 默认 | 300s | `compact/types.ts:315`（**注意：bridge.ts:1553 硬编码 300，未读配置**） |
| Idle 扫描间隔 | 60s | `bridge.ts:1494` |
| ProgressFence idle 无进度超时 | 120s | `compact/progress-fence.ts` 构造默认 |
| ProgressFence 绝对封顶 | 600s | 同上 |
| Commit overrun 分段 | 30s/段 | `progress-fence.ts:134` |
| 小窗口地板 | contextWindow < 512K 时地板 ≥ 75% | `policy.ts:105-107` |
| 绝对 Cap `thresholdTokensCap` 默认 | 200_000 tokens | `policy.ts:113-114` |
| Proactive Prune 触发比例默认 | 0.48 | `types.ts:270` |
| Reclaim Gate 最小回收 | 4096 tokens | `types.ts:279-282` |
| Dedup 最小字符 | 200 | `types.ts:289` |
| 大结果摘要最小字符 | 8000 | `types.ts:276` |
| idle 失败冷却 `IDLE_COOLDOWN_FAILURE_MS` | 10min | `idle-trigger.ts:33` |
| idle 低收益冷却 `IDLE_COOLDOWN_LOW_YIELD_MS` | **30min（代码）**，计划文档写 1h | `idle-trigger.ts:34` |
| 反抖动最小收益比 | 10% | `idle-trigger.ts:56` |
| 冷却落库键 | `compact:idle_cooldown_until:<sessionKey>`（runtime_state 表，重启仍生效） | `bridge.ts:1499` |

### 0.3 日志锚点（断言用，均为主进程日志）

| 锚点 | 含义 |
|---|---|
| `[startIdleCompactionPolling] Idle Compaction 轮询已启动（60s 间隔）` | idle 轮询存活 |
| `[scanIdleInstances] <id> 决策=压缩\|跳过 idle=Xs/300s used=N floor=N(win×0.78) 冷却=无\|HH:MM:SS` | 每轮决策，可判断卡在哪个条件 |
| `[tryIdleCompact] 实例 <id> idle 压缩完成（移出 N 条，回收 X tokens / Y%，摘要=bool）` | idle 压缩成功 |
| `[setIdleCooldown] 会话 <key> 冷却 Nmin（原因）` | 冷却写入（原因=压缩失败/收益过低/成功路径） |
| `[compactContextAsync] 压缩事务提交成功: 移出 N 条(仍保留在历史), 摘要=bool` | 事务提交 |
| `[compactContextAsync] 压缩事务失败已回滚，上下文保持原状` | 事务回滚 |
| `[compactContextAsync] 提交入场权已被撤销，跳过写入` | Commit Fence 入场被撤销 |
| `[compactContextAsync] 用户已停止压缩，保持会话不变` | 用户中止 |
| `[CommitFence] SessionDB 提交仍在进行中，已越界 Xs（总等 Ys，ceiling 600s）；**永不中断**` | commit overrun 保命策略 |

### 0.4 统一 debug 日志规范（测试脚本/文档）

- 前缀：`[CTX-COMPRESS-TEST][<CASE-ID>][<阶段>]`，阶段 ∈ {准备, 执行, 断言, 清理, 结束}。
- 只记脱敏信息：会话 key 前 8 位 + 长度、消息条数、token 计数、退出码、HTTP 状态、错误码字符串。
- **禁止记录**：token 明文、模型密钥、完整消息内容、完整 sessionKey。
- 断言失败时输出：实际值 vs 预期值 + 原始证据路径（RTK tee 日志）。

### 0.5 证据与判假规则

- 所有 Bash 经 `rtk` 执行，输出被压缩；**原始结果必须回读 `~/AppData/Local/rtk/tee/*.log`**。
- `{"numTotalTestSuites":0,...,"success":true}` 是空跑假通过，**一律按失败/阻塞计**。
- 已知阻塞（记入报告）：`apps/windows/src/main/app-ui-control` 目录 vitest 收集 0 suite（worker 终止），其用例以手动 CLI 验证为准，单测待基础设施修复后补跑。

---

## A 套件 — CLI/控制口冒烟（不依赖模型）

> 目标：证明 CLI↔控制口链路、白名单两道闸、退出码契约可用。任何一条失败即阻塞全部后续套件。

### A-01 应用未运行时退出码
- 前置：确认无 dev 进程。
- 命令：`node apps/windows/resources/app-ui-cli/lumii-ui.mjs conversation list`
- 预期：stdout 为 `{"ok":false,"error":"app_not_running"}` 或 exit=3（`loadRuntimeConfig` 返回 null 分支）。
- 失败判定：exit=0 或无 JSON 输出。

### A-02 help --json 命令发现
- 命令：`.../lumii-ui.mjs help --json`（应用需运行）
- 预期：exit=0；JSON `commands` 数组含 `context usage`/`context compact`/`context abort`/`context messages`/`conversation list`/`conversation create`/`send`/`send abort`；不含 `build`。
- 失败判定：exit≠0；缺少任一命令。

### A-03 未知命令参数错误
- 命令：`.../lumii-ui.mjs no-such-command-xyz`
- 预期：exit=2（usage）。

### A-04 白名单第一道闸：未暴露类型被拒
- 方式：直接 HTTP POST `/command`（绕 CLI，手写 body）`{"type":"system:shutdown"}`（选一个确认不在白名单的类型）。
- 预期：HTTP 200 + `{"ok":false,"error":"not_exposed"}`；CLI 侧等效验证 exit=5。
- 失败判定：命令被执行或返回 500。

### A-05 第二道闸：user:send 附件字段被拒
- 方式：HTTP POST `{"type":"user:send","sessionKey":"x","content":"hi","attachments":["C:/tmp/a.png"]}`。
- 预期：`{"ok":false,"error":"field_protected","field":"attachments"}`。
- 失败判定：字段未被拒绝。

### A-06 认证失败退出码
- 方式：用 `runtime/app-ui.json` 的真实 port 但错误 token 直接 HTTP。
- 预期：401；CLI 等效 exit=4。
- 失败判定：200 返回。

---

## B 套件 — 会话构造与真实模型主套件（纳入主套件）

> 目标：用 CLI 完整走通「建会话 → 真实模型收发 → usage 上升 → 手动压缩 → messages 校验摘要就位」。模型配置由用户已配好（deepseek-v4-flash 等）。本套件即日常回归主套件。

### B-01 会话构造与真实模型收发
- 前置：应用运行、模型配置就绪。
- 命令序列：
  1. `conversation create --title "ctx-test-B01-<ts>"`
  2. `send --session <key> --text "请回复：压缩测试探针 OK"`
  3. 等待（轮询 `context messages --limit 2` 直到出现 assistant 消息，超时 120s）
  4. `context usage --session <key>`
- 预期：① 返回 sessionKey；② exit=0 且会话出现 assistant 回复；③ `usedTokens > 0`，`contextWindow > 0`，`triggerThreshold === 0.78`。
- 失败判定：120s 无回复；usage 字段缺失或 triggerThreshold≠0.78。
- 清理：保留会话（数据保留，报告中记录 key 前 8 位）。

### B-02 大文本撑高 token（stdin 路径）
- 前置：B-01 会话。
- 输入生成：本地生成约 8000 字符重复段落文本（不含敏感内容），管道进 stdin。
- 命令：`printf '<文本>' | .../lumii-ui.mjs send --session <key> --data -`（或 `--text` 直接给中段文本；两者都验证，`--data -` 为主）
- 预期：exit=0；usage.usedTokens 较发送前显著上升。
- 失败判定：exit=2（`--data -` 在 TTY 下读取失败属已知行为，若脚本化执行须重定向 stdin 非 TTY）。

### B-03 手动压缩：摘要就位、原文未丢
- 前置：B-02 后消息数 ≥ 8。
- 命令：`context compact --session <key> --keep 6`；随后 `context messages --session <key> --limit 3` 与 `--limit 99`。
- 预期：① 返回 `messagesRemoved > 0`（或 `newMessageCount < previousMessageCount`）；② messages 首条为 assistant 角色摘要（`buildPersistedCompactSummary` 标记）；③ 被移出消息「仍保留在历史」（`--limit 99` 可读到）。
- 失败判定：压缩后 messages 首条非摘要；原文完全消失；exit≠0。
- 对应：设计 §原子提交期 / Phase3 事务。

### B-04 压缩前后 token 单调下降
- 前置：B-03 完成。
- 命令：`context usage` 前后对比（B-02 记录值 vs B-03 后值）。
- 预期：`usedTokens` 下降（下降量 > 0 即可，不要求精确）。
- 失败判定：token 不降反升且无摘要。

### B-05 无消息可压缩的幂等
- 前置：新建空会话。
- 命令：`context compact --session <empty-key>`
- 预期：exit=0；日志 `[compactContextAsync] 无消息可压缩` 或返回移出 0 条。
- 失败判定：exit≠0 或异常。

### B-06 会话列表可回读测试会话
- 命令：`conversation list`
- 预期：含 B-01/B-05 创建的 sessionKey。
- 失败判定：列表为空或缺少刚创建的会话。

---

## C 套件 — Phase 1 微压缩 / 主动剪枝

> 观测手段：CLI 无法直接观测内部 Gate 逐条决策，本套件用「CLI 触发 + 主进程日志 + usage/messages」验证；单测（`micro-compact-phase1.test.ts`、`proactive-prune.test.ts`、`transform-context-phase1.test.ts`、`policy.test.ts`）作辅助证据并单独报告 suite 数。

### C-01 微压缩：Dedup 最小字符 200
- 方式：单测为主。`pnpm vitest run src/compact/strategies/micro-compact-phase1.test.ts`（在 packages/agent-runtime 目录）。
- 预期：Dedup 对 ≥200 字符重复块生效、<200 不生效的用例全部通过；报告实际 suite/test 数。
- 失败判定：fail 数 >0 或 0 suite。

### C-02 微压缩：Truncate Arguments
- 方式：同 C-01 测试文件内 truncate 用例。
- 预期：超长参数被截断至阈值内，截断点不破坏 JSON 结构。

### C-03 Reclaim Gate 4096
- 方式：单测 + 代码常量核对。
- 预期：`proactivePruneMinReclaimTokens` 默认 4096；回收 <4096 时日志 `ProactivePrune 回收不足 Gate 拒绝`（若实现有该日志；否则以单测断言为准）。
- 失败判定：常量≠4096 或 Gate 不生效。

### C-04 Proactive Prune 触发比例 0.48
- 方式：单测 + 常量核对（`proactivePruneRatio` 默认 0.48）。
- 预期：usage 达到 window×0.48 时进入主动剪枝候选。
- 对应：Phase1 §主动剪枝触发。

### C-05 绝对 Cap 200K
- 方式：单测 `policy.test.ts`。
- 预期：`thresholdTokensCap` 默认 200_000；压缩触发点 = min(比例阈值, 200K)。

### C-06 小窗口地板 75%
- 方式：单测 `policy.test.ts`。
- 预期：contextWindow < 512K 时地板 max(ratio, 0.75)。

### C-07 大结果摘要最小 8000 字符
- 方式：单测（proactive-prune.test.ts 或 types 核对）。
- 预期：≥8000 字符工具结果才进入摘要候选。

### C-08 端到端触发（CLI 侧，条件执行）
- 前置：能通过 usage 逼近 window×0.48（可能需 >100K token，成本高）。
- 命令：`context compact --session <key> --keep 4` 后读日志。
- 预期：日志出现 Proactive/Micro 阶段标记或压缩成功；若成本过高，标记为「不执行，由单测覆盖」，报告注明原因。
- 失败判定：N/A（条件用例）。

---

## D 套件 — Phase 2 模型阈值 / Idle / ProgressFence

### D-01 每模型阈值最长子串匹配
- 方式：单测 `per-model-threshold.test.ts`。
- 预期：`deepseek-v4-flash` 命中 `deepseek-v4` 前缀类配置等用例通过；报告实际 suite 数。
- 失败判定：0 suite 或 fail。

### D-02 triggerThreshold 下发一致性
- 方式：`context usage`（B-01 已含）。
- 预期：返回值 0.78 与 `DEFAULT_COMPACTION_TRIGGER_RATIO` 一致；若会话模型在 catalog 中有专属阈值，返回其值。
- 失败判定：与代码常量不符。

### D-03 Idle 轮询存活
- 前置：应用启动。
- 方式：读主进程日志。
- 预期：启动阶段出现 `[startIdleCompactionPolling] Idle Compaction 轮询已启动（60s 间隔）`；且每 60s 有一轮 `[scanIdleInstances]` 决策（活跃会话时）。
- 失败判定：启动 3 分钟无任何 scan 决策行。

### D-04 Idle 四条件 AND 决策
- 方式：单测 `idle-trigger.test.ts` + 日志核对。
- 预期：`shouldIdleCompact` 四条件（enabled/idle≥300s/tokens≥floor/无冷却）任一不满足即「跳过」；日志行 `决策=跳过 idle=Xs/300s used=N floor=N(win×0.78) 冷却=无` 佐证判定依据。
- 失败判定：单测 fail；或日志中 idle>300 且 used≥floor 且无冷却却仍「跳过」。

### D-05 Idle 压缩真实触发（长等待，条件执行）
- 前置：制造 used ≥ floor 的会话且保持空闲 >300s。floor = window×0.78，多数模型 ≥390K token，**真实触发成本极高**。
- 命令：创建会话 → 注入大量文本 → 等 6 分钟 → 读日志与 usage。
- 预期：出现 `[tryIdleCompact] ... idle 压缩完成`，usage 下降，随后 `[setIdleCooldown]`。
- 失败判定：无触发。
- 降级方案：**默认不执行**；用 `idle-trigger.test.ts` + 日志决策行作为证据，报告注明「真实 idle 触发未做，理由：成本/时间」。若用户要求，可用临时低阈值配置执行（属改配置，须用户确认）。

### D-06 ProgressFence 双预算
- 方式：单测 `progress-fence.test.ts`。
- 预期：idle 无进度 120s 超时返回 null；ceiling 600s 绝对封顶；`nextWaitSliceMs` ≥5ms 且取双预算余量最小值。
- 失败判定：0 suite 或 fail。

### D-07 摘要 progress touch 续命
- 方式：单测（`summary-compact-progress.test.ts` 计划中但**磁盘缺失** → 报告阻塞项）。临时证据：`progress-fence.test.ts` 内 touch 类用例若存在则引用。
- 预期：每 5s touch 可续命至 ceiling。
- 失败判定：缺失测试文件记为「覆盖缺口」。

### D-08 冷却落库跨重启
- 方式：日志 + DB 核对。
- 预期：冷却写 `runtime_state` 键 `compact:idle_cooldown_until:<sessionKey>`（时间戳 ms）；重启应用后该键仍在（`bridge.ts` 注释承诺）。
- 失败判定：键缺失。DB 只读查询（sqlite3 CLI 或只读脚本）。

---

## E 套件 — Phase 3 Commit Fence / 事务 / 冷却

### E-01 事务原子提交成功路径
- 方式：CLI 触发 `context compact`（B-03 复用）。
- 预期：日志 `[compactContextAsync] 压缩事务提交成功: 移出 N 条(仍保留在历史), 摘要=bool`；`BEGIN IMMEDIATE` 执行无 SQLITE_BUSY。
- 失败判定：无成功日志或出现回滚日志。

### E-02 事务失败回滚保持原状
- 方式：单测（`compact-transaction.test.ts` 计划中但**磁盘缺失** → 报告阻塞项）；现有证据：`compact-persist.test.ts`（apps/windows 侧存在）。
- 预期：注入故障后 ROLLBACK，消息数与 token 与压缩前一致。
- 失败判定：0 suite；缺失文件记覆盖缺口。

### E-03 Commit overrun 30s 分段 + 日志升级
- 方式：单测 `progress-fence.test.ts`（overrun 用例）。
- 预期：overrun 后每 30s 记一次 `[CommitFence] ...`，前 2 次 warn 后升级 error；**永不中断**提交。
- 失败判定：用例缺失或 fail。

### E-04 abort 中止压缩：提交入场权撤销
- 方式：CLI `context compact`（大会话，压缩耗时）进行中 → 另一终端 `context abort --session <key>` → 读日志。
- 预期：出现 `[compactContextAsync] 用户已停止压缩，保持会话不变` 或 `提交入场权已被撤销`；usage 不变。
- 失败判定：压缩继续完成且无中止日志。
- **已知风险（待报告）**：`bridge-context-compactor.ts:332` 每次调用 `new ProgressFence()`，abort 撤销的 fence 与提交期 fence 是否为同一实例需代码核对；若不为同一实例，abort 无法阻止已进入提交期的压缩 → 记为 Phase3 缺陷候选。

### E-05 失败冷却 10min
- 方式：单测 `cooldown-protection.test.ts`（failure 路径）。
- 预期：失败后冷却 600_000ms；冷却期内 `shouldIdleCompact` 返回 false。
- 失败判定：fail 或 0 suite。

### E-06 低收益反抖动 30min
- 方式：单测 `cooldown-protection.test.ts`（anti_thrash 路径）。
- 预期：收益 <10% 时冷却 1_800_000ms（代码值）；**计划文档写 1h，以代码为准，差异入报告**。
- 失败判定：fail；或代码/文档值混乱未澄清。

### E-07 冷却原因日志
- 方式：D-05 或手动压缩后读日志。
- 预期：`[setIdleCooldown] 会话 <key> 冷却 Nmin（原因）`，原因 ∈ {压缩失败, 收益过低, 其它}。
- 失败判定：无冷却日志。

---

## F 套件 — 回归与报告采集

### F-01 compact 全量单测回归
- 命令：`rtk pnpm vitest run src/compact`（packages/agent-runtime 目录）。
- 预期：所有已存在测试文件通过；**回读 RTK tee 日志确认 suite/test 数 > 0**。
- 失败判定：任何 fail；0 suite 假通过。

### F-02 apps/windows compact 相关单测
- 命令：`rtk npx vitest run src/main/agent-runtime/compact-persist.test.ts src/main/agent-runtime/bridge-context-compactor.test.ts`（apps/windows 目录，显式路径）。
- 预期：真实 suite 数 > 0 且通过。
- 失败判定：0 suite（已知 app-ui-control 目录有此问题，这里验证这两个文件是否健康）。

### F-03 类型检查
- 命令：`rtk pnpm typecheck`。
- 预期：0 错误（`system-prompt-builder.ts` 用户已改完，应通过）。
- 失败判定：任何 TS 错误，逐条归类（业务 vs 测试 vs 用户改动文件）。

### F-04 报告汇总
- 收集所有套件结果 → 生成 `docs/test/2026-08-21-context-compression-report.md`。
- 统计维度：通过/失败/阻塞/条件跳过；失败逐条归因：启动依赖问题 / 测试基础设施问题 / 覆盖缺口 / 真实业务失败。
- 附修复方案文档 `docs/test/2026-08-21-context-compression-fix-plan.md`，按严重级别列出根因、影响、最小改动文件、验证命令、风险。**确认前不改业务代码。**

---

## 已识别问题候选清单（待测试证实后进修复方案）

| # | 候选 | 证据 | 严重度 |
|---|---|---|---|
| 1 | idle 阈值硬编码 300s，未读 `idleCompactAfterSeconds` 配置 | `bridge.ts:1553` | 中 |
| 2 | `compactContextAsync` 每次 `new ProgressFence()`，abort 撤销可能够不到提交期实例 | `bridge-context-compactor.ts:332` | 高（待 E-04 证实） |
| 3 | anti_thrash 冷却代码 30min vs 计划文档 1h | `idle-trigger.ts:34` | 低（文档或代码二选一） |
| 4 | 计划测试文件缺失：`idle-compact.test.ts`、`compact-transaction.test.ts`、`summary-compact-progress.test.ts`、`proactive-pressure-demote.test.ts` | 磁盘核对 | 中（覆盖缺口） |
| 5 | `apps/windows/src/main/app-ui-control` 目录 vitest 0 suite（worker 终止） | 实测 | 高（测试基础设施） |
| 6 | `send` usage 文本含 `[--wait]` 但 build 未实现 | `commands.mjs:394` | 低（文档瑕疵） |


又一个真实缺陷：context messages 报 command_failed: Cannot read properties of undefined (reading 'trim')——CLI 命令构建用的字段名和
  server 端实际读取的字段名不一致（commands.mjs 传的是 conversationId，但看 usage 是能正常工作的，说明问题在 messages
  这条链路上specifically）。而且 context usage 显示 conversation: 31 tokens，说明探针消息确实发出去了、系统也认成本进了会话，但 context 
  messages 读取报错，无法验证 assistant
  回复是否真的到达。这两个都是需要写入报告的真实发现，不是我去修的时机。现在收尾，写入内存与任务状态。

  Recalled 1 memory, wrote 2 memories (ctrl+o to expand)

● 今日进度已记录，明天可以直接续跑。

  今日结果：
  - 测试用例文档已交付：docs/test/2026-08-21-context-compression-test-cases.md（A~F 六套件）
  - A 套件（CLI/控制口冒烟）全部通过：命令发现、未知命令、白名单两道闸、认证失败
  - F-03 类型检查发现假通过陷阱：rtk pnpm typecheck 报"No errors found"，但 rtk proxy 真实输出显示 packages/browser-control 有 50+
  个类型错误且 exit 2，同时 pnpm -r typecheck 只跑了 6/7 个 workspace 项目（漏了主应用）
  - 发现一个真实缺陷：context messages --session <key> 报 command_failed: Cannot read properties of undefined (reading 'trim')，而同会话
  context usage 正常返回。这个报错阻塞了 B-01 及后续所有需要读消息验证的用例
  - 排除了测试文档里原列的候选风险#2（abort 是否打得到压缩实例）——确认 abort 走独立的 AbortController/signal 链路，与 ProgressFence
  无关，机制正常

  **明日续跑：**先查 server.ts 里 conversation:messages 的 handler（只调查记录根因，不改代码），根因清楚后复用已有会话
  b603c8e8… 继续 B 套件，再往 C/D/E/F 推进。进度和环境细节已存入项目记忆，任务列表也已同步。