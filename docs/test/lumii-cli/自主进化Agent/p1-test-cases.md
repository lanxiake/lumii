# 自主进化 Agent P1 CLI 测试用例

> **测试范围**：能力边界检测与自我反思  
> **设计文档**：`docs/design/自主进化Agent/7-P1实施计划-能力边界与反思.md`  
> **实施日期**：2026-09-04  
> **状态**：开发中

---

## 测试环境

- **数据库**：SQLite (Schema V29)
- **测试工具**：Node.js + node:sqlite
- **测试数据前缀**：`p1-test-`

---

## 测试用例列表

### TC1: 数据库 Schema 验证

**目标**：验证 P1 新增的 3 张表已正确创建

**步骤**：
1. 连接数据库
2. 查询 `sqlite_master` 表获取所有表名
3. 验证包含：
   - `capability_dimensions`
   - `capability_tests`
   - `reflections`

**预期结果**：3 张表都存在

**优先级**：P0

---

### TC2: 能力维度初始化

**目标**：验证新 Agent 的能力维度初始状态

**步骤**：
1. 获取不存在的 Agent 能力状态
2. 验证返回默认值：
   - `level = 0.5`
   - `confidence = 0`
   - `boundary = 0.5`
   - `testCount = 0`

**预期结果**：默认状态正确

**优先级**：P0

---

### TC3: 能力测试记录（成功）

**目标**：验证成功完成任务后能力水平提升

**步骤**：
1. 记录能力测试：
   - `dimension = code_generation`
   - `difficulty = 0.7`（困难任务）
   - `result = success`
2. 查询更新后的能力状态
3. 验证：
   - `level > 0.5`（水平提升）
   - `testCount = 1`
   - `confidence > 0`

**预期结果**：能力水平提升，测试记录正确持久化

**优先级**：P0

---

### TC4: 能力测试记录（失败）

**目标**：验证失败任务后能力水平下降

**步骤**：
1. 记录能力测试：
   - `dimension = code_generation`
   - `difficulty = 0.3`（简单任务）
   - `result = failure`
2. 查询更新后的能力状态
3. 验证：
   - `level < 0.5`（水平下降）
   - `testCount = 1`

**预期结果**：能力水平下降

**优先级**：P0

---

### TC5: Elo Rating 算法正确性

**目标**：验证 Elo Rating 更新公式正确

**步骤**：
1. 设置初始状态：`level = 0.6`
2. 记录测试：`difficulty = 0.5, result = success`
3. 手动计算预期值：
   - `expected = 1 / (1 + exp(-10 * (0.6 - 0.5))) ≈ 0.731`
   - `actual = 1.0`
   - `newLevel = 0.6 + 0.32 * (1.0 - 0.731) ≈ 0.686`
4. 验证实际结果与预期一致（误差 < 0.01）

**预期结果**：Elo 更新公式正确

**优先级**：P0

---

### TC6: 置信度计算

**目标**：验证置信度随测试次数增加

**步骤**：
1. 记录 20 次测试
2. 验证置信度约为 0.63（允许误差 ±0.1）
3. 记录 60 次测试
4. 验证置信度约为 0.95（允许误差 ±0.05）

**预期结果**：置信度符合指数饱和函数

**优先级**：P1

---

### TC7: 能力缺口识别

**目标**：验证正确识别能力缺口

**步骤**：
1. 模拟用户频繁使用某维度（如代码生成，10 次测试）
2. 设置该维度能力水平 = 0.5（低于期望）
3. 调用 `identifyGaps()`
4. 验证：
   - 返回包含该维度的缺口
   - `currentLevel = 0.5`
   - `desiredLevel > 0.5`
   - `gap > 0`
   - `priority > 0`

**预期结果**：正确识别高需求维度的能力缺口

**优先级**：P0

---

### TC8: 能力缺口优先级排序

**目标**：验证缺口按优先级（需求 × 缺口）排序

