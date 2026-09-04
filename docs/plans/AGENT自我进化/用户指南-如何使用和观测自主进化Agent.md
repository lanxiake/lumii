# 自主进化 Agent 用户指南

> **日期**：2026-09-04  
> **适用版本**：P0/P1 已完成  
> **目标读者**：终端用户、测试人员、产品经理

---

## 一、什么是自主进化 Agent？

### 1.1 核心价值

**自主进化 Agent** 是一个能够**自我评估、自我学习、自我改进**的 AI 助手系统。与传统 AI 助手的区别：

| 传统 AI 助手 | 自主进化 Agent |
|-------------|---------------|
| 被动响应用户指令 | 主动发现自身不足 |
| 能力固定不变 | 能力持续进化 |
| 无法自我评估 | 实时评估自身表现 |
| 需人工调优 | 自动优化策略 |
| 用户看不到内部状态 | 透明展示进化过程 |

### 1.2 实际应用场景

**场景 1：代码生成能力自动提升**
```
用户：帮我写一个 React 组件
Agent：生成代码 → 评估效果 → 发现用户满意度低
      → 反思原因：缺少类型定义
      → 生成目标：学习 TypeScript 最佳实践
      → 下次生成带完整类型的代码
```

**场景 2：主动提醒和帮助**
```
Agent 观察到：用户每天早上 9 点都会查看日程
Agent 生成目标：每天 8:50 提前准备当天重要事项摘要
Agent 请求批准：「我注意到你的日常习惯，想主动帮你...」
用户批准 → Agent 执行
```

**场景 3：能力边界透明化**
```
用户：帮我分析这个复杂的数据集
Agent：检测到任务难度超过当前能力边界
      → 诚实告知：「这个任务对我来说有些复杂（当前能力 0.6/1.0）」
      → 尝试执行并记录结果
      → 根据成功/失败更新能力评估
```

---

## 二、如何启用自主进化功能

### 2.1 检查当前状态

**方法 1：命令行检查**
```bash
# 检查自主进化模块是否存在
ls packages/agent-runtime/src/autonomous/

# 预期输出：
# autonomous-coordinator.ts
# meta-cognition-engine.ts
# capability-tracker.ts
# reflection-engine.ts
# ...
```

**方法 2：配置文件检查**
```bash
# 查看配置
cat packages/agent-runtime/src/autonomous/config.ts

# 关键配置项：
# - AUTONOMOUS_ENABLED: true/false
# - SATISFACTION_THRESHOLD: 0.5
# - MAX_GOALS_PER_DAY: 5 (P1)
```

### 2.2 启用配置（如果尚未启用）

修改 `packages/agent-runtime/src/autonomous/config.ts`：

```typescript
export const AUTONOMOUS_CONFIG = {
  // 总开关
  enabled: true,  // 改为 true
  
  // P0 功能
  satisfactionTracking: true,
  goalGeneration: true,
  promptEvolution: true,
  personalityTracking: true,
  
  // P1 功能
  capabilityTracking: true,
  reflectionEnabled: true,
  
  // 用户批准模式
  userApproval: 'always',  // 所有目标需批准
  
  // 每日上限
  maxGoalsPerDay: 5,  // P1 上限
};
```

### 2.3 重启服务

```bash
# 重启 Agent Runtime
pnpm --filter @lumii/agent-runtime restart

# 或重启整个应用
pnpm dev
```

---

## 三、如何验证和测试（无前端 UI 时）

### 3.1 数据库直接查询

**测试 1：验证满意度评分是否在运行**

```sql
-- 查询最近的满意度评分
SELECT 
  id,
  timestamp,
  overall_score,
  task_completion,
  user_feedback,
  efficiency,
  knowledge_growth,
  trend
FROM autonomous_satisfaction_scores
ORDER BY timestamp DESC
LIMIT 10;
```

**预期结果：** 每次对话后应有新记录，`overall_score` 在 0-1 之间。

**测试 2：验证目标生成**

