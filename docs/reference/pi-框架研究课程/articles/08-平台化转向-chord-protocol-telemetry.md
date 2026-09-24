# 08 · 平台化转向：chord、protocol、server、telemetry

> 一句话：2026 年中之后，pi 仓库的增量重心从 coding-agent 悄悄移向 chord/protocol/server/client/telemetry 这批平台包。作者没写宣言，本章全部用 `git log` 和 README 说话：这些包各自是什么、彼此怎么咬合、和"内核极简"哲学到底矛不矛盾。

## 0 本篇地图

- 前置：第 01 篇（时间线与月度提交节奏）、第 03 篇（AgentHarness——平台包的迁出源）、第 04 篇（极简主义四信条——本篇的张力对象）、第 07 篇（RPC 边界——本篇讲它的"第二次重押"）。
- 主角：`packages/chord/README.md` 与 `PLANNING.md`、`packages/protocol|server|client|telemetry|evals/README.md`、`packages/agent/docs/telemetry.md` 与 `telemetry-schema.md`。
- 预计阅读 45 分钟。实验在 `../code/08/`。
- 诚实性预告：这一章的"转向"判断全部由提交历史与文档支撑；凡属解读的地方我会写明 **（分析）** 或 **（推测）**。

五个新包的分工先给速览（细节按此顺序展开）：

| 包 | 一句话角色 |
|---|---|
| chord | 服务语义、facets、复制状态、delta——跨进程边界的"意义层" |
| protocol | 帧与路由信封（CBOR + strict JSON）——边界的"字节层" |
| server / client | 连接、身份、多路 presentation——边界的"连接层" |
| telemetry | vendor-neutral 可观测契约与 schema |
| evals | 文档质量的双镜像回归测量 |


## 1 转向的证据：提交历史不撒谎

### 1.1 仓库级节奏

`git log --date=format:'%Y-%m' | sort | uniq -c`（快照 2026-09-23，共 6,504 次提交）：

| 月份 | 2025-08 | 09 | 10 | 11 | 12 | 2026-01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09* |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 提交 | 85 | 53 | 129 | 280 | 872 | 1224 | 377 | 418 | 461 | 481 | 424 | 494 | 889 | 318 |

*09 为截至 23 日的部分月份。两个峰值各有含义：2026-01 是 coding-agent 冲刺（第 01 篇讲过），**2026-08 的 889 次是仓库史上第二高的单月**——而 chord 恰好落在这个月。平台化没有挤掉内核开发，它是叠上去的。

### 1.2 各包的"地质层"

对每个 `packages/<name>/` 取首次触及提交：

| 包 | 首现提交 | 日期 | 当时在做什么 |
|---|---|---|---|
| coding-agent | `ffc9be88` | 2025-10-17 | Agent package + coding agent WIP |
| **orchestrator→server** | `7ece19b0` | **2026-06-18** | chore: package structure（以 orchestrator 之名） |
| evals | `eafe11fb` | 2026-07-25 | vitest eval harness |
| protocol | `56eb685b` | 2026-07-30 | remote session wire protocol |
| client | `33bc0a7b` | 2026-07-31 | runtime-neutral session client |
| session-backends | `a80008b9` | 2026-08-05 | storage 包改名而来 |
| telemetry | `6b461b75` | 2026-08-05 | extract telemetry package |
| chord | `28b49a6b` | 2026-08-28 | Chord runtime foundation |
| durable | `08016016` | 2026-09-18 | move Pico into dedicated package |

三个观察。第一，**server 的祖先比 protocol 还早六周**，且最初叫 orchestrator——命名从"编排进程"到"服务器"的变化本身就泄露了野心升级（分析）。第二，protocol/client/server 在 2026-07 的最后三天密集落地，是典型的"先有实验、再拆包"节奏。第三，commit message 里没有任何"我们转向平台了"的宣言式提交——2026-07 之后含 platform 关键词（chord/protocol/facet/replicated/telemetry/server/worker）的提交有 92 条，全部是工程碎步。这个仓库的方向感藏在提交图里，不在公告里。

### 1.3 重心位移的度量

`git log --since=2026-07-01 -- packages/<p>` 的触及提交数：

