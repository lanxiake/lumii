# Agent 自我进化实施计划总览

本目录包含自主进化 Agent 系统的完整实施计划，涵盖 P0、P1、P2、P3 四个阶段。

---

## 文档列表

### 设计文档（`docs/design/自主进化Agent/`）

1. **1-核心设计理念.md** - Autotelic AI 与 Volitional Agency 理论基础
2. **2-元认知引擎算法.md** - 满意度评分、能力边界检测、自我反思
3. **3-内在目标生成算法.md** - 触发源检测、候选生成、探索-利用平衡
4. **4-人格进化算法.md** - Big Five 模型、EMA 更新、事件映射
5. **5-多层进化协同.md** - Shapley Value 归因、协同调度、冲突检测
6. **6-实施计划.md** - MVP 范围定义、模块拆解、数据库设计
7. **7-P1实施计划-能力边界与反思.md** - Elo Rating、能力追踪、反思引擎

### 实施计划（`docs/plans/AGENT自我进化/`）

- **2026-09-04-autonomous-evolution-agent-implementation-p0.md** - P0 阶段实施计划
- **2026-09-04-autonomous-evolution-agent-implementation-p1.md** - P1 阶段实施计划
- **2026-09-04-autonomous-evolution-agent-implementation-p2.md** - P2 阶段实施计划（多层进化协同）
- **2026-09-04-autonomous-evolution-agent-implementation-p3.md** - P3 阶段实施计划（协同闭环落地 + 多 Agent 自组织）
- **交付总结.md** - 交付物汇总与 v1.1 修订说明

> 用户指南与前端可视化方案位于 `docs/design/自主进化Agent/`：
> - **用户指南-如何使用和观测自主进化Agent.md** - 用户使用指南和验证方案
> - **前端可视化实施方案.md** - 前端界面、离线审批架构（第十节）完整技术方案

---

## 实施阶段

### P0（已完成）- 基础进化能力

**核心功能：**
- ✅ 满意度评分（4 维度加权）
- ✅ 目标生成（learning、proactive-message）
- ✅ Prompt 进化（ε-greedy A/B 测试）
- ✅ 人格追踪（Big Five 事件记录）

**验证目标：**
- Agent 能否准确评估自身表现？
- 生成的目标是否对用户有价值？
- Prompt 进化能否改善用户体验？

---

### P1（已完成）- 能力边界与自我反思

**核心功能：**
- ✅ 能力边界检测（Elo Rating System）
- ✅ 8 个能力维度追踪（代码生成、文档分析、网络搜索等）
- ✅ 自我反思引擎（LLM 深度分析）
- ✅ 能力改进目标（capability-improvement）
- ✅ 每日目标上限提升到 5

**关键算法：**
- Elo Rating: `newLevel = level + K × (actual - expected)`
- Logistic 预期表现: `1 / (1 + e^(-10 × (level - difficulty)))`
- 置信度: `1 - e^(-testCount / 20)`

---

### P2（本计划）- 多层进化协同

**核心功能：**
- 记忆策略进化（Learning-to-Rank）
- 技能策略进化（使用效果跟踪）
- 工具选择进化（Thompson Sampling）
- 多层协同调度（Shapley Value 归因）
- 冲突检测与帕累托前沿维护
- 人格自动更新（基于 P0 积累事件）
- 每日目标上限提升到 7

**实施周期：** 第 11-14 周（4 周，约 80 小时）

**关键算法：**
- Learning-to-Rank: Point-wise 线性回归 + 在线梯度更新
- Thompson Sampling: Beta 后验采样 + 成功/失败更新
- Shapley Value: 边际贡献归因（简化版）
- 协同探索: 单层探索 + 探索预算 + 优先级 EMA

**10 大任务：**
1. P2 类型与配置扩展（4h）
2. 记忆排序模型（8h）
3. 记忆进化器集成（8h）
4. Thompson Sampling 工具选择（8h）
5. 技能策略进化（8h）
6. 贡献归因与协同调度（10h）
7. 冲突检测与帕累托前沿（8h）
8. 数据库迁移与持久化（6h）
9. 人格自动更新与目标生成集成（6h）
10. 协调器集成、E2E 测试与可观测性（14h）

---

## 数据库扩展

### P2 新增表

- `memory_usage_feedback` - 记忆使用反馈与排序特征
- `skill_usage_records` - 技能使用效果记录
- `tool_usage_feedback` - 工具选择与执行反馈
- `coordinated_evolution_history` - 协同进化历史与贡献度
- `pareto_frontier` - 帕累托前沿配置

---

## 工程化保障

### 算法一致性
- Learning-to-Rank 特征归一化、标签构造、模型版本可追踪
- Thompson Sampling 使用 Beta(1, 1) 先验
- Shapley 近似有组合预算上限
- 协同探索一次最多改变一层
- 所有随机算法支持测试注入 RNG

### 性能要求
- 配置选择纯计算 p95 < 50ms
- 反馈记录异步提交，主流程增加 < 100ms
- 记忆排序 100 条候选 p95 < 50ms
- 工具采样选择 p95 < 10ms
- 帕累托前沿不超过 100 个配置

### 可靠性
- P2 所有模块可独立关闭回退到 P0/P1
- 反馈写入幂等，避免重复计数
- 模型更新版本化，失败时恢复
- 后台任务超时、重试、熔断
- 配置快照与反馈使用同一 correlation ID

