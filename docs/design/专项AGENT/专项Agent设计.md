# 专项 Agent 设计（一等公民）

> 日期：2026-09-12
> 状态：v3.1。**本文合并并取代**《多Agent架构设计》（v2.1）与《客户端内编程 Agent 设计》（v1），两文已删除（git 历史可查）。相对旧文的修订见 §0.2。
> **v3.1 修订**（2026-09-13，按用户反馈）：重写使用场景，聚焦「客户端 / 渠道 + 代码开发工具 → 绑定项目的代码开发」；系统运维 Agent 从 cron 巡检重定位为「知识 / 记忆 / 用户指南 / 客户端自动化」（§0.2 R11/R12、§3、§6）。
> 目标：让专项 Agent 真正可用——单一职责、比通用 Agent 更好地完成特定任务，且简单、稳定、可维护。
> 相关：`docs/design/2026-08-23-memory-wiki-knowledge-base-design.md`、`docs/design/自主进化Agent/`；外部参考技能 `.claude/skills/hermes-multiagent-reference/`

---

## 0. 结论摘要

### 0.1 关键决策

| 问题 | 结论 |
|------|------|
| 一等公民怎么定义 | **身份 + 运行面 + 三件事 + 一个开关**（§2）。「运行面」是本轮新增概念 |
| 运行面有几种 | 两种：`pi`（内置内核，完全体）与 `acp:<backendId>`（外部编程 CLI 直达，薄层） |
| 预置 Agent 团队 | 队长 + 4 位一等公民：`code-dev`（开发，acp）、`system-keeper`（维护，pi）、`info-curator`（情报，pi）、`chronicler`（记事，pi）。并非新发明——客户端已有 7 条预置任务挂在 assistant 名下跑，蓝图是把它们转正（§2.5） |
| 开发场景的核心概念 | **开发上下文 = 项目 + 工具**，三级来源（会话显式 > Agent 绑定 > 全局默认），客户端与渠道同一套模型（§5.2） |
| code-dev 做不做双层 Agent | **不做**（保留原判断，§5.1）。消息直达 CLI，Lumii 不做第二层 LLM 循环 |
| code-dev 的最大缺口 | **多轮无上下文**——每条消息都新开 CLI 进程（实测 `--resume` 可用，升 P1，§5.5）；渠道侧缺 **/project 项目切换**且未传 cwd（§5.2/§5.4） |
| 预置定义放哪 | 本仓库是独立版（无 api-server，`agents-repo.ts:1-9`），**改本地定义即生效**（§5.10）；回流完整版时需同步 api-server |
| system-keeper v1 做什么 | **资产维护 + 代操客户端**：记忆精炼、Wiki 策展、用户指南同步、客户端自动化；不做 cron 巡检（§6.3） |
| system-keeper 怎么「了解系统」 | 配一份**运维手册技能**，按需 `skill_invoke` 加载（§6.2） |
| 自主开关 | 目前不存在，需新增（per-agent，`app.json` `autonomousAgents`）+ UI 入口（§7.4） |
| 必修债务 | cron 产出归属硬编码 `assistant`（`bridge.ts:1117/1131`），**先修再引入第二个 Agent**（§7.1） |
| 会话接续 | 设计不实现；优先做「显式按钮」版本（§8） |

### 0.2 相对旧文档的修订（反思结论）

| # | 旧文档的问题 | 本文的修订 |
|---|------------|-----------|
| R1 | 两份文档对 code-dev 定位矛盾：多 Agent 文档把「编程 CLI」列为 code-dev 的工具（隐含双层），编码文档明确否决双层 | 用「运行面」概念统一（§2.2）；code-dev 只有一条链路 |
| R2 | **多轮连续性缺失**：两份文档都假设「一条消息 = 一次 CLI 调用」，都没有回答第二条消息的上下文从哪来 | §5.5 多轮续接升为 P1（已实测 `--resume` 完整可用） |
| R3 | 绑定即劫持：绑定后所有消息进 CLI，界面上无任何指示，也没有出口 | §5.8 模式可见性 + 退出机制 |
| R4 | 权限只写「P0 实测」没有结论 | §4.1 给出实测结果与逐后端差异；发现 codex **默认拒绝写文件却假报成功** |
| R5 | system-keeper 只有职责表，没有第一个可验收的闭环，也没有产出送达通道 | §6.3 v1 三件巡检 + §6.5 送达通道 |
| R6 | code-dev 的自主场景被列为「默认关、用户可开」，但没回答跑起来后归属/记忆怎么算 | §5.1 明确 v1 不做 code-dev 自主 |
| R7 | `evolution:` 守卫是精确匹配 `evolution:main`，多 Agent 会话会漏保护 | §7.3 守卫泛化（四处改动点） |
| R8 | 「权威数据源 = api-server」使预置 Agent 被误判为跨仓库改动 | §4.4：独立版无 api-server，本地定义即事实权威 |
| R9 | 缺失败可见性：自主 run 失败、CLI 卡住，用户无从知晓 | §7.6 |
| R10 | ACP 子进程退出不清理（`dispose()` 从未被调用） | §5.11 / 附录 A.4 |
| R11 | 场景写虚了：以「自举」为主轴，没写清「客户端 / 渠道 + 工具 → 绑定项目开发」的真实主线，也没有逐步走查 | §3 重写为逐步场景；渠道链路补齐（/project、cwd 接线，§3.2/§5.2/§5.4） |
| R12 | system-keeper 锚在「cron 巡检」上，价值低：任务少、失败已有系统通知、腐化面小 | §6 重定位为知识 / 记忆 / 用户指南维护 + 客户端自动化 |
| R13 | 缺团队整体蓝图：只有两位预置 Agent，而客户端已有 7 条预置任务以 assistant 名义运行（身份、记忆、归属全混在一起） | §2.5 团队蓝图：转正为 4 位一等公民 + 协作机制 + 三步落地 |

---

## 1. 背景与目标

### 1.1 用户诉求

1. **实用的专项 Agent**：单一职责，真的比通用 Agent 更好地完成任务——「我写代码，真的可以用来很好完成代码开发；系统维护，真的能够了解系统并做好日常维护」。
2. **简单实用、稳定、架构良好**：不过度设计，也不因害怕过度设计而省略关键设计。
3. 此前的多 Agent 诉求继续有效：偏好记忆让产出更符合预期；自主会话可见可对话；会话接续是理想态（暂不实现）。
4. **（2026-09-13 明确）开发场景的真实主线**：在 Lumii 上，通过客户端或消息渠道，配合代码开发工具，完成**绑定项目**的代码开发（§3.1/§3.2、§5）。
5. **（2026-09-13 明确）系统运维 Agent 的着力点**：知识、记忆、用户指南、自动化操作客户端——不是定时任务这类稳定功能的日常巡检（§6）。

### 1.2 优先级阶梯（本设计的排序准则）

**功能完好 → 用户体验 → 稳定 → 可维护。**

本文所有取舍引用此阶梯。典型应用：多轮续接是「功能完好」项（没有它 coding agent 不成立），不是打磨项；模式可见性是「体验」项；归属修正与退出清理是「稳定」项。

### 1.3 为什么是多 Agent（保留 v2 精华）

| 收益 | 说明 |
|------|------|
| 持续上下文带来更好的产出 | 专属经验 + 用户偏好，让同类任务越做越准。**这是核心** |
| 职责隔离带来更清晰的行为 | 提示词与工具面收敛，行为可预期 |
| 自主时间带来主动价值 | 触发源是时间/事件，不是用户消息 |

派生判据（新增 Agent 前逐条过）：独占的能力面 / 独立的长期上下文 / 清晰的触发边界 / 可验证的产出 / **是否需要「自己的时间」**。只在被调用时工作的职责，用 `spawn_agent` 临时子 Agent 即可。按这套判据组出的常驻团队见 §2.5（队长 + 4 位一等公民）。

---

## 2. 一等公民的定义

### 2.1 四个构件

```
身份（Definition）  名称、提示词、类别、技能、工具白名单 ——「是谁、能做什么」
运行面（Runner）    谁执行对话循环 —— pi（内置内核）或 acp:<backendId>（外部 CLI 直达）
资产（Assets）      记忆（用户偏好共享 + agent_memories 独立）、会话（含 evolution:<agentId>）、时间（cron + tick）
开关（Switch）      自主能力是否开启；默认关，升级必须显式
```

**核心判断**：身份与资产属于 Agent；**循环（loop）由谁执行不重要**。编码场景里 Claude Code / Codex 已经是成熟的 agentic 循环，Lumii 不在内部重复实现它——这是「简单实用」的关键，也是 §5.1 否决双层 Agent 的根本理由。

### 2.2 运行面（Runner）——新概念

两份旧文档的矛盾（工具 vs 直达）本质是**没有把「身份」与「执行循环」分开**。分开后：

| 运行面 | 含义 | 谁拥有循环 | 适用 |
|--------|------|-----------|------|
| `pi` | 内置内核（agent-runtime 实例） | Lumii | 需要记忆闭环、自主时间、满意度追踪的 Agent |
| `acp:<backendId>` | 外部 CLI 直达（claude/codex/cursor/opencode） | CLI 自己 | 需要顶级编码循环的对话型 Agent |

路由规则见 §5.3：**同一个 Agent 的身份固定，运行面由「会话绑定」决定**（无绑定 = pi，有 dev binding = acp）。

### 2.3 一个开关 + 三件事

开关打开（自主）后，Agent 获得：

