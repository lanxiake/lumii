# 09 · durable 运行时 Pico 与全课程演进总结

> 一句话：agent 跑到一半进程死了，怎么办？本篇用 harness.md（1,468 行规范）与 durable 包回答这个问题——四部分持久状态、操作状态机、intent/settlement 双记账、38 条不变量；然后收官：把九篇文章拉成一条演进线，给你一份"自建 pi"的分层 checklist。

## 0 本篇地图

- 前置：全部。收口最需要的是第 05 篇（会话 JSONL 与"追加日志即事实源"）、第 03 篇（内存循环里的 abort/错误语义）、第 08 篇（chord/平台化，Pico 的地基）。
- 主角：`packages/agent/docs/harness.md`（"# AgentHarness — implementation specification"）、`packages/durable/README.md` 与 `docs/pico-v5.md`、`packages/agent/docs/pico*/`（v1–v3 考古）、`packages/agent/docs/{tool-durability,assistant-durability,post-wp05-roadmap}.md`。
- 实验在 `../code/09/`，预计阅读 60 分钟。
- 收官约定：本篇同时是第 01–08 篇的压缩索引——赶时间的人可以直接读 §5.3 的分层 checklist，再回头补想深读的篇目。
- 口径声明（收官篇必须诚实到底）：本篇所有日期、行数、提交号、引语均来自本地克隆实测（快照 `v0.87.1-7-gb313731b`，2026-09-23）；任务简报中有三处与克隆不符（当前版本号 v0.117.0、README 原文措辞、WP-066/WP-071 编号），正文逐处标注，以仓库为准。解读一律标 **（分析）**，查无实据标 **（推测）**。

## 1 问题：进程死了，agent 欠下的账怎么办

设想第 04 篇的场景正在发生：模型让你删掉过期迁移文件并跑测试。harness 发出两个 tool call，第一个 `bash` 已经 `rm -rf` 完毕、甚至替模型发过一个 HTTP 请求——然后进程被 OOM killer 带走了。重启后你有三个事实要处理：

1. **会话记录不能丢**：用户消息、assistant 已流出的半截回复、第一个工具的结局，都要能重建；
2. **副作用不能重放**：`rm -rf` 再跑一次可能砸掉无辜的东西，已发出的 HTTP 可能重复下单；
3. **工作要能续上**：第二个工具（跑测试）还没开始，它应当被正常执行，而不是整个 run 作废。

第 05 篇的会话 JSONL 解决了"记录"，但它是**事后账本**：只在事情完成后追加一行"发生了什么"。它不记录"正打算做什么"，也就无法区分"副作用已发生但没记下来"和"副作用没发生"；它没有"谁在执行"的所有权概念，两个进程同时恢复就会双跑。**append-only 账本与可恢复运行时差三样东西**（分析）：意图先于副作用落盘的**预记账**、副作用发生中可替换的**操作状态**、以及恢复时的**孤儿判定表**。第 03 篇的内存循环对此的态度是"体面收场"（abort 不中断事件协议）——但那是进程活着的优雅；进程死了，优雅没有意义，只剩磁盘上的字节。

pi 对这三样东西的回答分两层：`packages/agent/docs/harness.md` 是**规范**（2026-07-28 首次提交，`e8f9c071 docs(agent): durable AgentHarness design (harness.md)`），`packages/durable`（2026-09-18 `08016016 feat(durable): move Pico into dedicated package`）是**下一代运行时**。先读规范。

## 2 AgentHarness 规范精读：把"崩溃"当成一等公民设计

### 2.1 文档定位：normative，而且知道自己哪里没实现

harness.md 第 0.1 节原文：

> A durable runtime for agent conversations: it persists conversation and operation state so interrupted work resumes without repeating settled effects. This document is the normative specification; §0.9 marks the parts that are specified but not implemented.

