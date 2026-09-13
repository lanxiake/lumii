# 一等公民 Agent 团队 E2E（场景化） 测试报告

- **生成时间**: 2026-09-13T13:05:21.937Z（开始 2026-09-13T13:03:22.258Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\Administrator\.lumii\data\agent-runtime.db
- **场景范围**: AT_ONLY=L2-04
- **环境**: 真实 LLM；claude 场景启用；AT_TICK=1
- **应用日志**: C:\Users\Administrator\.lumii\logs\app\mtbot-2026-09-13.log

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 16 |
| 通过 | 4 |
| 失败 | 1 |
| 跳过 | 11 |
| 通过率 | 25.0% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| AT-L1-01 | ✅ | commands=77，命令面完整 | 0.1s |
| AT-L2-01 | ✅ | 四位 Agent 定义均可见（code-dev/system-keeper/chronicler/info-curator） | 0.2s |
| AT-L2-02 | ✅ | 5 条转正落地（4→chronicler、news→info-curator）；新闻 prompt 升级标记=含「先读用户偏好」 | 0.0s |
| AT-L2-03 | ✅ | session 级 claude→lumii 往返、敲错项目名被拒 | 3.1s |
| AT-S1 | ⏭️ | 未选中（AT_ONLY） | 0.0s |
| AT-S2 | ⏭️ | 未选中（AT_ONLY） | - |
| AT-S3 | ⏭️ | 未选中（AT_ONLY） | - |
| AT-S4 | ⏭️ | 未选中（AT_ONLY） | - |
| AT-S6 | ⏭️ | 未选中（AT_ONLY） | - |
| AT-S5 | ⏭️ | 未选中（AT_ONLY） | - |
| AT-S7 | ⏭️ | 未选中（AT_ONLY） | - |
| AT-F2 | ⏭️ | 未选中（AT_ONLY） | - |
| AT-UI-01 | ⏭️ | 未选中（AT_ONLY） | 0.0s |
| AT-UI-02 | ⏭️ | 未选中（AT_ONLY） | - |
| AT-UI-03 | ⏭️ | 未选中（AT_ONLY） | - |
| AT-L2-04 | ❌ | summary 缺少「assistant=」：already-running | 0.2s |

## 失败与跳过明细

- **AT-S1** SKIP: 未选中（AT_ONLY）
- **AT-S2** SKIP: 未选中（AT_ONLY）
- **AT-S3** SKIP: 未选中（AT_ONLY）
- **AT-S4** SKIP: 未选中（AT_ONLY）
- **AT-S6** SKIP: 未选中（AT_ONLY）
- **AT-S5** SKIP: 未选中（AT_ONLY）
- **AT-S7** SKIP: 未选中（AT_ONLY）
- **AT-F2** SKIP: 未选中（AT_ONLY）
- **AT-UI-01** SKIP: 未选中（AT_ONLY）
- **AT-UI-02** SKIP: 未选中（AT_ONLY）
- **AT-UI-03** SKIP: 未选中（AT_ONLY）
- **AT-L2-04** FAIL: summary 缺少「assistant=」：already-running
  ```
  Error: summary 缺少「assistant=」：already-running
    at Module.assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at caseL2Tick (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/agent-team/run-agent-team-e2e.mjs:926:7)
    at Module.runCase (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:518:18)
    at file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/agent-team/run-agent-team-e2e.mjs:1029:11
    
  ```

## 副作用声明

- 探针会话（`[agent-team] *`）保留待人工清理（CLI 无删除能力）。
- dev-context.json 已快照恢复（套件开始前已有内容，结束后原样写回）。
- user-memory.md / agent_memories：S2/S3 探针行已按行/按 id 清理；内存基线比对用「原有行全集保留」。
- 后台 cron 任务套件期间临时禁用，结束已恢复（10 条）。
- AT-S4 为真实任务运行：local_cron_runs 新增记录 + notify_targets 系统通知为验证证据本身。
- AT-L2-04 tick 用例已启用（真实写 evolution 会话与自主状态）。

## 覆盖限制（未覆盖项）

- 删除守卫（evolution:<id> 不可删）：`conversation:delete` 不在控制口白名单，CLI 不可达；由 A3 人工验收覆盖。
- Agent 绑定层（codingDevAgentBindings）与 B10 配置 UI：CLI 无写出口；人工验收。
- system-keeper 自主档工具面：agent-runtime 包单测覆盖，无 CLI 出口。
- 渠道侧（微信/飞书 /project）：需真实渠道账号，手工验收。


## 证据

逐条原始证据见 [agent-team-evidence.jsonl](./agent-team-evidence.jsonl)。
