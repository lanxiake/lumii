# 自主进化 Agent CLI 测试报告

**生成时间**: 2026-09-04T06:50:06.896Z
**数据库**: `C:\Users\75791\.lumii\data\agent-runtime.db`

## 测试摘要

| 指标 | 数值 |
|------|------|
| 总测试数 | 26 |
| 通过 | 17 |
| 失败 | 5 |
| 成功率 | 65.4% |

## 测试结果分组

### TC1: 数据库 Schema 验证
- ✓ TC1.1: autonomous_satisfaction_scores 表存在
- ✓ TC1.2: autonomous_goals 表存在
- ✓ TC1.3: prompt_variants 表存在
- ✓ TC1.4: personality_state 表存在
- ✓ TC1.5: personality_events 表存在
- ✓ TC1.6: evolution_coordination_history 表存在
- ✓ TC1.7: prompt_evolution_history 表存在

### TC2: 满意度评分
- ✓ TC2.1: 插入满意度评分
- ✗ TC2.2: 验证满意度权重计算

### TC3: 目标生成
- ✗ TC3.1: 生成学习型目标
- ✗ TC3.2: 生成主动消息目标

### TC4: 每日目标上限
- ○ TC4.1: 今日已有 0 个目标
- ✓ TC4.1: 统计今日目标数

### TC5: Prompt 变体管理
- ✓ TC5.1: 插入基线 Prompt
- ✓ TC5.2: 插入变体 v1
- ✓ TC5.3: 插入变体 v2
- ✓ TC5.4: 查询所有变体

### TC6: 人格状态管理
- ✓ TC6.1: 初始化中性人格
- ✓ TC6.2: EMA 更新人格（goal-generated）
- ✗ TC6.3: 人格边界限制

### TC7: 协调器指标统计
- ○ TC7.1: 总评估次数: 1
- ✓ TC7.1: 统计总评估次数
- ○ TC7.2: 目标分布: []
- ✗ TC7.2: 按类型统计目标
- ○ TC7.3: 平均满意度: 0.695
- ✓ TC7.3: 计算平均满意度

## 失败详情

### TC2.2: 验证满意度权重计算

**错误**: `权重计算公式: expected 0.695, got 0.6749999999999999 (diff: 0.020000000000000018)`



### TC3.1: 生成学习型目标

**错误**: `NOT NULL constraint failed: autonomous_goals.trigger_reason`



### TC3.2: 生成主动消息目标

**错误**: `NOT NULL constraint failed: autonomous_goals.trigger_reason`



### TC6.3: 人格边界限制

**错误**: `CHECK constraint failed: openness BETWEEN 0 AND 1`



### TC7.2: 按类型统计目标

**错误**: `应有目标记录`




## 测试环境

- Node.js: v24.19.0
- 平台: win32
- 架构: x64
- 数据库: C:\Users\75791\.lumii\data\agent-runtime.db
- 详细模式: 否
- 数据清理: 是

## 证据文件

原始测试证据保存在: `C:\myself\projects\my\open-source\lumii\docs\test\lumii-cli\autonomous-cli-evidence.jsonl`

每行为一个 JSON 对象，包含完整的测试执行信息。

## 下一步

❌ 有测试失败，请检查失败详情并修复问题。