| 能力 | 含义 | 用户价值 |
|------|------|---------|
| 自己的记忆 | 领域经验独立积累；用户偏好共享（已验证，现成行为） | 同类任务越做越准 |
| 自己的会话 | `evolution:<agentId>`，可回看、可对话 | 能看它干了什么、能直接聊 |
| 自己的时间 | 可自建 cron、被 tick 遍历 | 主动发现、无人值守 |

### 2.4 两种运行面的能力对照（诚实表）

| 能力 | pi 型 | acp 型（v1） | 不做的理由 / 回补条件 |
|------|-------|-------------|---------------------|
| 用户偏好注入 | 自动（2400 字符预算） | 注入摘要（`--append-system-prompt`，§5.6） | — |
| 领域记忆（agent_memories） | 自动读写 | 不参与。**可持久上下文 = 仓库本身**（AGENTS.md / git / CLI 会话续接） | 编码知识的正确沉淀位置是代码仓库，不是 Agent 记忆 |
| 自主时间 | 有 | **v1 不做**（§5.1） | 出现「无人值守改代码」的真实需求且有人审渠道后再谈 |
| 满意度 / 能力追踪 | 有 | 不参与 | 数据源是运行时会话；ACP 旁路不产生该数据 |
| 会话可见性 | 有 | 已有（事件流 + 消息落库，§4.1） | — |
| 提示词进化 | 有 | 无 | 同上 |

**诚实结论**：acp 型 Agent 目前是「对话型一等公民」——有身份、有会话、有偏好注入，但没有记忆积累与自主。这对 code-dev 是可接受的取舍；不接受的用户可以用 pi 运行面（无 CLI 绑定）跑 code-dev。

### 2.5 团队蓝图：队长 + 4 位一等公民（2026-09-13 补）

**先看一个事实**：客户端已经有 7 条预置定时任务在跑——资讯抓取（`news-pipeline`）、早间简报、工作日报、每周复盘、专注提醒、工作区整理、Wiki 无效文件清理（`seed-cron-jobs.ts`）。它们**全部挂在 `assistant` 名下**（`agent_id` 与落库归属），产出沉淀到 Wiki、资讯卡与通知。所以组建团队不是发明新角色，而是**把这摊已经存在的事拆出身份、记忆与边界**——每位成员都回答同一个问题：「为什么不是主助手兼任」。

#### 队伍名单

| Agent | 定位 | 能为你做什么 | 运行面 | 接管的现状 |
|-------|------|-------------|--------|-----------|
| 主助手（队长） | 前台与调度 | 日常对话；接单后判断交给谁；一次性任务用 `spawn_agent` 临时子 Agent | pi | 不变 |
| **灵栖开发** `code-dev` | 绑定项目的代码开发 | 「订单页分页修一下」——桌面或微信一句话，改指定项目，多轮追问 | acp | 详见 §5 |
| **灵栖维护** `system-keeper` | 资产维护 + 代操客户端 | 「整理下我的记忆」「资料库去个重」「把设置改了」 | pi | 详见 §6；顺带接管 `seed-workspace-tidy`、`wiki-purge-invalid-files` |
| **灵栖情报** `info-curator` | 按偏好的资讯策展 | 「每天早 8 点推 AI 和工程效率，别推标题党」；可对话调教订阅域/节奏/时段 | pi | 接管 `news-pipeline` |
| **灵栖记事** `chronicler` | 工作痕迹管家 | 日报 / 周复盘 / 早间简报 / 专注提醒；「这周我干了什么」 | pi | 接管 `seed-daily-report`、`seed-weekly-review`、`seed-morning-briefing`、`seed-focus-check` |

**为什么值得独立（五判据逐条过）**：

| Agent | 独占能力面 | 独立长期上下文 | 触发边界 | 可验证产出 | 自己的时间 |
|-------|-----------|--------------|---------|-----------|-----------|
| 开发 | 编码 CLI（ACP） | 项目结构、构建命令、代码规范 | 改代码，且目标是绑定项目 | git diff / 测试结果 | 暂不（v1 交互型，§5.1） |
| 维护 | 资产写权限（Wiki/记忆/指南） | 资产历史、维护经验 | 整理 / 维护 / 代操类请求 | 报告 + diff | ✅ |
| 情报 | 信息面（web + 资讯卡） | 订阅域、兴趣画像、去重历史 | 外部世界 → 你，只此一个方向 | 简报 / 资讯卡条目 | ✅ |
| 记事 | 痕迹面（会话 / 工作记忆聚合） | 报告风格、历史日报 | 回顾 / 汇报类请求 + 定时产出 | 日报四段式、周复盘 | ✅ |

> 情报的独立理由要讲透：主助手加 `web_search` 只能答**单次问题**，做不了「持续订阅 + 去重 + 偏好调教 + 定时推送」——这才是独立成角色的资格。

#### 独立性：每位拥有同一套「五件套」

| 维度 | 机制 | 依赖（§9 贯通项） |
|------|------|------------------|
| 身份 | 各自提示词/分类/技能；选择器可选（`selectable`） | B1 / D1 / D3 |
| 记忆 | `agent_memories(agent_id)` 独立积累 | 数据层已有；归属修正 A1 |
| 会话 | `evolution:<agentId>`，可回看、可追问 | A3 守卫泛化 |
| 时间 | 各自 cron + 单 tick 遍历 + per-agent 自主开关 | A2 / A4 |
| 工具面 | 定义级白名单（情报无文件写、记事无 web、维护自主档无 bash） | 现有 `filterToolsByDefinition` |
| 运行面 | 开发 = acp，其余 = pi | 本轮已设计 |

#### 协作性：四种机制

| 机制 | 形态 | 依赖 |
|------|------|------|
| **交接** | 主助手接单 → 背景包 → 专家会话接续（v1 用显式按钮「交给灵栖开发」） | §8 |
| **投递** | 专家产出回流渠道/通知；`send_message` 空闲唤醒 | §7.5 |
| **共享层** | 用户偏好记忆（全员读取，现成）+ Wiki（维护官策展、全员检索） | 现成 |
| **互喂** | 开发产出 → 当天记事日报素材；情报高价值条目 → 确认后入 Wiki 变长期知识；维护整理 → 全员检索受益 | 视实现 |

可见性：团队页（AgentsPage）展示每位状态/开关/活动，可随时进入其会话直接对话。

#### 一天的样子

```
08:30      记事：早间简报（读昨天日报 → 今天最该动手的 2-3 件事）→ 系统通知
10:00      情报：概览页资讯卡刷新（每 2h，按偏好过滤）
14:00      你在微信发「把订单页分页修一下」→ 开发在绑定项目里改，进度回执
18:00      记事：日报（今天完成 / 进行中 / 明天优先）→ 自动沉淀 Wiki
周五 17:00 记事：周复盘（本周产出 / 卡点 / 关键判断 / 下周计划）
周日 20:00 维护：工作区整理 + 资料库与记忆巡检（有事才通知）
随时       维护「把设置改了」「更新用户指南」；情报「以后少推论文」
```

#### 克制：谁不在队里

| 候选 | 处置 | 理由 |
|------|------|------|
| 研究官 | 不设常驻 | 一次性调研无长期上下文，用主助手 + `spawn_agent` 临时子 Agent |
| 创作官 | 降级为技能包 | 与主助手重叠，差异只在「多轮产出成品文件」，不需要独立身份 |
| 日程官 | 不设 | 提醒 / 日程用 cron 工具即可，无独立记忆面 |

规则：新增常驻必须过五判据（§1.3）+ 价值论证（会腐化 / 有痛点、失败有兜底、产出可验收）；**合并展示 ≠ 合并 Agent**——早间简报可与资讯合并成一条推送，但仍是两位，各自的记忆不混。

#### 落地顺序（风险递增）

1. **开发 + 维护**：见 §9 阶段 1（本轮已设计）；
2. **记事**：把已有 4 条任务的 `agent_id` 从 assistant 切到 `chronicler`——文案口径不变、只换执行者，最低风险迁移，同时正好验证归属修正（A1）与 `evolution:<id>` 会话（A3）；
3. **情报**：`news-pipeline` 迁移 + 对话式调教（订阅域 / 时段 / 去重偏好入其记忆）。

共同地基只有三件：**A1 归属修正 → A2 tick 遍历参数化 → A3 会话守卫泛化**。做完这三件，四位才是真正「独立」的一等公民。

---

## 3. 使用场景走查

> 2026-09-13 重写：主线是「客户端 / 渠道 + 代码开发工具 → 绑定项目的代码开发」，逐步走查；运维场景重定位后见 §3.3。

### 3.1 场景 A：桌面客户端 · 绑定项目的开发会话（核心）

**用户故事**：开一个开发会话，明确它「改哪个项目、用哪个工具」，然后就用对话把改动做完——全程看得到 CLI 在做什么，可以连续追问，最后回来 review。

| 步骤 | 用户动作 | 期望体验 | 现状 | 缺口 → 设计应答 |
|------|---------|---------|------|----------------|
| 1 | 设置里注册项目（打开已有目录，junction 挂载） | 一次注册，长期可用；多个项目并存 | ✅ 已有（CodingDevAcpPanel） | — |
| 2 | 新建开发会话：选「灵栖开发」Agent（带默认项目+工具），或任意会话发 `/project lumii`、`/claude` | 会话获得**开发上下文**，头部显示「项目 · 工具」chip | 只能全局切工具；项目只能改全局活动项目，无会话概念 | §5.2 开发上下文、§5.8 chip |
| 3 | 发需求：「订单列表分页有个 off-by-one，修一下」 | 消息直达 CLI，工作目录 = 项目路径 | 可用（cwd 走全局） | §5.4 per-run cwd |
| 4 | 看执行 | 「🔧 Read」「🔧 Edit」流式工具卡片 | ✅ 已有（ACP 事件渲染） | — |
| 5 | 追问：「再补一个回归测试」 | 带上一轮上下文 | ❌ 全新进程，无上下文 | §5.5 多轮续接（P1） |
| 6 | 完成 | 「本次改动 2 个文件」；改了主进程则提示重启 | ❌ | §5.9（P3） |
| 7 | 换项目继续 / 退出开发模式 | 会话级切换，不污染其他会话 | ❌ | §5.2 / §5.8 |

