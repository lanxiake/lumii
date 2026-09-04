# 自主进化 Agent 实验追踪

## Baseline 参数配置

基于设计文档 `docs/design/自主进化Agent/2-元认知引擎算法.md`

### 满意度评分
- **权重配置**: task=0.35, feedback=0.30, efficiency=0.20, knowledge=0.15
- **触发阈值**: 0.6
- **来源**: 设计文档 §2.2

### Prompt 进化
- **ε-greedy 探索率**: 0.15
- **最大变体数**: 5
- **最小试验次数**: 10
- **UCB 置信度**: 2.0
- **来源**: 设计文档 §4.3

### 人格追踪
- **EMA alpha**: 0.05
- **来源**: 设计文档 §5.2

### 目标生成
- **每日上限**: 3
- **用户审批**: always (P0 阶段)
- **来源**: 设计文档 §6

## 实验指标 (KPI)

### 核心指标

1. **平均满意度提升率**
   ```
   (satisfactionAfter - satisfactionBefore) / satisfactionBefore
   ```
   目标: > 20%

2. **目标审批率**
   ```
   approved / (approved + rejected)
   ```
   目标: > 70%

3. **Prompt 进化成功率**
   ```
   successCount / trialCount (满意度 > 0.6 算成功)
   ```
   目标: > 75%

4. **人格状态稳定性**
   ```
   Big Five 各维度的方差
   ```
   目标: 方差 < 0.1

### 辅助指标

- 目标生成频率（每日平均）
- 探索率实际值（应接近 0.15）
- 数据库查询耗时 p95
- 协调器事件处理耗时 p95

## 实验追踪流程

### Phase 1: Baseline 阶段（第 1-2 周）

**目标**: 收集基线数据

- 使用默认参数运行
- 监控所有核心指标和辅助指标
- 记录异常情况和用户反馈
- 每日生成实验报告

**数据收集**:
```bash
# 导出满意度数据
SELECT * FROM autonomous_satisfaction_scores 
WHERE created_at >= date('now', '-7 days');

# 导出目标数据
SELECT * FROM autonomous_goals 
WHERE created_at >= date('now', '-7 days');

# 导出 Prompt 性能
SELECT * FROM prompt_variants;
```

### Phase 2: 参数调优阶段（第 3-4 周）

**目标**: 优化算法参数

**实验变量**:
- epsilon: [0.1, 0.15, 0.2]
- satisfactionThreshold: [0.5, 0.6, 0.7]

**A/B 测试设计**:
- 每组 ≥ 100 次会话
- 记录每组的核心指标对比
- 使用 t-test 验证统计显著性

### Phase 3: 灰度发布阶段（第 5-6 周）

**目标**: 逐步扩大启用范围

**灰度计划**:
```bash
# 第 5 周第 1-2 天: 10%
export AUTONOMOUS_ROLLOUT_PERCENTAGE=10

# 第 5 周第 3-4 天: 30%
export AUTONOMOUS_ROLLOUT_PERCENTAGE=30

# 第 5 周第 5-7 天: 50%
export AUTONOMOUS_ROLLOUT_PERCENTAGE=50

# 第 6 周: 100%
export AUTONOMOUS_ROLLOUT_PERCENTAGE=100
```

**监控指标**:
- 错误率
- 响应时间
- 满意度趋势
- 用户反馈

**回滚触发条件**:
- 错误率 > 5%
- 平均满意度下降 > 10%
- 用户投诉 > 3 次/天

### Phase 4: 长期监控阶段（第 7 周起）

**目标**: 持续追踪系统表现

- 每周生成实验报告
- 追踪满意度趋势、目标完成率、用户反馈
- 定期审查参数是否需要调整
- 记录异常情况和改进建议

## 实验报告模板

```markdown
# 自主进化 Agent 实验报告

**日期**: YYYY-MM-DD  
**阶段**: Baseline / 参数调优 / 灰度发布 / 长期监控

## 核心指标

| 指标 | 目标 | 实际值 | 状态 |
|------|------|--------|------|
| 平均满意度提升率 | > 20% | 18.5% | ⚠️ 待优化 |
| 目标审批率 | > 70% | 75.2% | ✅ 达标 |
| Prompt 进化成功率 | > 75% | 82.3% | ✅ 达标 |
| 人格状态稳定性 | < 0.1 | 0.08 | ✅ 达标 |

## 辅助指标

- 目标生成频率: 2.3 次/天
- 探索率实际值: 0.148 (目标 0.15)
- 数据库查询耗时 p95: 45ms
- 协调器事件处理耗时 p95: 180ms

## 观察与发现

- [记录关键发现]
- [用户反馈摘要]
- [异常情况记录]

## 下一步行动

- [改进建议]
- [参数调整计划]
```

## 数据导出

```bash
# 导出 CSV 格式数据（用于离线分析）
sqlite3 agent.db <<EOF
.mode csv
.output satisfaction_scores.csv
SELECT * FROM autonomous_satisfaction_scores;
.output goals.csv
SELECT * FROM autonomous_goals;
.output prompt_variants.csv
SELECT * FROM prompt_variants;
EOF
```

## 可视化

建议使用以下工具进行数据可视化：

- **满意度趋势**: 折线图（时间序列）
- **目标分布**: 饼图（按类型）
- **Prompt 性能**: 雷达图（多维度对比）
- **人格演化**: 热力图（Big Five 维度变化）

## 参考文献

- [1] 设计文档: `docs/design/自主进化Agent/`
- [2] 实施计划: `docs/plans/AGENT自我进化/2026-09-04-autonomous-evolution-agent-implementation-p0.md`
- [3] ε-greedy 算法: Sutton & Barto, "Reinforcement Learning: An Introduction"
- [4] UCB 算法: Auer et al., "Finite-time Analysis of the Multiarmed Bandit Problem"
- [5] Big Five 模型: Costa & McCrae, "The Five-Factor Model of Personality"