一句话包含三个承诺：持久化会话**与操作**状态；中断的工作可续；**不重复已结算的副作用**（settled effects）。文档结构是 Part 0 导览 / Part 1 存储 / Part 2 会话树 / Part 3 操作状态机 / Part 4 执行恢复与中止 / Part 5 公共接口 / Part 6–9 未来与测试，目录直接写着 **"Part 9 — Invariants and tests: 38 invariants · race catalog · test tiers"**。更罕见的是 §0.9 "Implementation status"：WP00–WP07 已完成，然后把未实现的债逐条挂牌——J1（JSONL 死字节不回收）、C1（RemoteSession 规范与产品矛盾）、R12（`watchSession` 仍抛 `SliceNotImplemented`）、T1（遥测 span 只落了 tool-hook）、S3（搜索只有设计）……**规范文档同时是债务台账**，这是 1,468 行可信度的来源（分析）。

### 2.2 四部分状态：一个 session 的全部真相

§0.2 原文压缩后就是标题清单：一个 **session** 恰有四部分——

1. **不可变 entry tree**：message / compaction / branch summary / 自定义条目，按 `parentId` 追加成树，分支共享前缀"enabling branching, compaction, forking, and parallel work while preserving history"；
2. **bound typed addresses 上的 values 与 lists**：`value<T>(namespace, key?)` 是可替换的当前值，`list<T>(...)` 是只追加、整删的序列；"Namespace and key are bound once; every later read or write receives only the address"（§1.3）——没有全局类型表、没有依赖注入；
3. **Branches 与 AgentLanes**：Branch 只是一个可移动的 tip 值（`pi.branch.tip/{name}` 存在即分支存在），AgentLane = Branch + 全量模型配置 + 队列 + **至多一个在跑的操作**；`main` 也是显式获取才创建；
4. **append-only usage ledger**："Every settled provider attempt writes one `UsageRow` — successful, failed, retried, and synthetic alike"，且 **"billing survives everything that happens to orchestration state"**（§1.6）——终态清理永远不删账本行。

四者的分工被 §0.3 钉成一句话（原文）：

> **Every payload is in an entry, a bound value/list, or the ledger; there is no third place.**

具体例子（§0.4 Slack 线程）：400 条历史的频道里开一个 lane 提问 `lane.prompt(...)`，一次普通 run 的落盘序列（§0.4 规范性轨迹摘录）：

```text
TX[ insert entry n1(user), upsert pi.branch.tip=n1,
    upsert pi.op.meta/O, upsert pi.op.state/O=starting,
    upsert pi.lane.state={currentOperationId: O} ]        ← 受理：无钩子、无任务、无效果
TX[ upsert pi.op.state/O=effect_pending (预铸 response n2, usage u1) ]
… provider streams …                                      ← 唯一真正不确定的窗口
TX[ insert entry n2, insert usage u1, upsert tip=n2,
    delete pi.pending.assistant_frame/O:n2, upsert pi.op.state/O=tools ]
TX[ delete pi.op.meta/O, pi.op.state/O, …, set pi.result/O={status:"completed",…},
    upsert pi.lane.state={currentOperationId: null, lastOperationId: O} ]  ← 终态：删自有值
```

受理时不跑钩子不启动任务；"意图"事务在发出任何字节前预铸 response/usage 的 id；流式期间每帧只追加进 `pi.pending.assistant_frame`（不许阻塞流）；结算事务一次性写 entry + usage + 删帧列表；终态事务删光 `pi.op.*` 写入不可变 `pi.result/O`。**任意两个事务之间杀进程重启，harness 读回 lane 必需值、看最后提交了哪一笔，从那里继续**（§0.4 原话 "Kill the process between any two transactions and restart"）。

### 2.3 操作状态机：四原语与一个 13 叶的联合类型

harness 驱动 lane 只有四个原语（§0.2）：`accept`（持久地创建一个操作，受理不启动任何任务）、`drive`（推进一个期望中的操作）、`requestAbort`（持久地请求取消）、`inspectExecution`（原子地报告当前与最近终态执行）。`prompt`/`resume`/`abort` 只是把四原语与进程内等待策略组合起来的便利品。**受理与执行所有权分离**：一个已受理的操作可以没有任何进程内 driver——这意味着"谁在跑"本来就是可缺席的状态，服务层可以用闹钟、job 队列来调度 `drive`。