**一句话验收**：注册项目 A/B，开两个会话分别工作，目录互不串；第二个会话的第二轮追问能记住第一轮。

### 3.2 场景 B：微信渠道 · 随时随地开发（同一套开发上下文）

**用户故事**：在外面用微信发一句话，让 Lumii 改绑定项目里的东西；回来在桌面看 diff、继续迭代。

微信对话示例：

```
我    ：/project          → 📁 已注册项目：lumii、kids-mobile、blog
我    ：/project lumii    → ✅ 本会话开发项目：lumii（E:\my-project\open-source\lumii）
我    ：/claude           → ✅ 编码后端：Claude Code
我    ：订单页分页有个 off-by-one，修一下
Lumii ：✅ 已收到，正在处理…
        🔧 执行中：Read
        🔧 执行中：Edit          （工具名去重；长时间无输出发「💭 思考中…」，3s 节流）
        已修复 Pager 的页码边界并补了用例，改动 2 个文件。
我    ：把默认分页大小从 10 改成 20     （第二条带上下文，CLI 记得刚改的是 Pager）
```

| 步骤 | 现状 | 缺口 → 设计应答 |
|------|------|----------------|
| `/project` 列表 / 切换 | ❌ 无此命令（只有全局活动项目） | §5.2 新增（仿 per-peer 后端选择存储） |
| `/claude` 切工具 | ✅ 已有（peer 级） | — |
| 发需求 → CLI 执行 | ✅ 已有（微信直调路径） | 需接 cwd（当前取全局活动项目） |
| 进度回执 | ✅ 已有（ACK + 工具名 + 思考节流，`weixin-channel-adapter.ts:514-596`） | — |
| 追问带上下文 | ❌ 断 | §5.5（与桌面同一套续接存储，按 sessionKey 分键） |
| 回桌面 review | ✅ 同一项目目录，git diff | — |

**边界**：微信直调路径无事件回显、无落库（`weixin-channel-adapter.ts:540`）——v1 接受（微信侧只回执文本）；若要「微信开发会话在桌面可回看」，升级为 `startRun` 路径（P2）。

### 3.3 场景 C：系统运维 Agent · 资产维护与代操客户端

**用户故事**：Wiki、记忆、用户指南是长期资产，会腐化；客户端设置琐碎，不想自己找 UI——交给运维 Agent。

| 子场景 | 触发 | Agent 做什么 | 工具（现状） |
|--------|------|-------------|-------------|
| C1 记忆精炼 | 定期（自主）/「整理下我的记忆」 | 读 user-memory 全文 + 场景记忆 → 去重、过期清理、结构修复、控制注入预算 → 直接写回（.bak 备份）+ 摘要 | `profile_memory`（**可写**）、`scene_memory`（已落地）、`memory_manage` |
| C2 Wiki 策展 | 「整理资料库」/ 定期 | 扫描重复页（已有 `duplicate_content` 检测）、空页/孤儿页、主题错位 → 出「合并/归位/归档」建议 → 确认后执行 | `wiki_overview/search/read`（只读）+ 写入经 lumii-ui 命令总线 |
| C3 用户指南同步 | 功能变更后 / 定期 | 对照最近变更更新 `docs/guide/*.md` → 跑 `pnpm sync:guides` 重新生成 → 报告改动点 | `file_read/edit` + `bash` |
| C4 客户端自动化 | 按需（「帮我把 X 设置好」「截个图」） | 改设置（lumii-ui `settings set`）、开关工具（`tools:toggle`）、界面导航与截图 | `app_goto/act/fill_form/screenshot`、`bash`+lumii-ui |
| C5 设置一致性巡检 | 自主（低频） | 「开了自主但没配渠道」「选了 CLI 后端但未安装」类矛盾 → 报告（不改） | 读设置 + CLI 探测 |

**明确不做**：cron 任务巡检——任务数量少、失败已有系统通知、腐化面小（用户 2026-09-13 判断，认同）。cron 仍是 Agent 的**工具**（自己排期用），不是维护对象。

### 3.4 场景 D：会话接续（理想态，暂不实现）

用户在普通会话提到写代码 → 主 Agent 生成背景包 → 切到开发会话接续；返回时反向。设计见 §8，本次不实现。

---

## 4. 代码事实核查

> 以下基于仓库当前代码（2026-09-12 工作区）与**本轮真实 CLI 实测**，每条注明来源。

### 4.1 ACP 链路现状与实测

**链路口径**

- 路由：`user-commands.ts:197-218`，条件 `getBackendWithFallback(LOCAL_USER_ID, sessionKey) !== 'lumii'`（默认后端 `coding-dev-backends-stub/contracts.ts:6`）。用户消息先落库广播（`:129-162`）；ACP 分支不 await、不受 `SessionManager` 锁约束（`:205-217`）。
- 输出：流式走 `agent-runtime:event` 通道（`agent:turn:start` / `message:start|delta|end` / `thinking:delta` / `tool:start|progress|end` / `idle` / `abort` / `error`，`coding-dev-acp-run.ts:112-240,408`）；渲染进程已在消费（`event-handler.ts` delta `:635`、tool:start `:889`、tool:end `:987` 等），工具卡片已渲染（`ChatMessage/index.tsx:343-370`）。完成后主进程 `saveMessage` 落库（`acp-run.ts:163-165,450-466`）。
- startRun 调用点：桌面 `user-commands.ts:205`、飞书 `feishu-channel-adapter.ts:413`、微信直调 `weixin-channel-adapter.ts:540`（另一条路）。**均未传 cwd**（选项不存在）。
- 退出清理缺口：`before-quit`（`index.ts:1608-1653`）只 `destroyAll()`；`AcpRunController.dispose()`（`acp-run.ts:271-284`）**全仓库从未被调用**；子进程 kill 只挂在 abortSignal（`local-runner.ts:136-145`）。

**参数现状**（`buildLocalCliArgs`，`coding-dev-local-runner.ts:44-71`）

| 后端 | 当前 args | 问题 |
|------|----------|------|
| claude | `-p <prompt> --output-format stream-json --verbose` | 无 resume、无偏好注入 |
| codex | `exec --skip-git-repo-check --json <prompt>` | 无沙箱参数（默认拒绝写，见下）、无 resume |
| cursor | `-p <prompt> --output-format stream-json --trust` | `--trust` 不在 cursor-agent 帮助中，疑似无效；无 resume |
| opencode | `run <prompt>` | **无 `--format json`** → 拿到的是格式化文本（含 ANSI 与插件噪音），解析器空转；无 session 续接 |

**多轮连续性：现状=完全断开**

全链路无 CLI 会话 id 捕获：claude/cursor 的 `system init` 事件里带真实 `session_id`，但解析器直接忽略（`coding-dev-jsonl-parsers.ts:44-47,160-162`）；`AcpRunStartOptions`/`LocalAcpRunParams`/`AcpRunHandle` 均无 sessionId 字段（`coding-dev-acp-run.ts:28-56`）。**同一条 Lumii 会话的第二条消息，CLI 没有任何上下文。**

**实测结果（本机，2026-09-12；claude.exe / codex npm shim / cursor-agent.cmd / opencode npm）**

| 项 | claude | codex | opencode | cursor-agent |
|----|--------|-------|----------|--------------|
| 非交互可运行 | ✅ | ✅ | ✅ | 待测 |
| 默认能否写文件 | ✅（本机；受 `~/.claude` 配置影响，跨机器不保证） | ❌ **沙箱拒绝**（`Set-Content` UnauthorizedAccess，exit 1），模型却回复「完成」→ **静默假成功** | ✅ | 待测 |
| 可用权限参数 | `--permission-mode acceptEdits/bypassPermissions`、`--dangerously-skip-permissions`、`--add-dir` | `-s workspace-write` / `--full-auto` / `--dangerously-bypass-approvals-and-sandbox` | 配置/flag（待测） | `-f/--force`、`--auto-review`、`--sandbox` |
| 会话续接 | `-p --resume <id>` ✅ **实测通过**（复述上一轮内容，cache 命中，成本约为新跑 1/9） | `codex exec resume <id> [prompt]`（prompt 用 `-` 走 stdin；`--last`） | `-c/--continue`、`-s/--session <id>` | `--resume [chatId]`、`--continue` |
| 多行 argv | ✅（.exe） | 待测（shim） | 待测 | 风险高（`.cmd` shim，会截断到第一行） |
| stdin 传 prompt | ✅ 实测可用 | ✅（prompt 传 `-`） | 待测 | 待测 |
| 单次新跑输入 token | ≈26k（系统提示+全局 CLAUDE.md+工具定义） | ≈144k（本次实测） | — | — |

> 实测命令与输出摘要见附录 A.5。**claude 默认可写恰好说明「默认行为不可依赖」**——它受用户本机 `~/.claude` 配置影响；设计取「显式传参」策略（§5.7）。

### 4.2 Agent 定义与工具

