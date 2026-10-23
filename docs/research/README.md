# CopilotKit 研究与 Lumii UI 优化方案

**研究周期**: 2026-10-23  
**投入**: 研究代理 + 手动分析  
**产出**: 4 份深度设计文档

---

## 📚 文档导航

### 🎯 快速开始 (5 分钟阅读)
→ **[RESEARCH-SUMMARY.md](./RESEARCH-SUMMARY.md)**

**内容**:
- 研究成果清单
- 核心建议 (P0/P1/P2)
- 实施路线图
- 技术决策清单
- 成本估算

**适合**: 产品、技术负责人，快速了解全景

---

### 🔍 深度学习 (30-45 分钟阅读)

#### 1️⃣ CopilotKit 架构与设计理念
→ **[copilotkit-ux-research.md](./copilotkit-ux-research.md)**

**包含**:
- CopilotKit 四大设计维度
  - 状态可视化 (Status Visualization)
  - 结果可视化 (Result Rendering)
  - 工作流看板化 (Workflow Kanban)
  - 插件化扩展 (Plugin System)
- 对标分析 (vs Vercel AI SDK, LangChain)
- Lumii 现状评估与缺口分析
- 短/中/长期优化方案

**适合**: 架构师、设计师，理解设计理念

**阅读时间**: 25 分钟

---

#### 2️⃣ 插件系统完整规范
→ **[plugin-system-design-spec.md](./plugin-system-design-spec.md)**

**包含**:
- 4 层架构设计 (UI / Hook / Bus / Core)
- 三个核心 API
  - `CardRegistry` (卡片类型)
  - `WidgetRegistry` (小组件位置)
  - `ActionRegistry` (快捷操作)
- 插件清单规范 (plugin.json)
- 完整代码示例
  - 最小化插件 (20 行)
  - 完整插件 (200+ 行)
- 安全性与权限模型
- 发布与部署流程

**适合**: 前端工程师、插件开发者，动手实现

**阅读时间**: 35 分钟

---

#### 3️⃣ UI 原型与实施指南
→ **[ui-prototypes-and-implementation-guide.md](./ui-prototypes-and-implementation-guide.md)**

**包含**:
- 4 个关键 UI 原型 (含完整 ASCII 演示)
  - 增强任务进度卡片
  - 结果预览面板
  - 工作流看板
  - 插件化卡片示例
- 当前问题诊断与竞品对标
- 前端文件结构调整
- 核心组件 API 定义
- 后端数据结构扩展
- 4 周实施时间表
- 完整代码示例

**适合**: 前端开发者、产品经理，规划实施

**阅读时间**: 40 分钟

---

## 🚀 行动计划

### 今天 (决策日)

```
会议: 研究成果评审
时间: 60 分钟

议程:
  1. 现状与痛点分析 (5 min) [RESEARCH-SUMMARY]
  2. 设计理念讲解 (15 min) [copilotkit-ux-research]
  3. 实施方案讨论 (20 min) [ui-prototypes]
  4. 决策与确认 (15 min)
  5. 后续工作分配 (5 min)

成果:
  ✓ 批准 Phase 1 (MVP)
  ✓ 分配开发资源
  ✓ 定下启动时间
```

---

### 第 1 周 (准备阶段)

```
任务:
  □ 创建 Jira Epic: "Agent UI 优化"
  □ 创建 5 个 Story (对应 Phase 1)
  □ UI 设计稿完成 (Figma)
  □ 后端接口定义评审
  □ 开发环境搭建

目标:
  ✓ 团队充分理解设计
  ✓ 前后端接口对齐
  ✓ 开发准备就绪
```

---

### 第 2-3 周 (开发阶段)

```
Phase 1: MVP (必做)
  ├─ Task A: 任务进度增强 (3d)
  │  └─ TaskProgressBar, TaskLogs, 后端适配
  │
  ├─ Task B: 结果预览面板 (4-5d)
  │  └─ 图片/视频/表格/代码预览器
  │
  ├─ Task C: 集成与测试 (2d)
  │  └─ E2E 测试，性能优化
  │
  └─ Task D: 发布 (1d)
     └─ Beta 版本，用户反馈收集

目标:
  ✓ 完成 MVP 上线
  ✓ 用户能看清 Agent 进度
  ✓ 产出物就地预览
```

---

### 第 4 周+ (后续计划)

```
Phase 2: 架构升级 (可选，根据用户反馈)
  ├─ CardRegistry 系统
  ├─ 工作流看板
  ├─ 官方示例插件
  └─ 文档完善

Phase 3: 完整生态 (战略性)
  ├─ WidgetRegistry + ActionRegistry
  ├─ 权限与沙箱
  ├─ 插件市场
  └─ 社区建设

目标:
  ✓ 插件系统成为平台竞争力
  ✓ 社区贡献 > 10 个插件
  ✓ 月活插件率 > 50%
```