崩溃续跑的核心数据结构是 `operationState(operationId)`（§3.2）：一个 **13 叶的扁平联合类型**，每次状态转移**整体替换完整值**——"never depending on a previous state"。这是与事件溯源的关键分歧：

> After task loss, recovery reads it and starts at the responsible procedure, **never replaying a journal or inferring position from what is missing**.（§0.3 规则 3）

转移纪律是 §3.4 的引用块原文：

> Compute one complete next state in memory, then atomically commit every entry, usage row, value/list write, and projection change that makes it true.

取消语义同样状态化：`Control = { status: "running" } | { status: "cancel_requested", requestedAt }`。这正好接上第 08 篇 telemetry.md 的 `ExecutionStopCause`——调用方断线（`invocation_cancelled`）与持久取消（`durable_cancel_requested`）是两回事：前者只停观察，lane 拥有的 drive 继续跑；**只有后者才允许写出 `aborted` 终态**。第 03 篇"abort 是体面收场"在持久层的翻版：abort 先落盘为 `cancel_requested`，下一次 drive 的 pass 第一件事就是检查它。

### 2.4 intent → 不确定的副作用 → settlement：孤儿怎么收尸

规范用 §0.3 规则 4 与 §0.5 的"crash mid-tool"例子把预记账讲透。删除文件的工具声明 `replay: "never"`，harness 先提交 `pi.op.tool_args/O:s1:0` + `pi.op.state/O = call 0 effect_pending`，工具边跑边把**有界进度快照**替换进 `pi.pending.tool_output/O:n3`；进程死在第 N 个进度快照之后。重启后 §4.5 的孤儿表判定：

| 遗留的 restart point | 恢复动作（§4.5 表格意译） |
|---|---|
| assistant `effect_pending` | 读回已提交的帧前缀，reducer 合成一条**零 usage 的 error 响应**，附显式警告"请求被中断，此前内容为最新已提交部分，更新的输出可能缺失，外部结果未知"；有重试预算则换 id 重试 |
| tool `effect_pending` 且新旧声明都 `safe` | 删旧进度、用**持久化的参数重新执行**（读文件、查询类） |
| tool `effect_pending` 且声明 `never`（或工具已消失） | **绝不重执行**：保留 checkpoint 内容，合成带警告的 interrupted 结果落盘 |

§0.5 的收束句是整套设计的验收标准：**"Every tool call has a result and nothing ran twice; without a committed checkpoint the result contains only the warning."** 配套的诚实是 §0.6 非目标第一条：**放弃 exactly-once 外部效果**（有副作用的 hook 必须按 operation id 幂等），外加五条——不重挂 provider 流、单写者、不做工作调度、不做复制、不留持久写历史（值只留当前态，审计归遥测）。执行侧再加一道 §4.2 的 **effect gate**：每个已安装 Drive 持有 `admit(invoke)` 同步闸门，abort/close 之后不再放行新的 hook/provider/tool 调用——闸门是进程内的，判定依据却是盘上的 `control`。

### 2.5 两份 handoff：状态机是从部件台账长出来的

harness.md 不是平地起楼，它踩着两份更小的实现交接稿。`docs/tool-durability.md`（704 行，2026-08-16 首现）开篇的问题句值得所有做多工具并行的项目抄走：**"Parallel tool effects finish in completion order, while tool-result entries must enter the conversation in assistant source order."** 解法恰是本篇 §2.4 孤儿表依赖的两个部件：durable 的 `outcome_ready` 状态（效果结算与按序放置之间）+ 对完整有界 `onUpdate` 快照的 opt-in 替换式 checkpoint。`docs/assistant-durability.md`（355 行）则把"半截回复怎么持久"委托给 pi-ai 的帧编解码器（`AssistantMessageFrame`/`reduceAssistantMessageFrames`），自己只管帧列表的生死——它自述 build on "the assistant intent/effect/settlement state machine in `harness.md`"。三份文档互为引用、部件先于整机（分析：这就是 1,468 行能 normative 的原因——名词早就在实现里活过了）。