- 内置 Agent 4 个：`assistant`、`builtin:explore`、`builtin:plan`、`builtin:verify`（`definitions.ts:61-150`）。`builtin:*` 不进选择器，仅被 spawn/router 使用。
- **独立版无 api-server**：`agents-repo.ts:1-9` 明言「无后端、无 api-server。系统 Agent 来自内置定义（离线镜像），用户自建存 `~/.lumii/config/agents.json`」。`definitions.ts:7-16` 的「权威在 api-server」注释属于完整版语境（回流时需双向同步）。
- 定义解析顺序（`definition-store.ts:84-117`）：内存 → SQLite → API → 内置兜底。
- 聊天选择器只列用户 Agent（`useAgents.ts:69-70,128-142`；`ComposerPlusMenu.tsx:472-481`「系统默认」）。`conversation:create` 写 participant（`conversation-commands.ts:101-104`）。`AgentRecord.isEnabled` 存在但**不 gate 任何行为**（`agents-repo.ts:25,50`，渲染层未消费）。
- **工具注册表**（`bridge-tool-registrar.ts:48-83`）：
  - 文件命令：`bash` `file_read` `file_write` `file_edit` `file_mkdir` `file_move` `file_copy` `list_dir` `glob` `grep`
  - web：`web_fetch` `web_search` `bing_search`
  - 记忆：`memory_search` `memory_read` `memory_manage` `profile_memory` `scene_memory`
  - wiki（只读）：`wiki_overview` `wiki_search` `wiki_read`
  - cron：`cron_create` `cron_list` `cron_delete` `cron_guide`（无 update）
  - 技能：`skill_list` `skill_search` `skill_invoke` `execute_skill`
  - 协作/通知：`spawn_agent` `send_message` `message`（仅回当前活跃微信会话，`bridge-tool-registrar-integration.ts:110-158`）`ask_user_question` `todo_write` `channel_send`
  - 其他：`browser_*`、`app_*`、`screen_*`、`dashboard_feed_write` 等
  - **没有任何工具读写 `~/.lumii/config/app.json`**（仅 ConfigManager 与设置页 IPC）。
- **per-agent 工具白名单机制已存在**：`filterToolsByDefinition`（`host-kit/tool-assembly.ts:39-60`）按定义 `tools` 白名单 / `disallowedTools` / `readOnly` 裁剪——system-keeper 的「不许 bash/写文件」可以是**硬防线**，不只靠提示词。
- 代码能力：`bash` 无 PTY、无沙箱、cwd 由调用方注入、120s 超时（`local-bash.ts:45-168`）；`file_write`/`file_edit` 存在且无目录限制。
- 技能机制：`bundled-skills/<分类>/<技能>/SKILL.md` 启动 seed 到 workspace，Agent 经 `skill_list/skill_search/skill_invoke` **按需加载全文**（`skill-tools.ts:52,97,152`）；定义字段 `skills`/`bundledSkills`（`prompt-assembly.ts:71-118`）。**长文档适合放技能，不适合放定义提示词**（后者每轮全量注入）。
- wiki 写入没有 Agent 工具（仅 bash + lumii-ui 路径可达）。

### 4.3 自主引擎与 UI

- `EVOLUTION_AGENT_ID = 'assistant'` 硬编码（`evolution-tick.ts:25`）；`handleEvolutionTick` 无 agentId，`collectTickSignals` 唯一调用点 `:77`。
- bridge 硬编码 `'assistant'`：cron 注入 `saveMessage`（`:1117-1123`）与 `addMemory`（`:1131-1138`）——**多 Agent 产出会污染 L1 满意度与能力画像**；evolution 落库一组（`:1218,1229,1251,1257,1343,1365-1367,1383-1393`）。
- `EVOLUTION_CONVERSATION_ID = 'evolution:main'`（`autonomous/config.ts:151`）。
- cron 执行路径：`runLocalCronJob`（`cron-scheduler.ts:889`）在 `agent_id` 有值时 `driveAgent(job,row,agent_id)`（`:966`，会话 `cron:<jobId>` `:847`），**但产出落库仍标 assistant**；空值走 companion/默认 assistant（`:943,968-973`）。
- 汇报通道现成：`sendOutreach`（`bridge.ts:1277-1341`）system → `showCronNotification`；feishu/weixin → ChannelOutboundRouter；cron 侧 `dispatchNotifications`（`cron-scheduler.ts:676-783`）同构。注意 `notify_user` 是历史死名，实际工具是 `message`（仅活跃微信会话）。
- **无 per-agent 自主开关**：唯一开关是全局 `runtime_state` 键 `autonomous.enabled`（`autonomous-wiring.ts:59-68`），UI 在设置页「实验性功能」（`ExperimentalSection/index.tsx:8,15-16`）。
- AgentsPage：三视图（MapView/GridView/FeedView）；`DetailPanel` 有 lifecycle snapshot（实例数/运行中/轮次/token/子 Agent，2s 轮询，`:61-79,133-184`）；系统 Agent 仅「基于此创建」（`:99-101`），用户 Agent 有发起对话/编辑/删除（`:104-112`）。
- ChatPage：选择器只列用户 Agent；**聊天界面没有任何位置显示「这条会话用哪个 Agent/哪个后端」**。
- `selectPromptVariantForSession` 不区分 agentId（`autonomous-wiring.ts:152-162`、`bridge-instance-factory.ts:751`）——多 Agent 下提示词进化仍只作用于 assistant。
- `evolution:main` 可见性：ChatSidebar 系统 tab 固定项「进入自主进化」（`ChatSidebar/index.tsx:397-404`）；删除守卫为**精确比较**（`conversation-commands.ts:293-296`）；`hasActiveUserTurn` 排除 evolution:main（`bridge.ts:1206-1211`）；ChatPage 自动恢复排除（`ChatPage.tsx:267-268`）。
- 持久化设施：`RuntimeStateRepo`（`bridge.ts:672`，KV）可用于存 CLI 会话 id。

### 4.4 须修正的认知

| 旧认知 | 修正 |
|--------|------|
| 预置 Agent 要等 api-server 排期 | 独立版无 api-server，本地 `definitions.ts` 即事实权威（`agents-repo.ts:1-9`）。回流完整版时再同步 |
| `booled-skills/代码开发/coding-agent` 可用 | 仍是 MtBot 遗留（假设 PTY 与 process 工具族），不使用 |
| `notify_user` 可用 | 历史死名；实际是 `message`（仅活跃微信会话）与 `sendOutreach`（系统/渠道通知）两条路 |
| cursor `--trust` 参数有效 | 不在 cursor-agent 帮助列表中，疑似无效，改 `-f/--force`（P0 实测） |
| opencode 默认输出可解析 | 实测是格式化文本；需 `--format json` |
| codex `--skip-git-repo-check` 就够了 | 不够：默认沙箱拒绝写文件且**静默假成功**，必须显式沙箱/审批参数 |
| Agent 的 `isEnabled` 能停用 Agent | 不 gate 任何行为，仅展示字段 |

### 4.5 渠道链路、客户端自动化与资产维护面（2026-09-13 补）

**渠道开发链路（微信/飞书）**

- 微信回执链：ACK「✅ 已收到，正在处理…」→ 工具 start 去重后「🔧 执行中：{tool}」、thinking 节流 3000ms「💭 思考中…」→ 完成发原文或「✅ ACP 任务完成（无文本输出）」；失败/超时「❌ ACP 执行超时/已取消（已等待 N 分钟）」（`weixin-channel-adapter.ts:514-596`）。
- 微信命令集（`:626-648`）：`/clear /new /resume /help /compact /stop /backend /lumii /claude /codex /opencode /cursor /link /unlink`——**没有 /project**。
- 后端选择：peer 级 + 同步 user-global（`channel/slash-commands/switch-backend.ts:17-47`）；存储 `coding-dev-backends/backend-selection.json`，键 `{accountId}:{peerId}`（`backend-selection.ts:44-55,90-126`）——**per-session 项目选择可照抄这套结构**。
- 项目：只有全局 `codingDevActiveProject`（`coding-dev-projects.ts:36-43`），**无 per-peer/per-session 选择**；渠道 ACP 调用点（微信 `:540`、飞书 `feishu-channel-adapter.ts:413`）均未传 cwd，实际取活动项目环境变量（`coding-dev-env.ts:36-50`）。`params.cwd` 已存在并透传 spawn（`run-coding-dev-acp-prompt.ts:33-39`、`coding-dev-local-runner.ts:25,117`）——**per-run 注入点是现成的**。
- 注意：`run-coding-dev-acp-prompt.ts:33-39` 的 env 回落链缺 `MTBOT_OPENCODE_ACP_CWD`（env 侧有写入），接线时一并补。
- 桌面 `/claude` 等斜杠命令当前写 **user-global**（`index.ts:831-835`）；`CodingDevAcpPanel` 只做 CLI 检测/安装与项目管理，**无后端切换 UI**。

**客户端自动化工具面（供 §6 使用）**

- `app_*`（`bridge-app-ui-tools.ts`）：`app_goto`（打开视图）、`app_act`（click/type/select/key/scroll，真改 UI，needsPermission）、`app_fill_form`、`app_screenshot`、`app_scroll_to_text/bottom`、`app_goto_and_screenshot`、`app_settings_model_config_save`（`controller.ts:1291-1343`：导航→滚动→点「保存全部」→截图校验 toast）。总开关 `privacy.allowAgentAppUiControl`（`app-ui-control/enabled.ts:6-17`），单轮配额 27-114。
- `settings_think`（会话思考级别）、`settings_backend`（写 backend-selection.json）、`info_status`（会话统计）、`dashboard_feed_write`（写 feed 库）、`work_report_read`（读 cron 摘要）。
- 设置通用读写：`lumii-ui settings get/set <key.path>`（`resources/app-ui-cli/commands.mjs:118-154`）→ 本机 HTTP + Bearer（`app-ui-control/server.ts`）→ 改渲染层设置；命令总线白名单含 `tools:toggle`、`session:preferredModel:set`、`codingDev:setBackend`、`autonomous:settings:update`、`cron:*`、wiki 写（`command-allowlist.ts:12-78`）。
- `browser_*`（10 个）操控本机 Chrome/Edge（CDP）；`screen_*`（11 个）录屏/截图。

