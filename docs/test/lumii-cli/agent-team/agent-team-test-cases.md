# 一等公民 Agent 团队 测试用例（AT 套件）

> 对应实现：`docs/plans/专项Agent/`（A 运行时贯通 / B code-dev 闭环 / C system-keeper / D 团队转正）与设计 `docs/design/专项AGENT/专项Agent设计.md` §2.5。
> 规范：`docs/test/lumii-cli/CLI-TEST-SPEC.md`；执行器：`run-agent-team-e2e.mjs`（严格复用 `lib/cli-harness.mjs`）。
> **设计原则：以用户真实使用场景为主轴**——每个 L3 用例模拟「用户带着一个真实任务来找这位团队成员」的完整旅程，而不是逐接口冒烟。
> 探针命名空间：会话前缀 `[agent-team]`；无 SQL 播种。
> 环境开关：`AT_ONLY=S1,S3`（选择性运行）、`AT_SKIP_LLM=1`（只跑 L1/L2）、`AT_SKIP_CLI=1`（跳过 claude 场景）、`AT_TICK=1`（启用 tick 条件用例）、`AT_TURN_TIMEOUT_MS`、`AT_VERBOSE=1`。

## 一、用户旅程地图（为什么是这些用例）

| 真实旅程 | 用户期望 | 用例 |
|---|---|---|
| 🧑💻「我新装了客户端，想试试这几个 Agent 能干什么」——找成员聊天办事 | 选中成员、说人话、它真的动手把事办了 | AT-S1（开发）、AT-S2（维护）、AT-S3（情报） |
| ⏰「每天早上应该自动产出一份工作日报，我能看到」 | 到点（或手动触发）由「灵栖记事」送达，内容真实 | AT-S4 |
| 🛠️「切到 Claude Code 干活，接着追问上一轮的结果」 | 上下文连续，不用重复说明背景；界面实时可见回复 | AT-S5、AT-UI-03 |
| 🖱️「在 AI 团队页给成员打开自主心跳、看侧栏分组」 | 点击即写配置；分组清晰、不撑开其他分组 | AT-UI-01、AT-UI-02 |
| 💬「我只想日常聊天，不要被这些新 Agent 干扰」 | 不选 Agent 时行为与以前完全一致 | AT-S6 |
| 🔧「设置里切后端/敲错项目名」 | 即时应答，错误有明确反馈 | AT-L2-03 |

数据链路层（L1/L2）保留基本面校验：命令面、定义可见、迁移落库、tick 汇总。

## 二、场景用例（L3）

#### AT-S1 场景：找「灵栖开发」看看当前环境
- **故事**: 用户刚开了一个灵栖开发会话，还没绑定项目，先让它看看当前工作目录有什么
- **步骤**: 1) `conversation:create(agentId=code-dev)` 建会话 2) 查 participant 3) 发「请列出你当前工作目录下的文件或文件夹（最多 5 个）」
- **预期**: participant=`code-dev`；它真实使用工具（list_dir 类）给出目录内容
- **断言**: participant=硬；回复非空=硬；回复提及文件/目录=软
- **预计回合**: 1

#### AT-S2 场景：让「灵栖维护」给我做一次记忆体检
- **故事**: 用户想知道自己的用户记忆有没有重复/矛盾，要求只报告不许改
- **步骤**: 1) 建 system-keeper 会话 2) 发「用 profile_memory 读我的用户记忆，检查重复或矛盾，只报告不要修改」3) 回合后比对 user-memory.md
- **预期**: 有检查结论的回复；user-memory.md 原有内容**一行不改**
- **断言**: 原有行全集保留=硬（红线）；回复非空=硬；提取链路若有新增行，记录 note 并清理探针行
- **预计回合**: 1