```sql
-- 查询生成的自主目标
SELECT 
  id,
  type,
  description,
  status,
  user_value_score,
  created_at,
  approved_at
FROM autonomous_goals
ORDER BY created_at DESC
LIMIT 10;
```

**预期结果：** 
- `type` 应包含 `learning`、`proactive-message`（P0）
- `type` 应包含 `capability-improvement`（P1）
- `status` 初始为 `pending`

**测试 3：验证能力追踪（P1）**

```sql
-- 查询能力维度状态
SELECT 
  dimension,
  level,
  confidence,
  boundary,
  test_count,
  last_updated
FROM capability_dimensions
ORDER BY level DESC;
```

**预期结果：** 8 个能力维度（code_generation、document_analysis 等），初始 `level` = 0.5。

**测试 4：验证反思记录（P1）**

```sql
-- 查询反思记录
SELECT 
  id,
  trigger_reason,
  primary_issue,
  affected_dimensions,
  created_at
FROM reflections
ORDER BY created_at DESC
LIMIT 5;
```

**预期结果：** 每日 23:00 应有定时反思记录。

### 3.2 日志文件验证

**查看 Telemetry 日志：**

```bash
# 查找自主进化相关日志
grep "autonomous" logs/agent-runtime.log | tail -50

# 关键事件：
# - satisfaction-score-computed
# - goal-generated
# - capability-test-recorded
# - reflection-completed
```

**预期日志示例：**

```json
{
  "event": "satisfaction-score-computed",
  "timestamp": "2026-09-04T10:30:00Z",
  "score": 0.72,
  "trend": "stable"
}

{
  "event": "goal-generated",
  "timestamp": "2026-09-04T23:00:00Z",
  "goalType": "learning",
  "description": "学习用户常用的编程框架",
  "priority": 0.8
}

{
  "event": "capability-test-recorded",
  "dimension": "code_generation",
  "difficulty": 0.6,
  "result": "success",
  "levelBefore": 0.5,
  "levelAfter": 0.52
}
```

### 3.3 API 端点测试（如果已实现）

**获取自主状态：**

```bash
# 假设有 API 端点
curl http://localhost:3000/api/autonomous/status

# 预期响应：
{
  "enabled": true,
  "satisfactionScore": {
    "overall": 0.72,
    "trend": "improving",
    "lastUpdated": "2026-09-04T10:30:00Z"
  },
  "pendingGoals": [
    {
      "id": "goal-123",
      "type": "learning",
      "description": "学习用户常用的编程框架",
      "priority": 0.8
    }
  ],
  "capabilities": {
    "code_generation": { "level": 0.52, "confidence": 0.3 },
    "document_analysis": { "level": 0.48, "confidence": 0.2 }
  }
}
```

---

## 四、如何观测 Agent 状态（推荐前端实现）

### 4.1 必需的前端页面

根据设计文档 `6-实施计划.md`，应实现以下前端页面：

#### **页面 1：自主进化仪表板**

**路径：** `/autonomous-dashboard`

**布局设计：**