**资产维护面（供 §6 使用）**

- Wiki：3 个只读工具；写入路径 = 命令总线/lumii-ui（`app-ui-cli/commands.mjs:434-534`）与 IPC `agent-runtime-ipc.ts:967-1083`（folderImport/organizeRun/createNote/rename/updateTopic/archive…）；自动整理轮询每 30s（`bridge.ts:2608-2638`）；去重仅出建议（`wiki-cleanup.ts:46-69`，content_hash）；矛盾检测与 DKR **未实现**；ERO 图谱已实现（`packages/agent-runtime/src/wiki/wiki-ero.ts`）。
- 记忆：`profile_memory` **可写** user-memory.md（read/update/append/remove_section，写前 .bak，`bridge-tool-registrar-integration.ts:310-368`）；`memory_manage` 管 `agent_memories`；`scene_memory` 已落地（项目 `<项目>/.lumii/memory.md`、渠道 `~/.lumii/data/scene-memory/`，注入 `bridge-prompt-composer.ts:480-520`）。
- 用户指南：源 `docs/guide/`（2 篇 md + 20 张截图）→ `pnpm sync:guides`（`apps/windows/scripts/sync-user-guides.mjs`）生成 `resources/user-guides/`（随包分发，开发时 `run-dev.cjs` 自动同步）；应用内经 `app:guides:list/read` 展示（WikiHelpDrawer）；manifest 预留 `seedToWiki`（未来作为 Wiki 种子）。

---

## 5. code-dev 设计

### 5.1 定位与不做

**定位**：在**绑定的项目**中完成可验证的代码改动；对话型 Agent，运行面 = ACP 直达；入口 = 桌面客户端与消息渠道（微信/飞书），共用同一套开发上下文。

**不做双层 Agent**（三条理由保留，并补充一条实证）：

1. 流式体验会降级——ACP 事件管线已做到原生流式，工具化会把输出降级成「工具结果卡片」；
2. Token 与延迟翻倍——CLI 输出回外层上下文再转述，长任务还会撑爆外层；
3. 「专用 Agent」的真实诉求是身份与配置，不是第二层循环；
4. **新增实证**：单次 CLI 新跑输入 ≈26k tokens（claude）——双层只会放大这个成本。

**v1 不做 code-dev 自主**：自主改代码的风险与「无人审阅」的矛盾无解；且其自主场景（依赖过期/TODO 积累）本质是 system-keeper 出建议 + 用户主动触发的事。回补条件：出现真实需求且 §7.6 失败可见性已就位。

### 5.2 开发上下文：项目 + 工具（本轮重构）

一个开发会话需要两样东西：**改哪个项目**（workspace）与**用哪个工具**（backend）。三级来源，就近优先：

| 层级 | 载体 | 作用范围 |
|------|------|---------|
| 1. 会话显式 | `/project <名>`（新增）、`/claude` `/codex` …（已有，改为会话级） | 该会话（桌面=会话 id；渠道=peer sessionKey） |
| 2. Agent 默认 | `AgentDevBinding`（本机配置） | 选了该 Agent 的桌面会话 |
| 3. 全局默认 | 设置面板：活动项目（已有）+ 默认编码后端（新增小下拉） | 全部 |

**存储**：新增 per-session 开发上下文（仿 `backend-selection.json` 的键结构，新增 `dev-context.json`）；键 = sessionKey（渠道 `{accountId}:{peerId}`，桌面会话 id）。解析：会话值 > Agent binding > 全局。

**AgentDevBinding**（本机 `app.json`，保留原设计）：

```ts
/** 开发类 Agent 的本机绑定（apps/windows/src/main/config/types.ts） */
export interface AgentDevBinding {
  agentId: string                                   // 对应 AgentDefinition.id
  backendId: 'claude' | 'codex' | 'cursor' | 'opencode'
  workspace?: string                                // 缺省回退全局活动项目（§5.4）
  enabled: boolean
  permissionMode?: string                           // 可选覆盖（§5.7）
}
// AppConfig 增：codingDevAgentBindings?: AgentDevBinding[]
```

归属本机的原因（保留原判断）：`workspace` 是本机绝对路径、`backendId` 取决于本机装了什么 CLI——都不该跨设备同步。解析函数 `resolveAgentDevBinding(appConfig, agentId)` 置于 `coding-dev-env.ts`。Agent 删除后 binding 成为孤儿，读取时忽略，不级联清理。

**行为变更说明**：桌面 `/claude` 等今天是 user-global（`index.ts:831-835`），本设计改为**会话级**（符合「这个对话用什么工具」的直觉）；全局默认改由设置面板的小下拉承担。渠道保持现状（peer 级 + 同步 user-global）。

**渠道命令**：新增 `/project`（不带参列出已注册项目，带参切换），微信与飞书同时注册；支持 `/project off` 清除会话值回落全局。

### 5.3 路由与优先级

```
用户消息 user:send (user-commands.ts:197)
  1. 会话显式开发上下文存在？（dev-context.json 按 sessionKey 命中；含显式选 'lumii'，用于退出开发模式）
       是 → backend + project 都用会话值
  2. 会话绑定的 Agent 有 dev binding？
       是 → 用 binding.backendId + binding.workspace
  3. user-global 显式选择存在？（旧机制，保留兼容）
       是 → 用它；project 取全局活动项目
  4. 默认 → lumii（主 Agent 路径，行为完全不变）
```

优先级原则一句话：**会话显式 > Agent 配置 > 全局默认**。桌面与渠道走同一段解析（渠道没有 Agent binding 层，即 1/3/4）。

配套：`/lumii` 斜杠命令应写**显式** 'lumii' 而非清除选择，否则无法在开发会话里退出开发模式。binding 指向的 CLI 未安装时，`runLocalAcpCli` 的报错经 `startRun` catch 转为聊天消息（`acp-run.ts:219-238`），**明确报错、不静默降级**。

### 5.4 per-run 工作目录

`AcpRunStartOptions` 增 `cwd?: string` 并透传 `runCodingDevAcpPrompt`（`acp-run.ts:130-138` 当前未传；`run-coding-dev-acp-prompt.ts:33-39` 已是「显式 cwd → 环境变量 → process.cwd()」链）。最终优先级：

```
会话显式项目 → binding.workspace → codingDevActiveProject → codingDevAcpWorkspace → workspaceDirectory → <dataDir>/workspace
```

**渠道接线**：微信直调（`weixin-channel-adapter.ts:540`）与飞书 `startRun`（`feishu-channel-adapter.ts:413`）都要传 cwd = 开发上下文解析结果；顺带补 `run-coding-dev-acp-prompt.ts:33-39` 缺失的 `MTBOT_OPENCODE_ACP_CWD` 回落。

### 5.5 多轮续接（P1，新）

**目标**：同一会话第二条消息携带第一条的上下文，且尽量便宜（resume 命中缓存）。

| 环节 | 设计 | 落点 |
|------|------|------|
| 捕获 | 解析器提取 `system init` 的 `session_id`（claude/cursor）；codex/opencode 用其 JSON 事件的会话标识（P0 确认字段名） | `coding-dev-jsonl-parsers.ts:44-47,160-162` 改为捕获 |
| 传递 | `AcpRunStartOptions` / `LocalAcpRunParams` / `AcpRunHandle` 增 `cliSessionId?` | `coding-dev-acp-run.ts:28-56` |
| 拼参 | claude：`--resume <id>`（实测通）；codex：`exec resume <id> ...`（子命令形态）；opencode：`run --session <id>`；cursor：`--resume <chatId>` | `buildLocalCliArgs` |
| 持久化 | `runtime_state` 键 `acp-session:{backendId}:{sessionKey}` → `{ sessionId, updatedAt }`（`RuntimeStateRepo`，`bridge.ts:672`） | 新增小模块 |
| 失效降级 | resume 报错 → 去掉 resume 重跑一次，并在会话里提示「CLI 上下文已重置」；只重试一次 | 同上 |
| 清理 | 会话删除/清空时同步删除键；换后端时键已按 backendId 隔离 | 同上 |

**验收**：两轮手工测试——第一轮「记住数字 42」，第二轮「我刚才让你记住什么」得到 42；断言日志中出现 resume 参数。**渠道验收**：微信两轮同样验证（同一套存储，按 sessionKey 分键）。

### 5.6 提示词与用户偏好注入

分两级，逐级降级：

| 方式 | 实现 | 覆盖 |
|------|------|------|
| CLI 原生 flag | `--append-system-prompt`（claude 实测支持）：注入（a）仓库运行守则（改完跑 `pnpm typecheck` 与相关测试；主进程改动需重启生效）（b）用户偏好摘要（回复语言、风格禁忌——读 `user-memory.md` 截取，**不做全量注入**） | claude |
| 仓库文档 | AGENTS.md / CLAUDE.md 由 CLI 自身读取（claude 已验证按 cwd 读取；codex/opencode/cursor 待实测） | 其余后端 |
| prompt 前缀 | 兜底；需在回显剥离逻辑（`stripUserEcho`，`acp-run.ts:66`）中处理 | 全部 |

Lumii 仓库的 `AGENTS.md` 已是现成的「仓库手册」——这正是 code-dev 的领域知识地基；system-keeper 对应物见 §6.2。

### 5.7 权限策略