### 2.6 38 条不变量：规范先行的工程法

Part 9 §9.1 列出 38 条编号不变量（目录原文 "38 invariants"，正文编号至 38，抽查吻合），配 race catalog（§9.2）与测试分层（§9.3）。抽样感受颗粒度：不变量 2"事务 all-or-none、`seq` 严格递增、允许空洞"；4"每个 payload 恰住在一个地方"；8"删光所有操作自有值之后，剩下的必须是一棵完整合法的会话树加账本"；38"`beginMutation()` 恰拿一条 mutation line、`end()` 唯一释放途径"。测试策略同样写死（§9.3 Tier A 原文）：对每个恢复前缀做 "close, reopen, drive, and compare against uninterrupted recovery"，并补一句 "invoking recovery twice from the initial prefix is **not** sufficient"；每个受测的已提交 lane 边界都要拿发布的 `Lane.state` 与 fresh `restoreLaneState` 对比，divergence 是实现缺陷，**"never silently healed by the next transition"**。

这套写法的效果（分析）：把"分布式系统的口头常识"转成"可被 conformance 套件消费的真值表"。§0.7 明确说 tables that tests consume are part of the contract——文档、测试、实现三者共享同一张表，1,468 行不是散文而是外置的架构。

## 3 durable 包与 Pico：spec 生产线上的运行时

### 3.1 README 原文与 API 面

`packages/durable/README.md` 第一句（原文）：

> Durable conversation, task, and document runtime for Pi.

（口径注：任务简报给的措辞是 "Durable agent runtime with Memory, JSONL, and SQLite storage"，本地克隆中无此句；实际对应句是 "Its current public API provides durable record contracts and memory, JSONL, and SQLite storage implementations"。）当前公开面是记录契约 + 三种存储：`MemoryStorage`、`openNodeJsonlStorage("./session", ctx)`、`openNodeSqliteStorage("./session.sqlite")`，README 顺手把 durability 语义讲清：JSONL 单所有者串行化写、`fsync` 默认 false；SQLite WAL + `synchronous = NORMAL`，**"Acknowledged commits survive process crashes, but the newest commits may be lost after a power or host failure"**——进程崩溃与断电两个等级分开承诺，是耐久存储文档该有的样子。src 实测 4,794 行 TS：`env/`（可移植 FileSystem/Shell 能力）、`storage/{memory,jsonl,sqlite}`、`types.ts`。

### 3.2 Pico 文档考古：v1 → v5，规模说话

Pico 是这个运行时的内部代号，设计文档以每版约两千行的速度燃烧。文件系统实测：

| 文档（首现提交） | 标题 | 行数 |
|---|---|---|
| `agent/docs/pico/pico-simple-handoff.md` | # Pico v1 implementation specification | 2,654 |
| `agent/docs/pico/pico-usage-guide.md` | # pico | 1,572 |
| `agent/docs/pico/pico-handoff-v2.md`（9-07 `73f3257d` preserve pico2 spike design for review） | # Pico handoff v2 | 2,937 |
| `agent/docs/pico2.md` | # pico v2 | 2,491 |
| `agent/docs/pico-v3.md`（9-09 `e045ed2f` add pico design drafts） | # pico v3 | 2,113 |
| `agent/docs/pico/pico-v3.md` | # pico v3（目录草稿版） | 2,577 |
| `durable/docs/pico-v5.md`（9-18 `08016016` move Pico into dedicated package） | # Pico5 specification | 2,212 |