```
┌─────────────────────────────────────────────────────────┐
│  自主进化仪表板                              [总开关 ✓]  │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  📊 满意度趋势                                            │
│  ┌───────────────────────────────────────────────┐      │
│  │   1.0                                         │      │
│  │   0.8  ╱╲    ╱╲                              │      │
│  │   0.6 ╱  ╲  ╱  ╲╲                            │      │
│  │   0.4╱    ╲╱    ╲                            │      │
│  │   0.2                                         │      │
│  │   0.0 ─────────────────────────────────────  │      │
│  │       2h   24h   7d      当前: 0.72 ↑        │      │
│  └───────────────────────────────────────────────┘      │
│                                                           │
│  🎯 待批准目标 (2)                                        │
│  ┌───────────────────────────────────────────────┐      │
│  │ [learning] 学习用户常用的编程框架              │      │
│  │  • 优先级: ⭐⭐⭐⭐ (0.8)                      │      │
│  │  • 原因: 发现代码生成满意度较低                 │      │
│  │  • 预计耗时: 5 分钟                            │      │
│  │      [批准] [拒绝] [查看详情]                   │      │
│  ├───────────────────────────────────────────────┤      │
│  │ [proactive-message] 每日早会议提醒             │      │
│  │  • 优先级: ⭐⭐⭐ (0.6)                        │      │
│  │  • 原因: 识别到你的日常习惯                     │      │
│  │  • 预计耗时: 每天 1 分钟                       │      │
│  │      [批准] [拒绝] [查看详情]                   │      │
│  └───────────────────────────────────────────────┘      │
│                                                           │
│  🧠 能力状态 (P1)                                        │
│  ┌───────────────────────────────────────────────┐      │
│  │          开放性                                │      │
│  │        ／｜＼                                  │      │
│  │    神经质  ⚡  尽责性                          │      │
│  │      ╲    │    ／                              │      │
│  │       ＼  │  ／                                │      │
│  │        ＼│／                                  │      │
│  │      宜人性 ─ 外向性                           │      │
│  │                                                │      │
│  │  代码生成:  ████████░░ 0.52 (↑)              │      │
│  │  文档分析:  ██████░░░░ 0.48 (→)              │      │
│  │  网络搜索:  ████████░░ 0.65 (↑)              │      │
│  │  ... (展开全部 8 个维度)                       │      │
│  └───────────────────────────────────────────────┘      │
│                                                           │
│  💭 最近反思 (P1)                                        │
│  ┌───────────────────────────────────────────────┐      │
│  │ 时间: 2026-09-03 23:00                        │      │
│  │ 问题: 代码生成缺少类型定义                      │      │
│  │ 建议: 1. 学习 TypeScript 最佳实践              │      │
│  │       2. 优化 Prompt 模板                      │      │
│  │       3. 增加代码验证步骤                       │      │
│  │      [查看完整反思]                             │      │
│  └───────────────────────────────────────────────┘      │
│                                                           │
│  🔄 Prompt 进化统计 (P0)                                 │
│  ┌───────────────────────────────────────────────┐      │
│  │ greeting 变体:                                 │      │
│  │  • variant-1: 成功率 78% (使用 45 次)          │      │
│  │  • variant-2: 成功率 82% (使用 38 次) ⭐       │      │
│  │  • variant-3: 成功率 65% (使用 12 次)          │      │
│  └───────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
```

#### **页面 2：目标批准对话框**

当 Agent 生成新目标时，弹出通知：

```
┌───────────────────────────────────────────┐
│  🎯 Agent 想要学习新能力                  │
├───────────────────────────────────────────┤
│  类型: 学习目标 (learning)                │
│  描述: 学习用户常用的编程框架             │
│                                           │
│  为什么生成这个目标？                      │
│  我注意到你经常需要 React/Vue 相关帮助，   │
│  但我目前能力不足（代码生成能力 0.52/1.0） │
│                                           │
│  预计效果：                                │
│  • 代码生成满意度提升 15%                 │
│  • 响应准确性提升 20%                     │
│                                           │
│  需要做什么？                              │
│  阅读 React 官方文档和最佳实践，           │
│  并将知识存储到记忆库                      │
│                                           │
│  预计耗时: 5 分钟                         │
│  风险: 低                                 │
│                                           │
│      [批准并执行] [暂时拒绝] [永不提醒]    │
└───────────────────────────────────────────┘
```

### 4.2 最小可行前端（MVP）

如果全功能仪表板开发工作量大，可先实现**命令行仪表板**：

创建 `packages/cli/src/commands/autonomous-status.ts`：