取「显式传参」策略（不依赖各 CLI 的本机默认，见 §4.1 实测）：

| 后端 | 建议参数 | 说明 |
|------|---------|------|
| claude | `--permission-mode acceptEdits`（默认）；binding 可覆盖为 `bypassPermissions` | acceptEdits 下文件编辑自动通过；命令类工具可能被拒 → P0 实测后决定默认档 |
| codex | `-s workspace-write`（或 `--full-auto`） | **不加则静默假成功**，必须加 |
| opencode | 先观察（默认已可写），P0 决定 | — |
| cursor | `-f/--force`（替换疑似无效的 `--trust`） | P0 实测 |

**高风险点（保留）**：workspace 配错会误改其他项目。P3 校验：workspace 存在且是 git 仓库，否则启动前二次确认。Lumii 侧的权限闸门不覆盖 ACP 路径（CLI 有自己的权限系统），v1 不引入外层确认。

### 5.8 模式可见性与出口（新）

- **会话头部运行面 chip**：「Claude Code · E:\my-project\open-source\lumii」，绑定会话首次进入时可见；
- **出口**：点击 chip → 「退出开发模式」（对该会话写显式 `lumii` 选择，压制 binding，见 §5.3）；
- 未绑定的普通会话不显示任何东西（零打扰）。

### 5.9 变更摘要与生效提示（P3）

run 成功结束后 `git status --porcelain`（在 workspace 执行）→ 消息尾部附「本次改动 N 个文件（列表前 5）」；若 workspace 是本仓库且改动包含 `apps/windows/src/main/**` → 追加「主进程改动需重启应用生效」。可选一键重启（`app.relaunch()`）。

### 5.10 预置定义落地

**方案 A（推荐）**：`definitions.ts` 增 system 定义（本阶段 `code-dev`「灵栖开发」+ `system-keeper`「灵栖维护」；§9-D 再加 `info-curator` / `chronicler`，见 §2.5）；`AgentDefinition` 增可选 `selectable?: boolean`，`useAgents.ts:128-142` 放行「selectable 的系统 Agent」进选择器；AgentsPage 照常展示。改动小，随版本更新。

**方案 B（备选）**：首启 seed 两条到 `agents.json`（用户 Agent 形态）。缺点：不随版本更新、用户可误删。

另需注意：`AgentsPage` 对系统 Agent 目前只有「基于此创建」（`DetailPanel.tsx:99-101`），方案 A 下需补「发起对话」入口（用户 Agent 已有，`DetailPanel.tsx:104-112`）。

### 5.11 稳定性（P1 一并做）

- `performCleanup`（`index.ts:1553-1604`）接上 `AcpRunController.dispose()`（`acp-run.ts:271-284`），退出时终止运行中 CLI 子进程；
- ACP run 无持久化（内存 Map，`acp-run.ts:75`）——v1 接受；重启后进程被杀，会话上不会留下误导性的「运行中」状态（ACP 助手消息是跑完才落库），但需确认 UI 无悬挂 streaming 指示。

---

## 6. system-keeper 设计

> 2026-09-13 重定位：不做「定时任务巡检」这类稳定功能的日常维护（任务少、失败已有系统通知、腐化面小）；聚焦**知识、记忆、用户指南、客户端自动化**四类真正会腐化、且直接影响体验的资产。

### 6.1 定位

**Lumii 的资产维护者与客户端代办**：维护 Wiki、记忆、用户指南三类知识资产，并能代表用户操作客户端。运行面 = `pi`（完全体：有记忆、有会话、有自主时间）。

**为什么是这四件事**（价值论证）：

| 资产 | 为什么会腐化 | 维护收益 |
|------|-------------|---------|
| 记忆 | user-memory 每次对话都注入（2400 字符预算）；场景记忆（项目/渠道）随使用堆积 | 直接决定所有对话的上下文质量 |
| Wiki | 长期资料库，重复/错位/过期页只增不减；自动整理只做分类，去重仅出建议 | 检索命中率与知识可信度 |
| 用户指南 | 产品迭代快（如本轮客户端切片重构），指南文案极易漂移 | 用户自助入口；也是 Agent 回答「怎么用」的知识源 |
| 客户端操作 | 设置项分散在多层面板；用户不想自己找 UI | 「帮我把 X 设好」一句话完成 |

### 6.2 知识地基：运维手册技能

它要「了解系统」，就不能靠提示词即兴发挥。做法：`bundled-skills/系统维护/SKILL.md`（按需 `skill_invoke` 加载，不占常驻上下文，机制见 §4.2），内容：

- 资产地图：Wiki 表与整理流程（`wiki-organizer`/`wiki-cleanup`）、记忆三层（user-memory / agent_memories / scene-memory）、用户指南管线（`docs/guide` → `pnpm sync:guides`）
- 操作手册：lumii-ui `settings get/set`、`tools:toggle`、命令总线白名单、`app_*` 工具用法与配额（§4.5）
- 边界与红线：哪些必须用户确认（Wiki 合并/删除、设置变更）、备份机制（user-memory 写入自带 .bak）
- 常见故障模式与报告格式模板

定义提示词里只放角色与边界，细节全部放手册。同理，code-dev 的「手册」就是仓库里的 `AGENTS.md`（§5.6）——**两个 Agent 用同一模式：一份权威、可版本化的领域手册**。

### 6.3 v1 闭环任务（四件，均可验收）

| # | 任务 | 做什么（具体动作） | 产出 |
|---|------|------------------|------|
| 1 | **记忆精炼**（首选，工具全现成） | 读 `profile_memory` 全文 + 场景记忆文件 → 检测：截断线外的重要信息、重复/矛盾条目、过期项、章节结构 → 直接写回（.bak 备份）+ 场景记忆瘦身 | 修改摘要（增删改了什么）+ 新字数 |
| 2 | **Wiki 策展** | `wiki_overview` 扫描重复页（`duplicate_content` 检测已有）/空页/孤儿页/主题错位 → 生成「合并、归位、归档」建议清单 → 用户确认后经 lumii-ui 执行 | 建议清单（+ 确认后的执行记录） |
| 3 | **用户指南同步** | 对照最近功能变更（git log / 对话上下文）→ 更新 `docs/guide/*.md` 对应章节 → 运行 `pnpm sync:guides` → 校验 manifest | 指南 diff 摘要 |
| 4 | **客户端自动化** | 改设置（lumii-ui `settings set`）、开关工具（`tools:toggle`）、界面导航与截图说明（`app_goto/app_screenshot`） | 操作结果 + 必要的截图 |

**动作边界**：

- 任务 1（记忆）：自主可做（写路径自带备份、影响可审阅）；首次启用建议在交互会话里观察一轮。
- 任务 2/3/4 涉及内容删除、文件改写、设置变更：**执行前确认**（用户在场）；自主运行只出建议。
- 任务 4 的前置：`privacy.allowAgentAppUiControl` 已开启。设置类操作的原则从「只建议不改」调整为「**用户在场可改、自主只建议**」——用户明确使唤时不必绕弯。

**明确不做（v1）**：cron 任务巡检、文件系统扫荡、渠道出站维护、Wiki 自动合并（去重结论仍走确认）。

### 6.4 工具白名单与「交互 / 自主」两档策略

按定义 `tools` 白名单裁剪（`filterToolsByDefinition`，`host-kit/tool-assembly.ts:39-60`），复用 goal-executor 的受限实例模式（`bridge.ts:987,1238`）：

| 档位 | 何时 | 工具面 |
|------|------|--------|
| **交互档**（用户在会话里） | 用户使唤 | 维护工具 + `bash`（lumii-ui 设置读写、跑 `sync:guides`）+ `file_read/edit/write`（docs/guide）+ `app_*`（界面操作，受 `privacy.allowAgentAppUiControl` 与单轮配额约束）+ `cron_*`、`skill_*`、`memory_*`、`profile_memory` |
| **自主档**（无人在场） | 周度资产巡检 | 读类 + `profile_memory`（记忆写入）+ `memory_manage` + `skill_*` + `todo_write`；**无 bash / file_write / app_***；需要这类动作时生成「待确认」清单，报告落自主会话（高优先级由引擎经系统通知送达，§6.5） |
| **始终不给** | — | `channel_send`、`browser_*`、`screen_*`、应用设置直写（结构性保证：全系统没有 Agent 工具能写 app.json，§4.2；设置改动只能走交互档的 lumii-ui 或 `app_settings_model_config_save`） |

档位切换复用现有「受限实例」机制（同 goal-executor），不新增框架。

### 6.5 产出送达（新）

| 通道 | 机制 | 用途 |
|------|------|------|
| 自主会话 | `evolution:system-keeper`，ChatSidebar 系统 tab 可进入 | 全部细节，可回看、可追问 |
| 系统通知 | `sendOutreach`（`bridge.ts:1277-1341`）system 通道 / cron `notify_targets` | 只推高优先级摘要（有事才打扰） |

这条链同时是「自主 Agent 产出可达用户」的最小实现——EVO 实验缺陷 #6（高价值产出不可见）的正面修复。

### 6.6 自主开关与调度

- 开关：per-agent，存 `app.json` `autonomousAgents: string[]`（沿用旧文备选方案，独立版下即最终方案）；UI 入口见 §7.4；
- 调度：纳入 §7.2 的单 tick 遍历；它自己也可以建 cron（`cron_create` 已在工具面）。
- 默认建议：开启后首周每天一次资产巡检（以记忆为主），稳定后改为每周（由它自建 cron）。

### 6.7 与 memory-wiki 规划的关系