外加 pico-work.md（实现计划 622 行）、pico-rendering.md（305）、pico-usage-v2.md（773）、pico-simple-blockers.md（37）。**没有 v4**（`find *pico-v4* *pico4*` 为空）——v4 是内部消化掉的版本，还是编号跳空，仓库未留解释 **（推测：v4 的设计在 v3→v5 之间被 Chord 落地进度直接吸收）**。注意提交信息：9-07 的是 "**preserve** pico2 spike design for review"——作者把被废弃的 spike 也归档保留，v1/v2/v3 加起来约 14k 行文档是尸体，也是化石层。

### 3.3 Pico5 的核心规则，以及它和 Chord 的脐带

pico-v5.md 开头三行定调："Pico5 is a durable, extensible agent harness. This document is normative."，核心规则一句：

> A Session atomically commits immutable entries, full task records, and Chord-tracked documents. Only committed state is observable.

对照 harness.md：entries 还在（write-once），但可变状态升级成了 **document**——"mutable JSON state represented by Chord operations and occasional complete bases"（§1 Terms）。它的 import 清单就是脐带：`Context/Draft/JsonValue/ReplicatedState` 来自 `@earendil-works/chord`，`applyImmutable, Op` 来自 `@earendil-works/chord/delta`。`docs/pico-v5-chord-usage.md`（386 行）是配套教程：durable document = 完整基线 + Chord 操作 + checkpoint；"Transaction draft: the revocable copy-on-write object ... valid only inside that commit callback"。§1 的 8 条 invariant 里最锋利的是第 3、8 条："**All visible progress is durable. There is no volatile publication path.**" 与 "An uncertain storage failure is fatal to the open Session"——存储结局不确定时宁可炸掉整个 Session，也不猜。§13 Non-goals 再列十项：无 CRDT/离线多写合并、无 JSONL 全局 compaction、**无与已删 Pico 原型的兼容层**。

第 08 篇说过 chord 的 delta engine；两包的接缝处有一篇难得的**失败记录** `durable/docs/chord-delta-findings.md`（358 行，与 durable 迁移同日提交）：作者为绘图工作负载（20,000 strokes × 100 点 = 200 万对象，纯文档 139.5 MiB 堆）试过 ID-addressed graph tracker，结论是删除——内存、import、hydration 成本不可接受；保留现有 tree/path delta 与 weak-proxy cache 修补，并诚实写下 "exhaustive reads still allocate gigabytes and became slower"、"Existing delta alias behavior remains a separate correctness problem"。**测过、量过、砍掉、留档**，这是第 04 篇"实验驱动最小化"在数据结构层的重演（分析）。

### 3.4 JSONL backend 与 sidecar 回收：最后五天的提交

durable 包的冲刺就在快照前的五天（`git log -- packages/durable`）：09-18 迁入包（`08016016`），09-22 SQLite 后端（`5901c9b9`），09-23 JSONL 后端（`898ab804 feat: add durable JSONL storage backend`，21 文件 +3,429/−82）与 sidecar 回收（`b313731b feat: add JSONL sidecar reclamation`，storage.ts +280、测试 +498，合计 +742/−73）。（口径注：简报中的 "WP-066/WP-071" 编号在本地克隆任何提交与文档中都检索不到；`work-packages/` 目录只到 WP09。正文只引用可核实的提交信息原文。）JSONL 的写协议在 `docs/pico-v5-handoff.md` §4：`main.jsonl` 存表写、每 document incarnation 一个 sidecar、每 commit 一个主 marker，**"JSONL must append every prepared sidecar record, append the main marker, and only then apply the prepared in-memory mutation"**——先全部落盘、再改内存，marker 是提交点。区分两处：durable 这边回收的是 JSONL sidecar 死字节；harness.md 的 J1（agent 包 JSONL 后端的快照 compaction）在文档口径里仍是"specified, not implemented"，两条线各自记账。

### 3.5 一个仓库，两条 durable 线（分析）

