# 自主进化 CLI 测试报告

**执行时间**: 2026-09-05T10:50:15.088Z
**结果**: 22 PASS / 0 FAIL（共 22）
**数据库**: `C:\Users\Administrator\.lumii\data\agent-runtime.db`
**探针 agent**: `autonomous-test-*`（跑完已清理）

## 明细

| 用例 | 结果 | 说明 |
|---|---|---|
| TC1 | PASS | 正式表结构齐全: 12 张表齐全 |
| TC2 | PASS | help 暴露全部 autonomous 命令: 10 个命令均可被 Agent 发现 |
| TC3 | PASS | status 空数据降级: hasData=false，不抛异常 |
| TC4 | PASS | 满意度四维加权公式一致性: overall=0.6750，与设计公式 0.695 一致，四维无错位 |
| TC5 | PASS | 满意度趋势判定: trend=improving，3 点升序 |
| TC6 | PASS | 时间窗口过滤边界: 7d=3 / 30d=3 / all=4，边界正确 |
| TC7 | PASS | 目标列表与状态过滤: 全部 2 条，pending 1 条，字段映射正确 |
| TC8 | PASS | 非法 status 安全降级: 白名单拦下非法状态值，数据完好 |
| TC9 | PASS | 批准目标状态流转落库: status=approved，approved_at 已写入 |
| TC10 | PASS | 拒绝目标状态流转落库: status=rejected |
| TC11 | PASS | 重复审批被拒绝: 非 pending 目标无法二次流转 |
| TC12 | PASS | 不存在目标优雅失败: 返回 success=false 并说明原因 |
| TC13 | PASS | 缺 goalId 参数校验: 退出码 2 |
| TC14 | PASS | 能力维度查询与字段映射: level/confidence/boundary/testCount 映射正确 |
| TC15 | PASS | 反思记录 JSON 列解析: JSON 列解析为数组，含 rootCause |
| TC16 | PASS | 脏 JSON 列降级不打断列表: 脏 JSON 降级空数组，整表仍可用 |
| TC17 | PASS | Prompt 变体统计与成功率: 成功率=0.8444，基线优先排序 |
| TC18 | PASS | 零试验变体不产生除零: successRate=null，无 NaN 污染 |
| TC19 | PASS | 开关读写闭环持久化: 写入 runtime_state 且可回读 |
| TC20 | PASS | 未配置时默认启用: 缺配置默认 enabled=true |
| TC21 | PASS | agentId 数据隔离: 能力与目标均按 agentId 隔离 |
| TC22 | PASS | 未知 autonomous 子命令报错: 退出码 2 |

## 覆盖范围

- 10 个 autonomous CLI 命令真实调用（经控制口 → IPC → Repo → SQLite）
- 算法一致性：满意度四维加权 0.35/0.30/0.20/0.15，趋势判定，成功率计算
- 落库校验：状态流转与 approved_at 时间戳回查数据库确认
- 异常路径：SQL 注入尝试、不存在目标、重复审批、缺参数、脏 JSON、零试验除零、未知子命令
- 数据隔离：按 agentId 过滤，互不可见

## 说明

探针数据经 SQL 直接播种，读取全部走 CLI 真实链路，因此校验的是
命令分发、白名单、字段映射与查询逻辑，而非自己写自己读的空转。

证据文件: `autonomous-cli-evidence.jsonl`