`system-keeper` **调用并补齐** memory-wiki 的机制：去重检测（`wiki-cleanup` 已有，出建议）由它转成行动；矛盾检测与 DKR **未实现**（§4.5）——落地前它用交互档做人工式策展兜底，不重复实现机制本身。

---

## 7. 运行时贯通改造（多 Agent 基础设施）

> 数据层早已多 Agent 化（`agent_memories.agent_id`、`autonomous_*` 全带 `agent_id`、`local_cron_jobs.agent_id`、`collectTickSignals(db, agentId, now)`），缺的全部在编排层。

### 7.1 cron 产出归属修正（必修，前置）

`bridge.ts:1117-1123`（`saveMessage`）与 `:1131-1138`（`addMemory`）在 cron 注入路径硬编码 `agentId:'assistant'` → 改为取 `job.agent_id`（空值回落 assistant）。**理由**：满意度是 Prompt 进化与人格 EMA 的输入，错误输入会真实改变模型输入（`autonomous-effectiveness-report.md` 有同类教训）。同时检查历史数据是否已污染。

### 7.2 参数化 + 单 tick 遍历

```
现状：  tick → EVOLUTION_AGENT_ID ('assistant'，evolution-tick.ts:25)
目标：  tick → for agentId in [assistant, ...autonomousAgents]:
                  signals = collectTickSignals(db, agentId, now)
                  action  = decideAction(signals, agentId, ...)
```

选择单 tick 遍历而非 per-agent tick job：`collectTickSignals` 是纯 DB 查询，遍历成本极低。心跳仍是保活看门狗，不是主调度器（既定原则）。

### 7.3 `evolution:<agentId>` 会话 + 守卫泛化

每开启自主的 Agent 拥有 `evolution:<agentId>` 会话（L1 保持 `evolution:main` 兼容存量）。**必须同步泛化的四处的当前实现都是「精确匹配 evolution:main」**：

| 位置 | 现状 | 改为 |
|------|------|------|
| 删除守卫 `conversation-commands.ts:293-296` | 精确比较 | 前缀 `evolution:` |
| `hasActiveUserTurn` 排除 `bridge.ts:1206-1211` | 精确 + `cron:%` | 前缀 `evolution:%` |
| ChatPage 自动恢复排除 `ChatPage.tsx:267-268` | 精确 | 前缀 |
| ChatSidebar 入口 `ChatSidebar/index.tsx:397-404` | 单个固定项 | 按自主 Agent 列表渲染 |

漏改任何一处 = 自主会话可被误删 / 会被当成「有用户回合」而卡死心跳（后者有 EVO 实验的两次稳定复现背书）。

### 7.4 自主开关（per-agent）

- 存储：`app.json` `autonomousAgents: string[]`；
- UI：AgentsPage DetailPanel 增「自主能力」开关（复用现有 lifecycle 区），开启时提示将占用的资源（LLM 调用）；全局实验性开关保留；
- 遍历处读取（§7.2）；未开启的 Agent 行为与今天完全一致。

### 7.5 `send_message` 空闲唤醒（最小版）

`orchestrator.ts:575-638` 的 `followUp` 仅在 prompt 循环内被消费 → 空闲 Agent 收不到消息。补约 3 行：空闲时走 `deliverSubagentCompletion` 的 idle 分支唤醒。信箱（持久化队列）仍不做，升级触发条件保留（出现「进程重启丢消息致任务链断裂」的真实场景时再谈）。

### 7.6 失败可见性（新）

自主 run 失败 / CLI 卡死 / cron 任务失败：**必须在自主会话留下记录并（高优先级时）通知**。最小实现：执行失败的 catch 里落一条消息到 `evolution:<agentId>`，复用 `sendOutreach` 的 system 通道。卡死的无进展检测（旧文 §3.6 设计）保留为 P2：先有「失败可见」，再谈「卡死判定」。

---

## 8. 会话接续（设计不实现）

保留 v2 设计：L1 生成**背景包**（LLM 总结，非机械截取）→ 切到目标 Agent 会话 → 注入开场上下文 → 返回时反向摘要。背景包结构（可立即用于 `spawn_agent` prompt 模板）：

```
{ originUserRequest(必填), confirmedNeed, constraints, artifacts, doneDefinition(必填) }
```

实现时优先做**显式按钮**版本（消息上「交给灵栖开发」），不做意图自动识别——触发可靠性与用户控制都更好。先决条件：阶段 1 跑一段时间后，确认「确实频繁在 Agent 间切换」。

---

## 9. 实施路线

> 详细代码实施计划（A/B/C/D 四片，含逐项改动点、测试与验收）见 [`docs/plans/专项Agent/`](../../plans/专项Agent/README.md)。

### 阶段 0：实测（大部分已完成）

已完成：claude 非交互/resume/默认权限/多行/stdin；codex 默认沙箱行为/resume 形态；opencode 默认行为/输出格式问题。见 §4.1 与附录 A.5。

待补：cursor-agent（`-f` 是否有效、`.cmd` 多行截断）；codex/opencode JSONL 会话标识字段名；codex/opencode 多行 argv；`profile_memory` 写能力；`/lumii` 当前是否写显式选择。

### 阶段 1：功能完好 + 基本体验

**A. 运行时贯通（system-keeper 的前置）**

| # | 改动 | 位置 |
|---|------|------|
| A1 | cron 产出归属修正 | `bridge.ts:1117/1131` |
| A2 | `EVOLUTION_AGENT_ID` 参数化 + 单 tick 遍历 | `evolution-tick.ts` |
| A3 | `evolution:<agentId>` 会话 + 四处守卫泛化（§7.3） | 四处 |
| A4 | 自主开关（`app.json` + 遍历读取）+ DetailPanel 开关 UI | config + AgentsPage |
| A5 | 失败可见性（最小版） | evolution 执行 catch |

**B. code-dev 闭环（客户端 + 渠道）**

| # | 改动 | 位置 |
|---|------|------|
| B1 | 两条预置定义（`code-dev`/`system-keeper`）+ `selectable` 标记 + 选择器放行 + 系统 Agent「发起对话」入口 | `definitions.ts`、`useAgents.ts`、`DetailPanel.tsx` |
| B2 | **开发上下文存储**（`dev-context.json`，per-sessionKey）+ 解析链（§5.2） | 新模块 + `coding-dev-env.ts` |
| B3 | **`/project` 命令**（桌面 + 微信 + 飞书）+ `/claude` 等改会话级 + 设置面板加「默认编码后端」 | 斜杠命令三处 + `CodingDevAcpPanel` |
| B4 | 路由接入开发上下文（§5.3） | `user-commands.ts:197` |
| B5 | per-run `cwd` 透传 + **渠道接线**（微信/飞书）+ `MTBOT_OPENCODE_ACP_CWD` 缺口 | `acp-run.ts`、两个 adapter、prompt 回落链 |
| B6 | **多轮续接**（捕获→持久化→resume→降级），桌面与渠道共用 | 解析器/runner/`runtime_state` |
| B7 | 模式可见性 chip（项目 · 工具）+ 退出 | ChatPage 头部 |
| B8 | 权限显式参数（§5.7 表） | `buildLocalCliArgs` |
| B9 | 退出清理接线 `dispose()` | `index.ts` + `acp-run.ts` |
| B10 | 绑定配置 UI（`CodingDevAcpPanel` 增「Agent 绑定」区） | SettingsPage |

**C. system-keeper 闭环（资产维护 + 代操客户端）**

| # | 改动 |
|---|------|
| C1 | `system-keeper` 定义（两档工具白名单 + 角色提示词，§6.4） |
| C2 | 运维手册技能 `bundled-skills/系统维护/SKILL.md`（§6.2） |
| C3 | 记忆精炼闭环：手动跑通 → 自主档验证（.bak + 摘要） |
| C4 | Wiki 策展建议闭环 → 确认后经 lumii-ui 执行 |
| C5 | 用户指南同步闭环（改 `docs/guide` → `pnpm sync:guides` → 校验） |
| C6 | 客户端自动化：改设置 / 开关工具 / 导航截图；一致性巡检（报告） |
| C7 | 报告送达：高优先级 → 系统通知（§6.5） |

**D. 团队转正（§2.5 蓝图第 2/3 步；依赖 A 的三件地基）**

| # | 改动 |
|---|------|
| D1 | `chronicler` 定义（工具面 + 沿用现有日报/周报/简报文案，`selectable`） |
| D2 | 4 条预置任务 `agent_id` 切到 `chronicler`（`seed-cron-jobs.ts` 加迁移函数，口径逐字不变） |
| D3 | `info-curator` 定义 + `news-pipeline` 迁移 + 对话式调教（订阅域/时段/去重偏好入其记忆） |
| D4 | 两位的 `evolution:<id>` 会话与团队页可见性（复用 A3/A4） |

**验收**

- [ ] code-dev：两轮关联任务，第二轮带上第一轮上下文（§5.5 验收）
- [ ] 两个项目 A/B，两个会话分别绑定，目录互不串（§3.1 一句话验收）
- [ ] 渠道：微信 `/project` 列表正确、切换后消息在目标目录执行；微信两轮带上下文
- [ ] code-dev：codex 后端在显式沙箱参数下真实写文件（不再假成功）
- [ ] system-keeper：记忆精炼跑通（.bak 备份 + 摘要报告）；Wiki 策展建议命中构造的重复页；指南同步产出 diff
- [ ] 客户端自动化：经 lumii-ui 修改一个设置并复验生效；`app_*` 截图可用
- [ ] 记事：日报/周复盘口径与迁移前一致，产出 `agent_id='chronicler'`；早间简报能读到前一天日报
- [ ] 情报：`news-pipeline` 由 `info-curator` 执行，概览页资讯卡正常；「以后少推 X」在下一轮产出中生效
- [ ] cron 产出的 `agent_id` 与 job 一致（查库）
- [ ] 自主会话可对话、不可删（四处守卫验证）
- [ ] 回归：`run-autonomous-life-e2e.mjs`（23 用例）+ `run-autonomous-full-e2e.mjs`（11 用例）全绿；既有测试基线（39 个已知失败）不新增
- [ ] 绑定会话的普通消息零回归（未绑定路径行为不变）