现在仓库里同时站着两个"可恢复运行时"：**AgentHarness**（agent 包，harness.md 规范，WP00–07 已落地，服务现役 coding-agent 会话格式）与 **Pico5**（durable 包，README 自称含 "the Pico runtime"，绑定 Chord facets/documents，规范先行、存储层刚齐）。接口关系文档没有明说，从证据拼：**harness.md 是被验证过的语义库**（四部分状态、13 叶状态机、孤儿表），**Pico5 是把这套语义接上 Chord 服务边界后的下一代收口**——harness.md §2.8 的 C1（RemoteSession 矛盾）悬而未决，而 Pico 从第一天就设计成"documents through Chord"。第 08 篇说的"三套会话抽象归一"，归一的终点大概率就是 durable 包。这个判断的可证伪点：看 v0.8x 后续版本里 coding-agent 是否切到 pi-durable 存储。

## 4 一条主线的三次出现：可重放的追加日志

把第 03、05、08 篇和本篇钉在一起，会发现 pi 反复使用同一个原语：**事实源是可重放的追加日志，可变状态只是它的投影**。同一哲学在四个层的形态：

| 层 | 载体 | 日志是什么 | 投影/当前态 | 出处 |
|---|---|---|---|---|
| 内存循环 | agent-core 事件协议 | `message_start/update/end、turn_end、agent_end` 完整事件序列（错误也编码为数据） | transcript 数组、AgentState | 第 03 篇 |
| 会话持久层 | coding-agent JSONL | write-once 条目 + parentId 树；compaction 是"前进的复制"不是删除 | 分支 tip、provider 上下文 | 第 05 篇 |
| 恢复运行时 | AgentHarness 存储 | entries write-once + usage ledger append-only + **intent 预记账** | bound values（含 operationState）、getStats 投影 | 本篇 |
| 跨进程状态 | chord replicated state | 快照基线 + delta 操作批（seq 递增，断号即 unready） | 消费者 replica 完整不可变值 | 第 08 篇 |

三处变奏各有必然的差异（分析）：会话层的日志**只事后记账**；harness 层补上了**事前记账**（intent），因为副作用不可重放；chord 层干脆倒转——**日志不是状态的记录，是状态的传输**（apply 操作批即收敛）。贯穿四环的只有两条纪律：其一，任何"当前态"都必须能从盘上重建且重建路径唯一（harness.md 不变量 8：删光操作自有值，剩下必是完整会话）；其二，**杀死在任何两个持久化步骤之间，结果必须可判定**——§0.4 的原话是 "Kill the process between any two transactions and restart"。这就是为什么第 03 篇的循环坚持"事件序列永远完整走到 agent_end"：日志纪律从内存里就开始执行了。

## 5 收官：全课程演进总结

### 5.1 时间线总表（全部 git 可验证）

| 时间 | 事件 | 这一阶段在解决什么 |
|---|---|---|
| 2025-08-09 | monorepo 初始化，`tui`/`agent` 同日出现（第 01/06 篇） | 一个"能跑的自己"：终端 UI + 最小 agent 循环 |
| 2025-08-17 | `ai` 包出现（第 02 篇） | 多提供商 LLM API 的统一表面 |
| 2025-10-17 | `ffc9be88` Agent package + coding agent WIP | 从玩具到产品：harness、会话格式、扩展点（第 04/05 篇） |
| 2025-11-30 | 作者发布设计长文（references 全文） | 极简主义宣言：4 种 API 才值得抽象、六个不做（第 04 篇） |
| 2025-12 | 月提交 872（博客后首月） | 出圈：设计宣言换来第一批外部用户与 Issue（第 01 篇） |
| 2026-01 | 月提交 1,224，史上最高 | 冲刺收尾 + 社区涌入：产品化打磨（第 01 篇） |
| 2026-02 ~ 06 | 稳定 380–500/月；06-18 orchestrator 包结构 | 日常维护 + 在无人注意处埋平台管线（第 08 篇） |
| 2026-07 | harness.md 首提（07-28）、orchestrator→server（07-21）、protocol（07-30）、client（07-31） | 两条线同月动工：会话可持久、边界可跨进程 |
| 2026-08 | telemetry 析出（08-05）、chord 奠基（08-28）、月提交 889 | 平台化公开化：契约、facets、复制状态（第 08 篇） |
| 2026-09 | pico v2/v3 文档归档（09-07/09）、durable 包（09-18）、JSONL 后端 + sidecar 回收（09-23） | 可恢复运行时收口（本篇） |