#### AT-S3 场景：告诉「灵栖情报」我的资讯偏好
- **故事**: 用户说「以后多关注 AI 编程工具动态，少推学术论文」——期待它真的记住（D3 验收场景）
- **步骤**: 1) 建 info-curator 会话 2) 发偏好 3) 轮询偏好落库（agent_memories 新行或 user-memory.md 探针词）
- **预期**: 60s 内偏好进入记忆；测试后清理探针行
- **断言**: 落库=硬（agent_memories 行 or 记忆文件探针词）；确认回复非空=软
- **探针词**: 「编程工具」「论文」（事前核对均不存在于 user-memory.md）
- **预计回合**: 1

#### AT-S4 场景：每天早上的工作日报按时由「灵栖记事」送达
- **故事**: 用户在任务页手动触发一次「工作日报」（模拟到点），检查产出
- **步骤**: 1) `cron run seed-daily-report`（真实执行一轮 chronicler）2) 轮询 local_cron_runs 新行 3) 轮询 cron:seed-daily-report 新消息
- **预期**: 运行 status=ok；会话产出新 assistant 消息且 `agent_id='chronicler'`；正文非空
- **断言**: 运行状态=硬；消息 agent_id=硬（D2 验收项）；正文非空=硬
- **副作用**: 真实 LLM 多轮 + notify_targets 系统通知；运行记录真实落库
- **预计回合**: 1 次任务运行（内部多轮工具调用）

#### AT-S5 场景：切到 Claude Code 干活并追问
- **故事**: 用户在会话里把工具切到 Claude Code，先让它确认 node 版本，随后追问刚才的版本号
- **步骤**: 1) `setBackend(claude, sessionKey)` 2) 第一轮「用 bash 运行 node -v」3) 断言 runtime_state `acp-session:claude:<sk>` 与日志 ACP 路径 4) 第二轮「刚才确认的版本号是多少」
- **预期**: 两轮由 claude CLI 连续处理；resume 生效（无「CLI 上下文已重置」）；第二轮复述同一版本号
- **断言**: 键存在/无重置标记/日志 ACP 标记=硬；版本号复述=软（可重试 1 轮）
- **预计回合**: 2（真实 claude CLI）
- **跳过**: `AT_SKIP_CLI=1`

#### AT-S6 场景：没有选 Agent 的日常聊天不受影响（回归）
- **故事**: 用户不选任何 Agent 直接聊天——行为必须与 Agent 团队上线前一致
- **步骤**: 1) 普通建会话 2) 查 participant 3) 发「只回复两个字：收到」
- **预期**: participant=`default`（非开发后端实例）；正常回复
- **断言**: participant=硬；回复含「收到」=软（可重试 1 轮）
- **预计回合**: 1

## 三、UI 级用例（lumii-ui screenshot refs + click，模拟真实用户点击）

#### AT-UI-01 在 AI 团队页真实点击「参与自主心跳」开关
- **故事**: 用户在 AI 团队页（Grid 视图）为成员操作自主心跳——开关要可见、点了要真的写进配置、再点能还原
- **步骤**: 1) `goto agents` → 切 Grid 2) 点可视区最后一个开关（位置/状态无关设计：用配置 diff 识别翻转的 Agent）3) 断言 app.json `app.autonomousAgents` 恰有一个 id 翻转 4) 再点同一位置 → 断言回到初始
- **预期**: 翻转与还原都能在配置上验证；异常路径 finally 兜底还原
- **断言**: 配置 diff=硬（恰好 1 个 id）；还原=硬
- **副作用**: 操作即真实用户配置，最终与测试前一致

#### AT-UI-02 侧栏按 Agent 分组结构
- **故事**: 用户打开聊天侧栏，默认 tab 应看到「主助手」+ 各 Agent 的可折叠分组，组内滚动分页而非「展开更多」
- **步骤**: 1) `goto chat` 2) 截图 refs 3) 断言存在「主助手」组头、至少一个 Agent 组头、无「展开更多」按钮
- **断言**: 结构=硬（依赖 UI 可达）
- **预计回合**: 0

