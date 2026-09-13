# 一等公民 Agent 团队 E2E（场景化） 测试报告（综合）

- **测试时间**: 2026-09-13 20:15:56 起（首轮全量 16 用例）；20:45–21:45 修复复验与补测（18 用例）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context/cron/settings 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\Administrator\.lumii\data\agent-runtime.db
- **场景范围**: 全量 18 用例（原 16 + 补测 AT-S8/AT-S9）；定点复验 AT-UI-02 / AT-L2-04
- **环境**: 真实 LLM；claude 场景启用；AT_TICK=1（tick 用例）
- **用例文档**: [agent-team-test-cases.md](./agent-team-test-cases.md)（含「设计验收对照」§五之二）
- **应用日志**: C:\Users\Administrator\.lumii\logs\app\mtbot-2026-09-13.log

## 概要

| 阶段 | 结果 |
|---|---|
| 全量首轮（16 用例） | **14 PASS / 2 FAIL**（87.5%）——两失败均已定位根因并处理 |
| 定点复验 | AT-UI-02 用例修正后单跑 **PASS**；AT-L2-04 用例增强（互斥容错）后为受控 SKIP |
| 补测 | AT-S8 **PASS**、AT-S9 **PASS**（一次通过） |
| 结论 | Agent 团队功能符合设计（含本轮新修一处产品缺陷）；AT-L2-04 因环境存在未决云同步冲突暂被互斥跳过，待无冲突窗口重验 |

## 逐条结果