快照现状：`git describe` = **v0.87.1**（319 个 tag；任务简报的 v0.117.0 与克隆不符，不采信），发布节奏约 1–2 天一版（v0.86.0/0.86.1/0.87.0/0.87.1 挤在 09-20~09-22）。两年了仍在 0.x——结合 protocol "no compatibility guarantees" 与 PLANNING "Compatibility ... is not a requirement"，0.x 不是不自信，是**把破坏性自由当作设计工具**（分析）。

### 5.2 设计哲学回顾：四条，每条都有物证

1. **内核极简 + 外围生长**：默认路径十几年如一日地小（4 工具、无 MCP），新能力一律 experimental 包/子路径 opt-in（chord 零 Pi 依赖、durable 独立包）。物证：第 04/08 篇的"不做清单"与包结构。
2. **append-only 一切**：会话、账本、事件、（部分地）操作日志；改写=追加覆盖，删除=合规特例（harness.md §2.9 precise rewrite 是唯一豁免）。物证：本篇 §4 表格。
3. **供应商无关**：pi-ai 四家族抽象（第 02 篇）→ telemetry 契约无 exporter（第 08 篇）→ SQLite 后端只依赖可移植 `FileSystem`/database facade（本篇）。洁癖一脉相承：**库层不持有对外部世界的具体引用**。
4. **为可审计性做设计**：每字节可人读（JSONL）、每状态可从盘重建（restore projection）、每决定有据可查（38 条不变量、失败实验留档、§0.9 债务台账）。审计不是合规部门的事，是存储格式的事。

### 5.3 如果你想自建一个 pi：分层 checklist

从第 01–08 篇各提炼硬教训（括号内为出处），按建造顺序排：

**第 0 层：姿态与节奏（01）**
- 先造自己要用的东西，抽象等第二个用户（可以是自己的第二形态）出现再做；"if I don't need it, it won't be built" 是节奏工具不是口号。
- 保持 0.x 心态发布：日拱一卒的 release 比憋大版本更能暴露设计错误。
- 把作者动机写进 README——半年后别人（和你）判断某个怪设计时不用考古。

**第 1 层：模型接入（02）**
- 只给"4 种 API 家族"级别的差异做抽象，方言用补丁不用继承树；每多一层通用抽象就多一层猜错的成本。
- 供应商差异全部折叠进类型化事件流（含错误），别给调用者留 try/catch 的借口。
- 做 faux provider：没有 API key 也要能测协议行为——这是第 02/03 篇所有实验零依赖的前提。

**第 2 层：agent 循环（03）**
- 错误是数据不是异常：`stopReason` 编码一切终态，事件序列永远走完。
- abort 要"体面收场"：signal 贯穿 provider/工具/循环三层，但收场动作（补齐事件）不可跳过。
- 运行中注入（steering/followUp）是循环的原语不是包装的补丁——demo loop 与产品 loop 的差距就在这类边角。

**第 3 层：harness 与产品边界（04）**
- 功能清单是负债表：加每个功能前先算它的常驻 token 成本（MCP 论战：13.7k tokens 的 21 个工具 vs 225 token README + 4 个脚本）。
- 权限放容器外（YOLO + 外部隔离），harness 里做审批 UI 是给信任错误定价。
- 系统提示词当代码管：生成式组装、可 diff、可回归。

**第 4 层：会话与上下文（05）**
- 落盘格式先为人审计设计、再为模型喂饭设计；树/分支/覆盖全用追加表达。
- compaction 是"前进的复制"不是删除：原始条目永远在树里，压缩只改 provider 上下文。
- 格式要有版本号与迁移代码，否则半年后你的工具链读不懂昨天的自己。