| 包 | coding-agent | agent | ai | tui | server | protocol | client | telemetry | chord | durable | session-backends | evals |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 近三月 | 715 | 608 | 399 | 173 | 103 | 83 | 69 | 25 | 42 | 21 | 88 | 50 |

老四件仍是活跃主体（agent 的 608 条大头是 AgentHarness/durable 化，见第 03/09 篇），但平台七包合计 401 条、且**全部生命周期都在这三个月内**。再配上体量：新平台包 TS 行数约 21k（chord 10.7k、durable 4.8k、server 2.0k、evals 1.4k、client 1.1k、protocol 与 telemetry 各 0.9k），已经追平整个 tui（18.3k）。一个只做终端编码代理的项目不会长出这些东西——**（分析）** 至此可以说：转向成立，且是叠加式而非替换式。

### 1.4 奠基提交的三种姿势

首现提交的规模同样有话要说（`git show --stat` 实测）：

| 首现提交 | 内容 | 规模 | 姿势 |
|---|---|---|---|
| `56eb685b`（protocol） | remote session wire protocol | 23 文件 +1,886 | **绿地**：一锤子新协议 |
| `6b461b75`（telemetry） | "extract telemetry package" | 38 文件 +686/−546 | **析出**：从 agent 内部拆出+薄封装，净增很小 |
| `28b49a6b`（chord） | Chord runtime foundation | 36 文件 +1,307 | **奠基**：先立骨架，42 次提交长到 src 5,460 行 |

三种引入方式对应三种野心等级：协议是替换旧边界的宣战，telemetry 是内部整理的顺手为之，chord 则是奔着"长期独立演化"去的——它后来的提交曲线（42 条全部是 feat/refactor，无一次 revert 风暴）也印证了这点（分析）。

## 2 Chord：把"插件系统"做成独立运行时

### 2.1 一句话定义与一个反常声明

README 第一段（原文）：

> Chord is an application-composition runtime for systems assembled from plugins/extensions. It provides facets, services, replicated state, and a pluggable remote-service boundary. It is developed as a standalone package in the Pi monorepo, but it is not a Pi package: it does not depend on any other Pi workspace package and can be used by unrelated applications.

"不是 Pi 包、零 Pi 依赖、可被无关应用使用"——在 2026-08 这个节点，作者往自己仓库里放了一个**服务之外的通用库**。这一句就是平台化最直白的自供状：他要复用的不是 agent 逻辑，而是"组装运行中的系统"这件事本身。

### 2.2 facets：按进程切开的插件

README 对四个概念的分工值得逐字读：

- **Plugin**：同步装配单元，声明提供/需要哪些服务。所有 plugin 声明完毕后，host 校验完整依赖图、绑定服务、**按依赖序激活、按逆依赖序释放**。"These units are called facets."
- **Facet**：plugin 的部件，每个 facet 单独打包，"runs in the process or environment where it's supposed to run"——backend、browser、TUI 各归各位。这就是第 04 篇那个"单体 coding-agent"被切开的方式：**扩展的功能单元第一次有了"部署形状"**。
- **Service**：类型化稳定 token，singleton 或 keyed；可以进程内（JavaScript 全能力），也可以"remotely exposable"。消费者持有稳定 facade，provider 断线、替换都不影响句柄。
- **Context**：Go 风格的取消与作用域值系统，权限/遥测随值携带，Chord 本身不依赖二者。

打包与加载（README 的 bundling 节）：esbuild 把每个 facet 打成内容寻址的 `.cjs`，加载时**逐个校验 SHA-256、用 `node:vm` 直接编译**而不是进 Node 模块缓存；`reload()` 先验证候选、再无缝替换 singleton（"without an unavailable interval"）。供应链洁癖（第 02 篇）在这里继续：`Chord never installs dependencies or runs package lifecycle scripts.`

### 2.3 replicated state 与 delta engine：README 说到的，src 里有没有？

README 承诺：生产者用 `change(context, callback)` 发布**原子 copy-on-write 事务**，消费者收到完整不可变值；断线即 unready，重连重新水合。PLANNING §8 把语义列成 12 条，包括"更新与快照赛跑时先缓存快照后的间隙、绝不让陈旧状态冒充当前"、状态身份 = `provider binding + service id + keyed address + member name`，并明确**非目标**：