> 状态列中「✅/❌」为首轮全量结果；后随复验标注。

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| AT-L1-01 | ✅ | commands=77，命令面完整 | 0.1s |
| AT-L2-01 | ✅ | 四位 Agent 定义均可见（code-dev/system-keeper/chronicler/info-curator） | 0.2s |
| AT-L2-02 | ✅ | 5 条转正落地（4→chronicler、news→info-curator）；新闻 prompt 升级标记=含「先读用户偏好」 | 0.0s |
| AT-L2-03 | ✅ | session 级 claude→lumii 往返、敲错项目名被拒 | 4.5s |
| AT-S1 | ✅ | participant=code-dev；回复 326 字（35s）：「当前工作目录 `E:\testsoft\Lumii-data\handoff-demo` 下共有 9…」 | 36.3s |
| AT-S2 | ✅ | 体检回复 1104 字；记忆原有内容零改动 | 17.4s |
| AT-S3 | ✅ | 偏好写入 agent_memories（1 条），探针已清理 | 12.1s |
| AT-S4 | ✅ | 日报由 chronicler 产出（281 字）：「今天完成 - 改好日期脚本：输出日期＋中文星期（如 `2026-09-13 星期…」 | 16.1s |
| AT-S6 | ✅ | participant=default；回复「收到」（与 Agent 团队上线前行为一致） | 12.0s |
| AT-S5 | ✅ | 两轮续接成功：首轮报 v22.13.1，追问复述一致；无降级标记 | 43.2s |
| AT-S7 | ✅ | 第 1 次尝试委托成功（spawn_agent → system-keeper, status=done），回复 678 字；user-memory 零改动 | 296.9s |
| AT-S8 | ✅ | （补测）灵栖维护代操成功：theme.mode light → dark（真实设置落盘，测试后已恢复） | 99.0s |
| AT-S9 | ✅ | （补测）资讯由 info-curator 产出（1060 字；feed 166→175） | 119.9s |
| AT-F2 | ✅ | 提案 → CLI 确认（UI 点击链路不可用，soft 降级） → 新开发会话直达 claude（binding）；沙箱 pager.js 已被修复；原会话收到结果汇报 | 137.3s |
| AT-UI-01 | ✅ | 真实点击「info-curator」开关：开启→app.json 落盘；再点→还原初始 | 4.3s |
| AT-UI-02 | ✅ | **首轮 FAIL（用例断言与实现不符）→ 用例修正后单跑 PASS**：「默认」组头 + 开发/情报 组头均在；无展开按钮 | 2.2s |
| AT-UI-03 | ✅ | 渲染层实时收到事件；acp-session 键存在；(soft) 会话未出现在侧栏可视区（3 次重试，可能受并行操作影响），UI 可见性未断言 | 21.0s |
| AT-L2-04 | ⚠️ | **首轮 FAIL（上游工具挂起 → CLI 300s 超时）→ 修复后重跑被云同步冲突处理互斥占用（already-running）→ 用例已增强容错，待无冲突窗口重验** | 330.4s |

## 失败定位与修复

### 1. AT-UI-02 侧栏分组标题（用例缺陷，已修正）

- 用例断言侧栏存在「主助手」分组标题，实际实现为**系统组两字短名**（`ChatSidebar.SIDEBAR_SYSTEM_GROUP_UI`）：主助手组显示为「**默认(N)**」，Agent 组为「开发(N)/维护(N)/记事(N)/情报(N)」。
- 实测截图 refs 证实：「默认(353)」「开发(10)」等。
- 修正：断言改为「默认」组头 + 短名 Agent 组头（≥1），失败信息附实际 refs；用例文档同步更新。单跑复验 **PASS**。

### 2. AT-L2-04 tick 多 Agent 汇总（环境阻塞 → 修复 & 容错）

多层根因（均发生在「用户环境存在未决云同步冲突：`profile/user-memory.md`」这一前提下）：

- **首轮失败**：tick 驱动 assistant 回合调用 `resolve_sync_conflict` 后工具长时间未返回（旧代码 `push` 无超时，当日 19:06 曾运行 46.5 分钟）→ tick 执行超过 CLI 300s 上限被杀、无运行记录。
- **修复后重跑**：tick 正确返回 `already-running`——云同步冲突处理正在进行（`executeSyncConflictGoal` 的 in-flight 互斥），tick 被设计性跳过。
- **用例增强**：`already-running` 时间隔 60s 重试（≤3 次），持续被占用则 SKIP 并注明「环境存在未决云同步冲突，需在无冲突窗口重验」——不再误报 FAIL。
- **旁证**：历史运行记录（本日 11:20、14:44）summary 均为 `assistant=idle; chronicler=idle`，格式与覆盖范围符合用例断言。

## 本轮发现的产品问题

### P1（已由用户修复，685704e）`resolve_sync_conflict` 挂起——push 无超时

云同步 push 无超时时，冲突落决可挂起 46 分钟级（19:06–19:53 实测），且该请求占用控制口全局串行队列，导致期间所有 CLI 调用排队失败（20:40 实测一次 `agent:definitions:list` 等 306s 后 connection_failed）。

### P2（本轮修复）中止冲突处理后互斥泄漏 → tick 恒 `already-running`

- 现象：界面发起 `user:abort` 中止冲突处理回合后，`executeSyncConflictGoal` 的 `prompt/waitForIdle` 悬挂、`finally` 不执行 → `_syncConflictInFlight` 永久为 true → **此后每次 tick 被判 already-running，自主心跳静默停摆**（21:03–21:08 实测连续复现，重启才清除）。
- 修复：`bridge.ts` 对「prompt + waitForInstanceIdle」加 10 分钟超时兜底（`withTimeout`），保证互斥必然释放、目标保留待重试。相关单测回归 77 例绿；typecheck 干净。

### P3（记录，建议后续评估）控制口全局串行队列

`app-ui-control/server.ts` 的 `enqueueCommand` 为全局串行队列：`cron:run` 等长命令在**执行期间阻塞全部控制口请求**；若被执行任务挂起，控制口即整体瘫痪。建议：`cron:run` 异步化（立即返回受理、状态查询轮询）或队列分级（长任务与短命令解耦）。

## 补测（本轮新增覆盖）

- **AT-S8 灵栖维护代操客户端**（C 片闭环 4）：真实对话「把主题切换成深色」→ `theme.mode` light→dark 真实落盘（通过）；测试侧恢复（含验证与重试）。
- **AT-S9 资讯管线归属**（D3 验收）：`cron run news-pipeline` → 运行 ok、产出消息 `agent_id='info-curator'`、正文 1060 字、feed 166→175（资讯卡真实写入）。

## 副作用声明

- 探针会话（`[agent-team] *`）保留待人工清理（CLI 无删除能力）。
- dev-context.json 已快照恢复（套件开始前已有内容，结束后原样写回）。
- user-memory.md / agent_memories：S2/S3/S7 探针行已按行/按 id 清理；内存基线比对用「原有行全集保留」。
- 后台 cron 任务套件期间临时禁用，结束已恢复（每次 9–10 条）。
- AT-S4 / AT-S9 为真实任务运行：local_cron_runs 新增记录 + feed/通知为验证证据本身。
- AT-S8：`theme.mode` 测试后已恢复原值（曾出现一次恢复静默失败并已手动恢复 + 用例已加显式校验重试）。
- AT-F2：沙箱 `E:/testsoft/Lumii-data/handoff-demo` 由用例重置/修改（自包含、可重复）；转交产生的开发会话为真实产出。
- 测试期间用户在同一应用上并行操作（含一次对冲突处理回合的界面中止），部分 UI 断言按 soft 降级处理并已注明。

## 覆盖限制（未覆盖项）

- 删除守卫（`evolution:<id>` 不可删）：`conversation:delete` 不在控制口白名单，CLI 不可达；由 A3 人工验收覆盖。
- Agent 绑定层（`codingDevAgentBindings`）与 B10 配置 UI：CLI 无写出口；人工验收。
- system-keeper 自主档工具面：agent-runtime 包单测覆盖，无 CLI 出口。
- 渠道侧（微信/飞书 `/project`、QQ/微信一键转交）：控制口无入站消息注入口，需真实渠道账号人工验收（QQ 复核见 `docs/plans/专项Agent/05-队长制-主助手接团队.md` F3）。
- 逐项设计验收对照（含未覆盖项清单）见 [agent-team-test-cases.md](./agent-team-test-cases.md) §五之二。

## 证据

- 逐条原始证据见 [agent-team-evidence.jsonl](./agent-team-evidence.jsonl)（最近一次运行；首轮全量证据见本报告逐条表）。
- 首轮全量报告副本备份于会话临时目录 `%TEMP%/claude/agent-team-report-full-2033.md`（未入仓）。