**第 5 层：终端 UI（06）**
- 差分渲染 + 明确帧协议，别闪烁；把 UI 库从产品里拆出来，它才能被复用。
- UI 是状态的投影不是状态的主人——这条纪律在第 08 篇的 attachment 层又救了一次。

**第 6 层：扩展与边界（07）**
- 扩展用同步装配 + 显式 API，别上事件总线魔法；十个函数指针胜过插件注册表。
- 尽早把核心做成"可被 RPC 使用的库"：命令进/事件出的 stdio 边界是后来一切多进程的预演。

**第 7 层：平台化（08）**
- 平台化 = 把已有边界重写成**有测试的契约**（conformance suite / state-fuzz / service-wire 三件套），做不到就别开新抽象层。
- 库层对 vendor 与宿主双重不透明：telemetry 无 exporter、server 不懂业务 schema、chord 零 Pi 依赖。

**第 8 层：可恢复性（09）**
- 副作用要有 intent 预记账与 `replay: never|safe` 声明；"nothing ran twice" 是验收标准。
- 恢复用完整当前态（13 叶 union 整体替换），不要用"重放日志推断位置"；日志只当账本不当导航。
- 规范文档与债务台账合体（§0.9 式），失败实验留档（chord-delta-findings 式）。

### 5.4 课程结束时仍然悬着的问题

收官不粉饰：C1（RemoteSession 规范 vs 产品矛盾）待决策；J1/T1/S3/R12 挂账；三套会话抽象（旧 JSONL、AgentHarness、Pico）尚未归一；protocol v8 零兼容承诺；delta 的 alias 正确性问题作者自己写着 remains。这份清单本身就是路线图——pi 用两年证明：**一个诚实的未完成，好过一个吹牛的已完成。** 也送给读到这里的你：检验这门课的最好方式，是把 `code/01` 到 `code/09` 的九个实验目录挨个跑一遍——每一行输出都是某篇文章的一句主张的现场证据。

## 实验

在 `../code/09/`，零依赖 `.mjs`（Node ≥20），均已实跑：

| 实验 | 复刻对象 | 验证什么 |
|---|---|---|
| `01-crash-recover-store.mjs` | intent/settlement 双记账 + 孤儿表 | 真文件 oplog；第 3 个 `replay:"never"` 操作效果中途"崩溃"；重启从盘上重建判定：settled 跳过、never 不重放（副作用账本行数不变）、safe 重跑 |
| `02-entry-tree-ledger.mjs` | 四部分状态 + 原子事务 | entry 树 write-once/父校验、bound values 类型标签、usage ledger 与 getStats 投影一致；两 branch 分叉记账互不污染 |
| `03-doc-archaeology.mjs` | 本篇 §3 的证据本身 | 对本地克隆实测：pico 系列标题/行数表、durable src 结构 LOC、git log 中 durable/pico/harness 提交时间线（child_process 只读） |

## 延伸阅读

- `packages/agent/docs/harness.md`：Part 0 两个 worked example（§0.4/§0.5）必读；§3.2、§4.5 是恢复语义心脏；Part 9 是 38 条不变量正文。
- `packages/agent/docs/{tool-durability,assistant-durability}.md`：outcome_ready 与帧列表两份 handoff 设计稿（本篇未展开，读前者第 1 节 10 分钟）。
- `packages/agent/docs/post-wp05-roadmap.md`：审计基线 `5507d76ee`，"Planning inventory, not a behavior contract" 的口径示范。
- `packages/durable/README.md` + `docs/pico-v5.md` §1/§13 + `docs/pico-v5-chord-usage.md` + `docs/chord-delta-findings.md`。
- 外部：`https://mariozechner.at/posts/2025-11-30-pi-coding-agent/`（哲学原文）。
- 系列衔接：第 03 篇（内存层的前奏）、第 05 篇（账本层）、第 08 篇（平台层，Pico 的地基）、第 01 篇（时间线的起点）。