> durability or reconstruction after process restart; event history; CRDT merging or multiple writers; offline mutation replay; high-frequency stream transport.

核对实现：`packages/chord/src/delta/`（diff.ts / draft.ts / tracker.ts / value.ts，另含 astra、cow 两个子实验目录）与 `src/services/state-codec.ts` 存在，测试面覆盖 `delta.test.ts`、`state-fuzz.test.ts`、`state-diff.test.ts` 等——**delta engine 是落地代码，不是纸面规划**（src 合计 5,460 行）。README 的 delta 原语 API 也很克制：首次 `flush()` 永远发全量基线批，后续 flush 发路径化操作；"Batches guarantee convergence but are not canonical or necessarily minimal"（保证收敛、不保证最小）——把正确性目标钉死、把优化目标留白，是成熟协议文的写法。

### 2.4 与 coding-agent RPC 模式的关系：同一条边界的第二次重押

第 07 篇里，RPC 模式把 agent 挂在一根 stdio JSONL 上：命令进、事件出，GUI 只是客户端。现在看 protocol README 怎么分工：

> Chord owns the payload semantics carried inside these envelopes: `{ serviceId, instance?, member, args }` calls, the `$chord.service` control vocabulary, ... Clients and servers parse those values through `@earendil-works/chord` at the service adapter boundary.

而 server README 收尾更狠："Neither an open JavaScript Session nor a Harness crosses the process boundary." 对照两代方案：

| | coding-agent RPC（第 07 篇） | chord/protocol/server（本篇） |
|---|---|---|
| 边界内容 | 命令/事件词汇表（prompt、steer、agent_start…） | 任意 service 调用与订阅（业务 schema 对 server 不透明） |
| 帧 | 行协议 JSONL | 4 字节长度 + CBOR，信封严格校验 |
| 会话状态 | 服务端进程内 | Session/AgentHarness 仍是进程本地，跨界的只有快照与操作批 |
| UI | 客户端渲染事件 | presentation attachment：一个 session 可挂多个展示端 |

**（分析）** 同一条"跨进程边界"被重押了一次：第一次它承载"一个 agent 的对话流"，第二次它承载"任意类型化服务的集合"。RPC 时代的痛点（事件词汇手工维护、UI 只有 TUI 一家）正是 chord 词汇表要消解的东西。PLANNING §11 的迁移表直接点名了迁出源：`agent/src/plugins/services/*`、`coding-agent/src/experimental/facets.ts` 归 Chord，而 framing/routing/认证/进程生命周期归 server/client——两边在文档层面已经把刀法画好了。

## 3 protocol、server、client：一条被写成代码的边界

### 3.1 pi-protocol：版本 8 的路由信封

`packages/protocol/README.md` 只有 41 行，密度极高。要点：

- 帧格式：**4 字节无符号大端长度 + 一个定长 CBOR 项**；`ClientMessageDecoder/ServerMessageDecoder` 容忍任意流式分片与粘包。
- 路由三级：server target `{serverId}`，Session target `{serverId, sessionId, attachmentId}`——"The combined route fences calls to one logical server, durable Session, and live presentation attachment."
- 严格到强迫症：信封 schema 拒绝未知属性；opaque payload 必须是 strict JSON（递归拒绝 NaN、字节数组、原型链、循环引用）；违约统一抛 `ProtocolValidationError`。默认上限：单帧 16 MiB、100 万元素、64 层嵌套。
- 自知之明写在最后两行："Peer authentication and authenticated service contexts are not implemented by the experimental transport"、"The protocol is experimental and **has no compatibility guarantees**."

版本号 8 本身就是证据：一个还没有兼容性承诺的协议已经迭代了八轮——每轮都改了线格式（分析）。

### 3.2 pi-server：无头宿主，业务不透明

server README 定义自己是 "Experimental local server for the new durable Session and Agent Harness interfaces"。架构上最值得注意的是**处处不透明**：

- server 校验 attachment 路由，但 "does not load the facet contract"——它不懂任何业务服务；
- 会话目录投影为 replicated presentation-safe state（用 §2.3 的复制状态给多展示端喂目录）；
- 转录（transcript）"route as ordinary service state without server-owned business schemas"——连聊天历史都只是"某个服务状态"；
- `serverId` 是 launcher 给的逻辑身份，不是 socket 地址；一个 session 可有多个 presentation attachment，`attach` 幂等，掉线只在该连接的在途调用结算后才释放 attachment。