```typescript
import { autonomousCoordinator } from '@lumii/agent-runtime';

export async function showAutonomousStatus() {
  const status = await autonomousCoordinator.getStatus();
  
  console.log('\n=== 自主进化 Agent 状态 ===\n');
  
  // 满意度
  console.log(`📊 满意度评分: ${(status.satisfaction.overall * 100).toFixed(0)}% ${status.satisfaction.trend === 'improving' ? '↑' : status.satisfaction.trend === 'declining' ? '↓' : '→'}`);
  console.log(`   任务完成: ${(status.satisfaction.taskCompletion * 100).toFixed(0)}%`);
  console.log(`   用户反馈: ${(status.satisfaction.userFeedback * 100).toFixed(0)}%`);
  console.log(`   效率: ${(status.satisfaction.efficiency * 100).toFixed(0)}%`);
  console.log(`   知识增长: ${(status.satisfaction.knowledgeGrowth * 100).toFixed(0)}%`);
  
  // 待批准目标
  if (status.pendingGoals.length > 0) {
    console.log(`\n🎯 待批准目标 (${status.pendingGoals.length}):`);
    status.pendingGoals.forEach((goal, i) => {
      console.log(`\n${i + 1}. [${goal.type}] ${goal.description}`);
      console.log(`   优先级: ${('⭐'.repeat(Math.ceil(goal.priority * 5)))}`);
      console.log(`   原因: ${goal.triggerReason}`);
    });
  } else {
    console.log('\n✅ 暂无待批准目标');
  }
  
  // 能力状态 (P1)
  if (status.capabilities) {
    console.log(`\n🧠 能力状态:`);
    Object.entries(status.capabilities).forEach(([dim, state]) => {
      const bar = '█'.repeat(Math.floor(state.level * 10)) + '░'.repeat(10 - Math.floor(state.level * 10));
      const trend = state.testCount > 5 ? (state.level > 0.5 ? '↑' : '→') : '?';
      console.log(`   ${dim.padEnd(20)}: ${bar} ${(state.level * 100).toFixed(0)}% ${trend}`);
    });
  }
  
  // 最近反思 (P1)
  if (status.lastReflection) {
    console.log(`\n💭 最近反思 (${status.lastReflection.timestamp}):`);
    console.log(`   问题: ${status.lastReflection.diagnosis.primaryIssue}`);
    console.log(`   建议数: ${status.lastReflection.recommendations.length}`);
  }
  
  console.log('\n');
}
```

**使用方式：**

```bash
# 查看自主进化状态
lumii autonomous status

# 或
pnpm cli autonomous:status
```

---

## 五、完整测试场景

### 场景 1：验证满意度评分

**步骤：**
1. 进行 5 次对话，刻意让 3 次成功、2 次失败
2. 查询数据库满意度记录
3. 验证 `overall_score` 应在 0.5-0.7 之间
4. 验证 `trend` 应为 `stable` 或 `declining`

**SQL：**
```sql
SELECT overall_score, trend FROM autonomous_satisfaction_scores ORDER BY timestamp DESC LIMIT 1;
```

### 场景 2：验证目标生成

**步骤：**
1. 连续 3 天在每天 23:05 查询数据库
2. 应看到自动生成的反思和目标

**SQL：**
```sql
-- 查看是否有定时反思
SELECT trigger_reason, created_at FROM reflections 
WHERE trigger_reason = 'scheduled' AND created_at > NOW() - INTERVAL '3 days';

-- 查看生成的目标
SELECT type, description, created_at FROM autonomous_goals 
WHERE created_at > NOW() - INTERVAL '3 days';
```

### 场景 3：验证能力追踪（P1）

**步骤：**
1. 请求 Agent 生成代码（代码生成维度）
2. 请求 Agent 分析文档（文档分析维度）
3. 请求 Agent 搜索信息（网络搜索维度）
4. 查询能力测试记录

**SQL：**
```sql
SELECT dimension, difficulty, result, level_after FROM capability_tests 
ORDER BY created_at DESC LIMIT 10;
```

### 场景 4：目标批准流程

**步骤：**
1. 等待 Agent 生成目标（或手动触发反思）
2. 在前端/CLI 看到待批准目标
3. 批准一个目标
4. 验证目标状态变为 `approved` 和 `executing`
5. 等待执行完成，状态变为 `completed`