### 阶段 2：体验打磨 + 稳定

- 变更摘要 + 重启提示（§5.9）；一键重启
- 提示词注入扩展到 codex/opencode/cursor（各自机制实测后）
- 卡死检测（无进展）——若实际使用中 1h 硬超时确实不够
- 权限外层确认 + workspace git 校验（§5.7）
- system-keeper 松弛：安全类动作可自动执行（在确认历史可信后）
- 会话接续（显式按钮版）——依使用数据决定

### 明确不做

| 项 | 理由 |
|----|------|
| 双层 Agent 循环 | §5.1 |
| code-dev 自主 | §5.1 |
| per-agent 预算与配额 | 当前不重要；等真有两个自主 Agent 抢预算时再说 |
| `agent_messages` 新表 / 信箱 | 当前场景不存在；升级触发条件见旧记录（进程重启丢消息 / 审计视图需求） |
| L1/L2/L3 分级 | 过度概念化；一个布尔开关足够 |
| 三重防环 / 技能硬约束 | 当前没有多 Agent 循环的真实风险 |

---

## 10. 风险

| 风险 | 等级 | 说明 | 缓解 |
|------|------|------|------|
| codex 静默假成功 | **高** | 默认沙箱拒绝写文件，模型仍报完成——用户以为改好了 | B7 显式沙箱参数；工具失败事件在流里可见（已验证流里有 status failed） |
| 绑定 workspace 配错误改他仓 | **高** | 自改代码场景破坏面大 | P3 git 校验 + 二次确认；binding 默认跟随全局活动项目 |
| 多轮续接失败/膨胀 | 中 | resume 报错需降级；长会话 token 增长 | 降级重跑一次 + 提示；claude resume 自带上下文管理，成本低于新跑（实测 1/9） |
| cursor `.cmd` 多行截断 | 中 | `--trust` 疑似无效且 shim 截断 argv | 改 `-f/--force`；必要时转 stdin（机制待测） |
| opencode 输出非结构化 | 中 | 当前解析器拿不到事件 | 加 `--format json` 并过滤插件噪音 |
| ACP 子进程退出泄漏 | 中 | `dispose()` 从未被调用 | B8 |
| 自主会话守卫漏改 | 中 | 误删/心跳卡死（有复现背书） | §7.3 四处清单化改造 |
| cron 归属污染已存在 | 中 | 历史数据可能已污染 | A1 优先修；评估历史数据 |
| 自主开关被滥用 | 低 | 每个新 Agent 都开 | 显式开启 + 资源提示 |
| 自主整理误伤资产 | 中 | 记忆/Wiki 是长期资产，错误的自动整理会扩散到所有对话 | 记忆写入自带 .bak + 摘要可审；Wiki/指南动作需确认；自主档无 bash/file |
| 会话级 `/claude` 行为变更 | 低 | 桌面从 user-global 改会话级，用户可能预期全局 | 设置面板保留全局默认；chip 明示当前工具 |
| 团队转正后任务口径漂移 | 低 | 迁移只换执行者，但新 Agent 的提示词/记忆可能改变输出风格 | 迁移期文案逐字沿用 + 对比迁移前后各一轮产出 |

---

## 11. 待实测 / 待确认

1. cursor-agent：`-f/--force` 行为；`.cmd` 多行 argv；stdin 支持；其 stream-json 的 session id 字段。
2. codex/opencode：JSONL 流中的会话标识字段名（用于续接）；codex `exec resume` 与 `--json` 组合输出；opencode `--format json` 的事件形态。
3. claude 在 `--permission-mode acceptEdits` 下 Bash 工具（如 `pnpm typecheck`）是否被拒——决定默认档。
4. `profile_memory` 是否有写入能力（记忆体检的「应用建议」依赖它）。
5. `/lumii` 当前行为（写显式 'lumii' 还是清除选择）——影响 §5.3 的出口实现。
6. 渠道会话是否存在 Agent participant 绑定语义（决定 binding 是否可能误命中渠道路径）。
7. 长会话 resume 的成本曲线（建议在使用中抽样记录）。
8. `/project` 与 `/backend` 的 UX：是否合并为一个「开发上下文」命令；桌面 `/claude` 会话级化的确认。
9. Wiki 写入：v1 走 bash + lumii-ui，还是补一等工具（自主档策展需要）——前者零新代码，后者利于受限档。
10. 用户指南同步是否纳入 Agent 常规职责，还是保留为用户手动跑 `pnpm sync:guides`。
11. `app_settings_model_config_save` 的 toast 校验在 UI 变更后是否稳定（失败分支返回 warning）。

---

## 附录 A：CLI 接入工程细节

### A.1 各后端 args 现状 vs 建议

| 后端 | 现状 | 建议（阶段 1） |
|------|------|---------------|
| claude | `-p <prompt> --output-format stream-json --verbose` | `+ --resume <id>`、`+ --permission-mode <mode>`、`+ --append-system-prompt <摘要>`；多行 prompt 已实测安全（.exe） |
| codex | `exec --skip-git-repo-check --json <prompt>` | `+ -s workspace-write`；续接改子命令形态 `exec resume <id> ...`；长 prompt 可用 `-`走 stdin |
| cursor | `-p <prompt> --output-format stream-json --trust` | `--trust` → `-f`；`+ --resume <chatId>`；考虑 `--stream-partial-output`；多行风险最高，优先 stdin 或单行约束 |
| opencode | `run <prompt>` | `+ --format json`、续接 `--session <id>` 或 `--continue` |

### A.2 JSONL 解析扩展点

- `coding-dev-jsonl-parsers.ts:44-47,160-162`：`system init` 当前被忽略 → 改为捕获 `session_id`（claude/cursor）；
- codex：`item.*` 事件形态已解析（现有实现），续接标识待定位；
- opencode：现有解析器假定 JSON 行；当前 args 未产 JSON → 修 args 后回归验证；
- 事件映射保持现状（`agent:tool:start|progress|end` 等），渲染层零改动。

### A.3 事件 → 渲染链路（现状，无需改动）

`emitProgress`（`acp-run.ts:112-240,408`）→ IPC `agent-runtime:event`（`agent-runtime-ipc.ts:722-735`）→ renderer `bridge-init.ts:197-208` → `event-handler.ts`（`message:delta :635`、`tool:start :889`、`tool:end :987`、`turn:start :1052`）→ `ChatMessage/index.tsx:343-370` 工具卡片。

### A.4 退出清理缺口

现状：`before-quit`（`index.ts:1608-1653`）→ `performCleanup`（`:1553-1604`）不碰 ACP；`dispose()`（`acp-run.ts:271-284`）零调用。阶段 1 接线：`performCleanup` 调 `dispose()` 终止全部子进程。ACP 消息是跑完才落库，被杀的 run 不会留半截消息。

### A.5 本轮实测记录（2026-09-12）

| 命令（要点） | 结果 |
|-------------|------|
| `claude -p --output-format json "回复：你好"` | 成功；返回 `session_id`；耗时 2.7s；成本 $0.13（input 26k tokens） |
| `claude -p --resume <id> --output-format json "我上一条让你回复什么"` | 正确复述「你好」；cache_read 25.8k；成本 $0.015 |
| `claude -p "创建文件 write-probe.txt..."`（默认权限） | `num_turns:2`、`permission_denials:[]`、文件真实创建（`test -f` 验证） |
| `printf "<prompt>" \| claude -p --output-format text` | 成功（stdin 可用） |
| `codex exec --skip-git-repo-check --json "创建文件..."` | 命令 `status:failed`（UnauthorizedAccess / 沙箱），模型仍回复「CX-OK」→ **假成功**；input 144k tokens |
| `opencode run "创建文件..."` | 文件创建成功；输出为格式化文本 + 插件迁移噪音（需 `--format json`） |
| `cursor-agent --help` | 确认 `--resume/--continue/-f/--force/--output-format/--stream-partial-output/--auto-review/--sandbox`；**无 `--trust`** |
| `codex exec resume --help` | `resume [SESSION_ID] [PROMPT]`，prompt 传 `-` 读 stdin，`--last` 续最近 |

## 附录 B：与现有机制的关系

| 现有机制 | 本设计的关系 |
|---------|-------------|
| 手动后端切换（`/claude` 等 + 全局选择） | **保留**，作为显式覆盖；binding 是其上的「Agent 级固化配置」（§5.3 优先级） |
| 项目管理（`codingDevProjects`） | **保留**，作为全局 cwd 来源；binding.workspace 是 per-agent 覆盖 |
| 主 Agent 路径（`lumii` 后端） | **不受影响**，未绑定会话行为完全不变 |
| 工具系统 / 权限闸门 / 提示词进化 | pi 型 Agent 全量适用；ACP 路径不经过（§2.4 已列明） |
| 自主进化引擎（`docs/design/自主进化Agent/`） | 阶段 1 改动保证其既有行为不变（回归用例见 §9） |
| memory-wiki 规划 | system-keeper 调用其机制，不重复实现（§6.7） |
| 跨渠道接续（`weixin-session-binding.ts`） | §8 会话接续的机制同构 |
| Hermes Agent（外部参考） | 无进展检测、维护者受限工具集、信箱升级条件等已吸收 |