**步骤**：
1. 模拟两个维度：
   - 维度 A：高需求（10 次测试），level = 0.5
   - 维度 B：低需求（2 次测试），level = 0.5
2. 调用 `identifyGaps()`
3. 验证：
   - 维度 A 排在维度 B 前面
   - 维度 A 的 priority > 维度 B 的 priority

**预期结果**：高需求维度优先级更高

**优先级**：P0

---

### TC9: 能力报告生成

**目标**：验证完整的能力报告包含所有信息

**步骤**：
1. 添加一些测试记录
2. 调用 `getCapabilityReport()`
3. 验证返回包含：
   - `states`：8 个维度的状态
   - `gaps`：能力缺口列表
   - `overallLevel`：加权平均水平（0-1）

**预期结果**：报告完整

**优先级**：P1

---

### TC10: 反思记录持久化

**目标**：验证反思输出正确存储

**步骤**：
1. 插入一条反思记录：
   - `trigger_reason = scheduled`
   - `primary_issue = "满意度持续低于阈值"`
   - `affected_dimensions = ["task", "efficiency"]`
   - `root_cause = "Prompt 变体未优化"`
   - `recommendations = [{type: "prompt", description: "优化基线 Prompt"}]`
   - `suggested_goals = [{type: "learning", description: "学习 Prompt 工程", priority: 0.8}]`
2. 查询数据库验证记录存在

**预期结果**：反思记录正确持久化

**优先级**：P1

---

### TC11: 反思时间窗口

**目标**：验证反思分析正确的时间窗口

**步骤**：
1. 插入反思记录
2. 验证 `analysis_window_start` 和 `analysis_window_end` 正确设置：
   - `end = 当前时间`
   - `start = end - 7天`

**预期结果**：时间窗口为最近 7 天

**优先级**：P2

---

### TC12: autonomous_goals 表类型扩展

**目标**：验证目标类型新增 `capability-improvement`

**步骤**：
1. 插入一条目标记录：
   - `type = capability-improvement`
   - `description = "提升代码生成能力"`
2. 查询验证记录存在
3. 尝试插入非法类型（如 `invalid-type`）
4. 验证 CHECK 约束生效，插入失败

**预期结果**：新类型可用，非法类型被拒绝

**优先级**：P0

---

### TC13: 能力测试与会话关联

**目标**：验证能力测试记录关联到具体会话

**步骤**：
1. 记录能力测试，指定 `session_id`
2. 查询 `capability_tests` 表
3. 验证 `session_id` 正确存储

**预期结果**：可通过 session_id 追溯能力测试来源

**优先级**：P1

---

### TC14: 多维度能力追踪

**目标**：验证同一 Agent 可追踪 8 个维度的能力

**步骤**：
1. 为同一 Agent 记录 8 个不同维度的测试
2. 查询 `capability_dimensions` 表
3. 验证返回 8 条记录，每个维度独立追踪

**预期结果**：8 个维度独立追踪

**优先级**：P1

---

### TC15: 端到端流程（P0 + P1 集成）

**目标**：验证 P1 与 P0 无冲突，协同工作

**步骤**：
1. 记录满意度评分（P0）
2. 记录能力测试（P1）
3. 识别能力缺口（P1）
4. 生成目标（P0 + P1）：
   - learning 目标（P0）
   - capability-improvement 目标（P1）
5. 验证：
   - 两类目标共存
   - 每日上限 = 5（P1 提升）
   - P0 功能不受影响

**预期结果**：P0 和 P1 协同工作，无冲突

**优先级**：P0

---

## 测试执行

```powershell
# 运行 P1 测试套件
node docs/test/自主进化Agent/run-p1-cli-suite.mjs

# 查看测试报告
cat docs/test/自主进化Agent/p1-test-report-*.md
```

---

## 成功标准

- 所有 P0 优先级测试通过（TC1-TC5, TC7-TC8, TC12, TC15）
- Elo Rating 算法正确性验证通过（TC5）
- 能力缺口识别正确（TC7-TC8）
- 与 P0 集成无冲突（TC15）