**SQL：**
```sql
-- 批准目标
UPDATE autonomous_goals SET status = 'approved', approved_at = NOW() WHERE id = 'goal-xxx';

-- 查看状态变化
SELECT id, status, approved_at, completed_at FROM autonomous_goals WHERE id = 'goal-xxx';
```

---

## 六、常见问题排查

### Q1：数据库中没有任何记录

**可能原因：**
- 自主进化未启用
- 协调器未正常启动
- 会话结束事件未触发

**排查步骤：**
```bash
# 1. 检查配置
grep "enabled" packages/agent-runtime/src/autonomous/config.ts

# 2. 检查日志
grep "autonomous-coordinator" logs/agent-runtime.log

# 3. 手动触发评估
# 在代码中调用
autonomousCoordinator.onConversationEnd({...})
```

### Q2：满意度评分始终是 0.5

**可能原因：**
- 缺少性能指标数据
- 数据收集器未正常工作

**排查：**
```sql
-- 检查原始指标
SELECT tasks_completed, tasks_failed, positive_signals, negative_signals 
FROM autonomous_satisfaction_scores 
ORDER BY timestamp DESC LIMIT 5;
```

如果都是 0 或 NULL，说明数据收集器有问题。

### Q3：从未生成过目标

**可能原因：**
- 反思从未触发（检查定时任务）
- 满意度一直很高（> 0.8）
- 目标生成器有 Bug

**排查：**
```bash
# 检查定时任务
ps aux | grep cron

# 手动触发反思
lumii autonomous reflect --force
```

### Q4：能力追踪数据为空（P1）

**可能原因：**
- 任务类型识别失败
- 会话元数据缺失

**排查：**
```typescript
// 在 autonomous-coordinator.ts 中添加日志
logger.debug('Session metadata', { sessionId, taskType, detectedDimension });
```

---

## 七、推荐的前端实现优先级

根据用户价值和开发成本，建议按以下顺序实现前端：

| 优先级 | 功能 | 工时 | 价值 |
|-------|------|------|------|
| **P0** | CLI 状态查看命令 | 2h | 高 - 立即可用 |
| **P0** | 目标批准通知（桌面通知） | 3h | 高 - 核心交互 |
| **P1** | 简化版仪表板（仅满意度 + 待批准目标） | 8h | 高 - 可视化 |
| **P1** | 能力雷达图（P1 特性） | 4h | 中 - 能力透明 |
| **P2** | 完整仪表板（含反思、Prompt 统计） | 12h | 中 - 完整体验 |
| **P3** | 历史趋势分析页面 | 8h | 低 - 高级功能 |

---

## 八、对外说明文档建议

建议在项目 README 中添加：

```markdown
## 🧠 自主进化功能（实验性）

Lumii Agent 具备自主进化能力，可以：
- ✅ 自动评估对话质量
- ✅ 识别自身能力边界
- ✅ 生成学习目标并请求你批准
- ✅ 优化 Prompt 策略
- ✅ 追踪能力提升进度

### 启用方式

编辑配置文件启用：
\`\`\`typescript
// packages/agent-runtime/src/autonomous/config.ts
export const AUTONOMOUS_CONFIG = {
  enabled: true,
  // ...
};
\`\`\`

### 查看状态

\`\`\`bash
# 命令行查看
lumii autonomous status

# 或打开仪表板
http://localhost:3000/autonomous-dashboard
\`\`\`

### 了解更多

- [用户指南](docs/plans/AGENT自我进化/用户指南.md)
- [设计文档](docs/design/自主进化Agent/)
- [实施计划](docs/plans/AGENT自我进化/)
```

---

**下一步建议：**

1. **立即可做**：实现 CLI 状态命令（2 小时）
2. **短期**：实现桌面通知 + 简化版仪表板（1-2 天）
3. **中期**：完整仪表板 + 能力可视化（1 周）
4. **长期**：历史分析 + 高级配置（按需）