### 安全与隐私
- 不记录用户消息原文、密钥、令牌
- 工具选择受现有权限约束
- 技能生成/安装/文件修改不自动执行
- 记忆只标记低效，删除需批准
- 所有策略提供停用开关和审计

---

## 测试策略

### 单元测试覆盖
- Learning-to-Rank: 特征、预测、在线学习、持久化
- Thompson Sampling: 采样、更新、过滤、幂等
- 技能统计: 聚合、阈值、缺口优先级
- Shapley: 边际贡献、归一化
- 调度器: 探索预算、单层变更
- 冲突检测: 规则命中、修复、循环防护
- Pareto: 支配关系、前沿更新、偏好选择

### 集成测试
- 数据库迁移与 CRUD
- 记忆排序闭环
- 工具选择闭环
- 技能改进闭环
- 配置选择与归因闭环

### E2E 场景
- 高/低满意度探索频率
- 记忆/工具失败回退
- 技能缺口生成目标
- 层间冲突修复
- P0/P1/P2 目标协同
- 重启恢复

---

## 成功指标

### 功能指标
- 记忆、技能、工具三条闭环独立运行
- 配置选择和反馈归因完整
- 冲突检测和安全修复
- 帕累托前沿持久化

### 质量指标
- P2 单元测试覆盖率 ≥ 80%
- P2 E2E 通过率 100%
- P0/P1 回归测试通过
- 类型检查和 lint 通过
- 数据库迁移正反向验证

### 效果指标（离线回放或灰度）
- 记忆检索 NDCG@5 提升 ≥ 10% 或至少不下降
- 工具选择成功率提升 ≥ 5%
- 技能任务满意度提升 ≥ 5%
- 层间冲突失败率下降 ≥ 20%
- P2 fallback 率 < 10%

---

## 里程碑

| 周期 | 里程碑 | 交付物 | 退出标准 |
|------|--------|--------|----------|
| 第 11 周 | 记忆与工具进化 | Tasks 1-4 | 单测通过，fallback 可用 |
| 第 12 周 | 技能进化与数据层 | Tasks 5、8 | 技能反馈闭环，迁移可回滚 |
| 第 13 周 | 多层协同 | Tasks 6-7 | 单层探索、冲突修复、前沿维护通过 |
| 第 14 周 | 集成与灰度 | Tasks 9-10 | 回归/E2E/安全/性能门槛全部通过 |

---

## 风险缓解

| 风险 | 缓解措施 |
|------|----------|
| 排序模型学习错误反馈 | 显式反馈优先、最小样本量、离线评估、可回滚权重 |
| Thompson Sampling 偶然偏向 | Beta 先验、上下文隔离、可信区间 |
| 同时探索归因失真 | 单层探索、配置快照、相关 ID |
| Shapley 估计成本高 | 增量近似、组合上限、异步计算 |
| 冲突修复改变意图 | 确定性规则、不扩大权限、审计 |
| 低效记忆误删 | 只标记不删除，删除需批准 |
| P2 故障影响回答 | Feature flag、fallback、熔断 |
| 人格漂移过快 | EMA alpha=0.05、阈值、回滚 |
| 反馈泄漏隐私 | 脱敏、字段白名单、审计 |

---

## P3（本计划）- 协同闭环落地与多 Agent 自组织

**重要**：P3 的实际起点与原路线图设想不同。经代码核查，P2 交付的四个协同算法模块（`coordinated-scheduler`、`conflict-detector`、`pareto-frontier`、`shapley-attribution`）**仅在 `index.ts` 导出，无任何业务代码消费，且全为无持久化的内存态**；`apps/windows/src` 对整个 autonomous 模块的引用数为 **0**，即 P0/P1/P2 代码在产品中从未被实例化。

因此 P3 = **让已有算法真正连上电**，而非再造新算法。三条主线：

- **主线 A：协同闭环落地（60h，必做）** — 新增 `CoordinationController` 有状态门面 + V31 状态持久化 + 配置下发 + 接入协调器 + Electron 主进程接线
- **主线 B：审批链路实施（40h，必做）** — 实施离线审批架构 A1-A8，解开"目标生成后无人可批、占满配额、不再生成"的进化死锁
- **主线 C：多 Agent 自组织（48h，选做）** — 复用已有 `AgentOrchestrator`（编排层已成熟），但设**门控条件**：主线 A 稳定运行 2 周且观测到探索排队才启动

详见 [P3 实施计划](2026-09-04-autonomous-evolution-agent-implementation-p3.md)。

---

## 相关文档

- [P0 实施计划](2026-09-04-autonomous-evolution-agent-implementation-p0.md)
- [P1 实施计划](2026-09-04-autonomous-evolution-agent-implementation-p1.md)
- [P2 实施计划](2026-09-04-autonomous-evolution-agent-implementation-p2.md)
- [P3 实施计划](2026-09-04-autonomous-evolution-agent-implementation-p3.md)
- [设计理念](../../design/自主进化Agent/1-核心设计理念.md)
- [算法详解](../../design/自主进化Agent/)

---

**更新日期：** 2026-09-04  
**状态：** P0/P1 已完成，P2 代码已落地待接线，P3 设计阶段