---

## 📊 文档关键数据

### 研究覆盖范围

| 维度 | 覆盖 | 详程度 |
|------|------|--------|
| **架构** | CopilotKit 4 层 + Lumii 适配 | ⭐⭐⭐⭐⭐ |
| **设计** | 4 个原型 + ASCII 演示 | ⭐⭐⭐⭐⭐ |
| **代码** | 10+ 完整示例 | ⭐⭐⭐⭐⭐ |
| **规范** | 插件 API 完整定义 | ⭐⭐⭐⭐ |
| **实施** | 4 周计划 + 资源估算 | ⭐⭐⭐⭐ |

### 投入时间

- 研究代理: ~4 小时 (文献调研)
- 手动分析: ~6 小时 (设计+文档)
- **总计**: ~10 小时

### 文档规模

| 文档 | 字数 | 代码示例 | 原型 |
|------|------|---------|------|
| CopilotKit 研究 | 8,000+ | 5 | 2 |
| 插件规范 | 7,000+ | 8 | - |
| UI 原型与指南 | 9,000+ | 12 | 4 |
| 研究总结 | 5,000+ | 2 | - |
| **总计** | **29,000+** | **27** | **6** |

---

## 💡 关键发现

### 为什么 CopilotKit 体验好

```
分层交互
  ↓
即时反馈
  ↓
就地操作
  ↓
插件化生态
```

### Lumii 现在欠缺什么

```
❌ Tool 执行"黑盒"
   → 解决: 进度条 + 实时日志

❌ 产出物需要打开多个窗口
   → 解决: 就地预览面板

❌ 看不到 Agent 全局进度
   → 解决: 工作流看板

❌ 没有第三方定制能力
   → 解决: CardRegistry + 插件系统
```

### 实施的杠杆点

```
短期 (2 周) 投入 10 人天
  → 产出 2 个核心功能
  → 用户体验 +30%
  → ROI: 高

中期 (4 周) 投入 10.5 人天
  → 产出 插件系统基础
  → 为生态铺路
  → ROI: 中

长期 (8 周) 投入 15 人天
  → 产出 完整插件生态
  → 社区贡献
  → ROI: 高 (长期)
```

---

## 🔗 相关链接

### Lumii 现有代码
- **后台任务卡片**: `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/`
- **Agent 运行时**: `apps/windows/src/renderer/hooks/business/useAgentRuntime/`
- **消息流**: `apps/windows/src/renderer/pages/ChatPage/components/ChatMessage/`

### 参考项目
- CopilotKit: https://github.com/CopilotKit/CopilotKit (⭐ 3.5k)
- Vercel AI SDK: https://github.com/vercel/ai (⭐ 8.8k)
- Flowise: https://github.com/FlowiseAI/Flowise (⭐ 28k)

### 工具
- Figma (UI 设计)
- Plotly (交互图表)
- TypeScript (类型安全)

---

## ❓ 常见问题

### Q: 这个方案会改动现有功能吗？
**A**: 不会。所有改动都是向后兼容的。现有的对话流保持不变，新功能是增强。

### Q: 需要多少时间实施？
**A**: 
- MVP (Phase 1): 2 周 (1-2 人)
- 完整 (Phase 1+2): 4 周
- 生态 (Phase 1+2+3): 8-10 周

### Q: 用户是否需要学习新东西？
**A**: 不需要。新 UI 是自解释的（进度条、日志、预览），用户会很快适应。

### Q: 现在就可以开始吗？
**A**: 可以。所有设计都已完成，可以立即启动 Phase 1。

---

## 📝 下一步行动

### 立即 (今天)
- [ ] 与产品团队讨论方案
- [ ] 获得项目批准
- [ ] 分配开发资源

### 第 1 周
- [ ] 创建 Jira Epic 与 Story
- [ ] 完成 UI 设计稿
- [ ] 定下开发计划

### 第 2 周
- [ ] 启动开发
- [ ] 完成 Phase 1
- [ ] 发布 Beta 版

---

## 📞 反馈与讨论

**问题或建议?**

发到: [Lumii Slack #research-copilotkit]

**内容包括**:
- 觉得哪个方案最有价值
- 是否有新的想法或改进
- 实施时可能遇到的障碍

---

## 📄 文档信息

**版本**: 1.0  
**作者**: Lumii Research Group  
**最后更新**: 2026-10-23  
**下一次审查**: 2026-11-06

---

**Happy Building! 🚀**