README 给出的启动样例是 Unix socket（`createUnixServer(host, {serverId, path})`），host 只需提供三样：服务路由宿主、有界会话解析器、带路由的会话工厂。**这是一个把自己实现成"纯路由器"的服务器**——业务全在 worker facet 进程里。

### 3.3 pi-client：先验明正身，再谈业务

client README 的握手洁癖与 server 对称：`Client.connect({serverId, transportFactory})` 会校验物理端点报出的逻辑 `serverId` 是否匹配预期；请求按 id 关联，会话请求带全 `{serverId, sessionId, attachmentId}` 防串台；断线时本地拒绝在途请求但**绝不自动重连重放**——"explicitly repeat only operations known to be safe"。Unix 传输自带发现：扫目录、从文件名推导 serverId、并发探测至多 16 个 socket、坏的静默忽略。

三个包连读能读出一个明确的层次律：**protocol 管字节与信封，chord 管服务语义，server/client 管连接与身份**——每层都拒绝理解上层业务（分析）。这与第 07 篇 stdio JSONL"协议即业务事件表"的风格是质变：这一代边界上跑的是通用服务调用，业务词汇被推到了服务契约自己手里。

## 4 telemetry：把可观测性做成契约而不是库调用

### 4.1 一个"什么都不干"的包

`packages/telemetry/README.md` 的自述清单就够惊人：提供 `TelemetryContext`/`TelemetrySpan` 回调式契约、`NOOP_TELEMETRY_CONTEXT`、内存参考实现、可序列化 schema 定义——然后一句：

> no exporter, global current-span state, or dependency on a telemetry backend.

对比行业常态（直接 `import * as Sentry`、全局 tracer 单例、AsyncLocalStorage 隐式父链），pi 的做法是三件反着来的事：

1. **上下文显式传参**。`packages/agent/docs/telemetry.md` 开宗明义：harness/session/lane 的每个方法都带一个必需的尾部 `Context` 参数，"without `AsyncLocalStorage`"；还专门写了反面论证——`AgentHarnessOptions.telemetryContext` 这个"接收者级默认值"曾存在，后被删除，因为"一个 harness 级默认值无法表示两个不同父级的并发调用者"。
2. **span 生命周期归回调**。没有公开 `end()`；`startSpan` 包住回调，结算即关。适配器契约把语义细则写死（同步恰好调一次回调、透传 resolve/reject 同一性、录制方法必须同步被动不抛异常、结算后的调用全部忽略……）。
3. **语义有测试套件**。`@earendil-works/pi-telemetry/testing` 导出 runner 无关的 conformance suite：任何第三方适配器（OTel、Sentry、日志）接入前先过同一套语义检查。这相当于把"什么算合法的 telemetry 适配器"变成了可执行规范。

### 4.2 schema 才是给读者的正文

`packages/agent/docs/telemetry-schema.md` 是生成文档（"Generated by generate-telemetry-docs.ts"），列出 `pi.ai.request`、`pi.harness.run/compaction/navigation/checkpoint/turn/step/tool/hook/sleep/event_handler`、`pi.session.write` 每个 span 的**起止属性表**：类型、必填、枚举值、以及**基数标注**（`pi.model` 无标注、`pi.session.id` 标 high cardinality、`pi.error.code` 标 low cardinality）。

基数标注暴露了作者真的懂后端：高基数字段（会话 id、调用 id）在遥测后端是账单炸弹，schema 层面就替你标好。第 03 篇讲过的"错误编码进流、永不 throw"在这里有了配套品——**run/step/tool 的 outcome 全是枚举字符串**（`completed|aborted|failed|suspended`、`succeeded|retry|failed|overflow`…），与 stopReason、ExecutionStopCause 一脉相承：一切终态可枚举、可聚合（分析）。

### 4.3 为什么做成协议而不是库调用（分析）