#### AT-UI-03 ACP 回复在界面实时可见（无需重启）
- **故事**: 用户切换 claude 后端发消息，**不重启**就能在界面看到回复（2026-09-13 修复的回归护栏：ipcMainWindowRef 快照 null 导致事件被静默丢弃）
- **步骤**: 1) 新建会话 + `setBackend(claude)` 2) 发送「只回复 Markdown 三级标题：界面可见」3) 断言日志出现「渲染层收到 `agent:message:start`」（该会话）4) `goto chat` → 点击该会话 → 截图断言回复标题在界面上可见
- **预期**: 事件到达渲染层 + 界面直接可见回复；acp-session 键存在
- **断言**: 日志事件到达=硬；acp 键=硬；UI 可见=硬路径（3 次重试；若会话按钮不在侧栏可视区——如用户同屏滚动/切页——降级为 soft 并在 note 明示，事件到达硬断言仍覆盖修复本体）
- **预计回合**: 1（真实 claude CLI）

## 四、数据链路用例（L1/L2）

#### AT-L1-01 CLI 命令面冒烟
- **步骤**: `help --json`，断言 commands>50 且含 `command`/`conversation create`/`send`
- **断言**: 结构=硬；**预计回合**: 0

#### AT-L2-01 四位 Agent 定义运行时可见
- **步骤**: `command agent:definitions:list` → 断言四个 id + 名称（灵栖开发/维护/记事/情报）
- **断言**: 硬；**预计回合**: 0

#### AT-L2-02 预置任务转正迁移在真实库落地
- **步骤**: 查 `local_cron_jobs`：4 条简报→chronicler、news-pipeline→info-curator；task_text/system_prompt 非空、无魔法指令残留
- **断言**: 落库值=硬；用户删过的行不计失败；**预计回合**: 0

#### AT-L2-03 会话级开发上下文（敲错项目名有明确反馈）
- **故事**: 用户在会话里切后端、设项目；敲错项目名应被明确拒绝而不是静默失败
- **步骤**: 1) 新会话 getDevContext → source=global 2) setBackend(claude)→session 3) setBackend(lumii) 退出 4) setProject(不存在名) 被拒 5) 已注册项目往返（条件）
- **断言**: 全部=硬；**副作用**: dev-context.json 快照恢复；**预计回合**: 0

#### AT-L2-04 心跳 tick 多 Agent 汇总（条件用例）
- **前置**: `AT_TICK=1` 且 app.json `autonomousAgents` 非空
- **步骤**: 手动 `cron run autonomous-tick` → 断言 summary 为 `agentId=结果; …` 且覆盖全员
- **跳过条件**: 未开 AT_TICK / 未配置 → SKIP（人工验收：AgentsPage 打开开关后重跑）；**预计回合**: 1 次 tick

## 五、不覆盖（报告注明）

- 删除守卫（`evolution:<id>` 不可删）：`conversation:delete` 不在控制口白名单，CLI 不可达；由 A3 人工验收覆盖。
- Agent 绑定层（`codingDevAgentBindings`）与 B10 配置 UI：配置入口在设置页，CLI 无写出口；人工验收。
- system-keeper 自主档工具面（无 bash/file_write/app_*）：agent-runtime 包单测覆盖。
- 渠道侧（微信/飞书 `/project`）：需真实渠道账号，手工验收。

## 六、副作用与恢复

- 探针会话 `[agent-team] *` 保留（CLI 无删除能力），报告注明。
- `dev-context.json`：套件开始前快照（含文件不存在情形），结束时原样恢复。
- `user-memory.md` / `agent_memories`：S2/S3 的探针行按行/按 id 清理；比对基线用「原有行全集保留」断言，不整文件恢复。
- 后台 cron：套件期间禁用全部 `enabled=1` 任务（防抢 LLM），结束时恢复；SIGINT/SIGTERM 下尽力恢复。
- DB：除探针行清理外只读；S4 的 cron 运行记录为真实产出（验证证据本身）。
- 真实 LLM：默认全量（S1/S2/S3/S6 各 1 回合 + S4 一次任务运行 + S5 两轮 claude）；`AT_SKIP_LLM=1` 可离线跑 L1/L2。
