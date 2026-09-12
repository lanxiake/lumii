# 一等公民 Agent 团队 E2E（场景化） 测试报告

- **生成时间**: 2026-09-12T19:18:09.644Z（开始 2026-09-12T19:13:56.548Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\Administrator\.lumii\data\agent-runtime.db
- **场景范围**: 全量场景
- **环境**: 真实 LLM；claude 场景启用；AT_TICK=1
- **应用日志**: C:\Users\Administrator\.lumii\logs\app\mtbot-2026-09-13.log

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 14 |
| 通过 | 14 |
| 失败 | 0 |
| 跳过 | 0 |
| 通过率 | 100.0% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| AT-L1-01 | ✅ | commands=77，命令面完整 | 0.1s |
| AT-L2-01 | ✅ | 四位 Agent 定义均可见（code-dev/system-keeper/chronicler/info-curator） | 0.1s |
| AT-L2-02 | ✅ | 5 条转正落地（4→chronicler、news→info-curator）；新闻 prompt 升级标记=含「先读用户偏好」 | 0.0s |
| AT-L2-03 | ✅ | session 级 claude→lumii 往返、敲错项目名被拒 | 3.3s |
| AT-S1 | ✅ | participant=code-dev；回复 209 字（11s）：「当前工作目录（E:\testsoft\Lumii-data）下的前 5 个项目： 1. `.git…」 | 12.5s |
| AT-S2 | ✅ | 体检回复 786 字；记忆原有内容零改动 | 17.6s |
| AT-S3 | ✅ | 偏好写入 agent_memories（1 条），探针已清理 | 12.5s |
| AT-S4 | ✅ | 日报由 chronicler 产出（302 字）：「三处核查完毕（工作记忆 0 条、日报存档、记忆宫殿检索），均无今天（09-12）…」 | 11.0s |
| AT-S6 | ✅ | participant=default；回复「收到」（与 Agent 团队上线前行为一致） | 12.7s |
| AT-S5 | ✅ | 两轮续接成功：首轮报 v22.13.1，追问复述一致；无降级标记 | 43.2s |
| AT-UI-01 | ✅ | 真实点击「info-curator」开关：开启→app.json 落盘；再点→还原初始 | 3.9s |
| AT-UI-02 | ✅ | 主助手组头 + 灵栖开发/灵栖维护/灵栖情报 组头均在；无展开按钮（滚动分页） | 2.0s |
| AT-UI-03 | ✅ | 渲染层实时收到事件；UI 无需重启可见回复 | 18.0s |
| AT-L2-04 | ✅ | 汇总覆盖 assistant + chronicler：assistant=idle; chronicler=idle | 0.2s |

## 失败与跳过明细

无。

## 副作用声明

- 探针会话（`[agent-team] *`）保留待人工清理（CLI 无删除能力）。
- dev-context.json 已快照恢复（套件开始前已有内容，结束后原样写回）。
- user-memory.md / agent_memories：S2/S3 探针行已按行/按 id 清理；内存基线比对用「原有行全集保留」。
- 后台 cron 任务套件期间临时禁用，结束已恢复（19 条）。
- AT-S4 为真实任务运行：local_cron_runs 新增记录 + notify_targets 系统通知为验证证据本身。
- AT-L2-04 tick 用例已启用（真实写 evolution 会话与自主状态）。

## 覆盖限制（未覆盖项）

- 删除守卫（evolution:<id> 不可删）：`conversation:delete` 不在控制口白名单，CLI 不可达；由 A3 人工验收覆盖。
- Agent 绑定层（codingDevAgentBindings）与 B10 配置 UI：CLI 无写出口；人工验收。
- system-keeper 自主档工具面：agent-runtime 包单测覆盖，无 CLI 出口。
- 渠道侧（微信/飞书 /project）：需真实渠道账号，手工验收。


## 证据

逐条原始证据见 [agent-team-evidence.jsonl](./agent-team-evidence.jsonl)。