design note 里连 RPC 跨进程的 trace 传播都想好了：客户端从 `rpc.client` span 注入 vendor-neutral carrier，服务端 extract 后起 `rpc.server`——但 `TelemetryPropagation` 接口"归属 telemetry 包、RPC 基础设施、还是后端集成包"仍列为 open decision。把这个包放进整个转向的语境里，动机链条是：

pi 的定位是**库和 harness**，不是应用。应用要接什么后端是应用的选择（README：adapters for "OpenTelemetry, Sentry, logs, or another backend"）；一旦 pi 的库代码 `import Sentry`，每个下游用户都被迫背上这个依赖和这份账单。所以遥测必须做成"契约 + 参考实现 + conformance"，vendor 留在进程边缘之外。**这与 chord 的"零 Pi 依赖"、server 的"业务不透明"是同一种洁癖的三个投影：pi 的库层拒绝持有对外部世界的具体引用**（分析）。诚实标注：telemetry 包自身 0.9k 行，但 harness 侧的 schema 与上下文迁移是 agent 包近三月 608 次触及提交的重要成色（`git log --since` 口径）。

### 4.4 设计文档的自我诚实

`packages/agent/docs/telemetry.md` 第一行状态声明值得抄给所有平台团队：

> **Status:** Design input, not a normative contract. ... Local propagation is scaffolding rather than proof of complete telemetry semantics: most runtime spans and cross-process trace propagation remain design or implementation work.

它还留了一个 `TODO_CONTEXT` 哨兵："substituting `BACKGROUND_CONTEXT` would hide unfinished propagation"——未完成传播的调用点宁可让编译期可见也不悄悄填默认值。**文档区分"已落地/设计中/待办"的纪律，是这批平台包可信度的来源之一**（分析）。

## 5 侧翼：evals 与"文档是可测量资产"

`packages/evals/README.md` 干的事在同类项目里罕见：documentation-lift eval——同一组用例，`without_docs` 镜像（删掉 README/docs/examples 并剥掉系统提示词里的文档路由段）与 `with_docs` 镜像各跑一遍，Docker 隔离、配对报告 pass-rate lift；一个 pair 任何一臂缺分数就扣住头条数字不发布（"Blocked pairs withhold headline lift"）。

**（分析）** 这是平台化的另一面：当产品要服务"别人的工作流"时，文档质量从主观审美变成可回归测试的指标。它和 telemetry（运行时可观测）、evals（发布前可测量）一起，补的是"库作者维护生态"需要的仪表盘。诚实标注：evals 需要 `PI_PROVIDER/PI_MODEL` 与 Docker，本篇实验不复现它。

## 6 张力：内核极简 vs 外圈平台化，矛盾吗？

第 04 篇的四信条（4 种 API 才值得抽象 / 工具最小集 / 权限在容器外 / 上下文用户自治）针对的是 **harness 替模型决定世界**。拿本篇的清单逐条对照——以下为**分析，非作者主张**：

1. **不冲突的部分**：平台包没有一个进入 coding-agent 的默认路径。chord 零 Pi 依赖、protocol/server/client 全部标注 experimental、telemetry 默认 NOOP——用户不启用时，安装树与心智负担不变。"if I don't need it, it won't be built" 依旧成立：这批包全是因为"作者自己要跑多进程/WebUI/持久会话"才建的（durable 篇再证）。
2. **真张力一：词汇量。** 第 03 篇学 `AgentHarness` 已经要消化 entry tree/values/lanes，现在又加 facets/services/attachments/envelopes。同一个仓库里出现两套（即将三套）会话抽象（旧 JSONL、durable Session、Chord replicated state），**认知成本由读者代付了**。PLANNING "implemented from scratch... Compatibility ... is not a requirement" 说明作者知道并选择承受。
3. **真张力二：兼容性地心引力。** 极简主义者最恨的"别人依赖了你的shit"正在发生——README gallery、peerDependencies "*"、迁移边界表，都是生态化的轨道。protocol 已到 v8 仍无兼容承诺，是他与引力赛跑的方式：**用高频破坏维持"实验"状态**。
4. **我的裁定**：哲学没变，**射程变了**。2025 年的敌人是"臃肿的 harness"，2026 年的工程是把"能承载多种 agent 应用的运行时"造出来。极简主义回答"默认路径放什么"，平台化回答"可组合性放到哪一层"——两者在同一仓库里分区而治。这个方案能不能收口（三套会话抽象归一），看 durable + chord 落地速度，第 09 篇见分晓。

## 7 启示：harness → platform 的演化清单（分析）

给也在维护"从工具长成平台"的人一份务实对照：

**值得做平台化的信号**——(a) 你已经有第二条产品线/宿主形态在本仓库里寄生（pi：TUI 之外的 WebUI、持久会话、编排）；(b) 边界需求重复出现第三次（RPC 事件表 → 服务信封 → 通用复制状态）；(c) 你有能力把破坏性变更的成本内化（单人主导 + 无兼容性包袱）。

**是陷阱的信号**——(a) 平台抽象先于第二宿主落地（chord 是"实验证明了很多必需行为"之后才从 0 写，顺序不能反）；(b) 为平台引入运行时分发/生命周期脚本（Chord 明确拒绝 install/lifecycle）；(c) 把平台默认塞进产品路径（experimental 包不进默认安装面）；(d) 没有 conformance/eval 这类**语义防回归**就上协议（pi 每个新边界都配了一族测试：service-wire、state-fuzz、adapter conformance、evals）。

一句话版本：**平台化不是加功能，是把已有边界重写成有测试的契约；做不到就别做。**

## 源码精读：chord 三层文件地图

```
packages/chord/src/
├─ api.ts / types.ts          # 根导出：service token、singleton/keyed、facet host/loader
├─ context/                   # Go 式 Context（与 telemetry.md 的 Context 同一族设计）
├─ delta/  diff|draft|tracker|value (+astra/ cow/)   # README 承诺的 delta engine
├─ facets/ host|loader        # 依赖图校验、激活/释放、reload 代际
├─ services/ provider|consumer|state|state-codec|wire  # 服务语义与复制状态
└─ node.ts / json.ts          # vm 加载与 strict JSON 守卫
```

README 原样的最小 delta 用例（`node` 可直接改写为 JS，见实验 02 的迷你复刻）：

```ts
import { apply, track } from "@earendil-works/chord/delta";
const changes = track({ output: "", count: 0 });
changes.flush();                      // 首次 flush = 全量基线批
changes.state.output += "done\n";
const ops = changes.flush();          // 之后只有路径化操作
const replica = apply({ output: "", count: 0 }, ops);
```

复制状态的写侧只有一个原子入口（`packages/chord/src/services/state.ts` 一族）：

```ts
const status = env.replicatedState({ output: "", count: 0 });
status.change(context, (draft) => { draft.output += "done\n"; });
// 回调抛出 = 整笔作废；成功 = 恰好发布一个修订 + 一个操作批
```

## 实验

在 `../code/08/`，全部零依赖 `.mjs`（Node ≥20），已实跑：

| 实验 | 复刻对象 | 验证什么 |
|---|---|---|
| `01-facet-container.mjs` | facets/services/依赖图 | 缺服务拒绝装配、按拓扑序激活、逆序释放、循环依赖检测 |
| `02-rpc-boundary.mjs` | chord+protocol 分层 | facet 放进子进程：invoke/request/response/event 行协议桥 + replicated state 快照/更新复制，父子状态一致性对比 |
| `03-telemetry-contract.mjs` | telemetry 契约 | 同一业务函数流经假 vendor A/B 两适配器 + NOOP，conformance checker 判语义字段一致；换 vendor 零改业务代码 |

## 延伸阅读

- `packages/chord/README.md`（概念正文）→ `PLANNING.md` §1/§8/§11（目标、复制状态 12 条、迁移边界）。
- `packages/protocol/README.md` + `packages/server/README.md` + `packages/client/README.md` 连读：信封 → 宿主 → 客户端。
- `packages/telemetry/README.md` + `packages/agent/docs/telemetry.md`（显式 Context 设计论证）+ `telemetry-schema.md`（生成的属性表正文）。
- `packages/evals/README.md`：documentation-lift 双镜像流程。
- 外部：rfc.earendil.com/keyword/pi（长期规划，未逐篇核读，仅作导航）。
- 系列衔接：第 03 篇（被迁出的 services/replicated-state 原主）、第 04 篇（张力对象）、第 07 篇（第一次重押的 JSONL 边界）、第 09 篇（durable/Pico 收口）。
