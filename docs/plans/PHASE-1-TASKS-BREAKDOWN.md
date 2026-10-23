# Phase 1 任务分解清单

**版本**: 1.0  
**更新日期**: 2026-10-23  
**总工作量**: 7 人天

---

## 📋 任务层级结构

```
Phase 1 Epic
├─ 前端任务 (4 人天)
│  ├─ TaskProgressBar (1 天)
│  ├─ TaskMilestones (0.5 天)
│  ├─ TaskLogs (1 天)
│  ├─ ResultPreviewPanel (1.5 天)
│  └─ 集成与测试 (0.5 天)
├─ 后端任务 (2 人天)
│  ├─ BackgroundTaskManager 扩展 (1 天)
│  ├─ ComfyUI 工具适配 (0.5 天)
│  ├─ MCP 工具适配 (0.5 天)
│  └─ 集成测试 (0.5 天)
└─ QA 任务 (1 人天)
   ├─ 单元测试框架 (0.3 天)
   ├─ 集成测试框架 (0.3 天)
   ├─ E2E 测试框架 (0.2 天)
   └─ 性能测试 (0.2 天)
```

---

## 🎯 前端任务 (4 人天)

### Task FE-1: TaskProgressBar 组件 (1 天)

**负责人**: FE-1  
**时间**: Day 1-2  
**依赖**: 无

#### 子任务

- [ ] 1.1 创建组件目录和文件 (10 min)
  ```
  apps/windows/src/renderer/pages/ChatPage/components/
  BackgroundTaskCard/
    └─ TaskProgressBar.tsx
    └─ TaskProgressBar.css
  ```

- [ ] 1.2 实现 TaskProgressBar 组件 (25 min)
  - 进度条渲染 (HTML5 `<progress>`)
  - 百分比显示
  - 剩余时间估计
  - 当前步骤文本
  - Indeterminate 动画

- [ ] 1.3 编写组件样式 (15 min)
  - 进度条样式
  - 动画效果
  - 响应式布局
  - 暗色/亮色主题支持

- [ ] 1.4 单元测试 (15 min)
  - 进度百分比显示
  - 剩余时间计算
  - 各种状态渲染

- [ ] 1.5 集成到 BackgroundTaskCard (10 min)
  - 导入组件
  - 传递 props
  - 验证渲染

**验收条件**:
- [ ] 组件可独立渲染
- [ ] 单元测试覆盖 ≥ 80%
- [ ] 无 TypeScript 错误
- [ ] 样式与设计稿一致

---

### Task FE-2: TaskMilestones 组件 (0.5 天)

**负责人**: FE-2  
**时间**: Day 1-2  
**依赖**: 无

#### 子任务

- [ ] 2.1 创建组件文件 (5 min)
  ```
  TaskMilestones.tsx
  TaskMilestones.css
  ```

- [ ] 2.2 实现 TaskMilestones 组件 (20 min)
  - 里程碑列表渲染
  - 状态图标 (✓/🔄/❌/⏳)
  - 耗时显示
  - 错误信息展示

- [ ] 2.3 编写组件样式 (10 min)
  - 列表布局
  - 状态颜色
  - 响应式设计

- [ ] 2.4 单元测试 (5 min)
  - 里程碑状态渲染
  - 耗时格式化

**验收条件**:
- [ ] 里程碑按顺序显示
- [ ] 状态图标正确
- [ ] 无 TypeScript 错误

---

### Task FE-3: TaskLogs 组件 (1 天)

**负责人**: FE-1  
**时间**: Day 3-4  
**依赖**: 无

#### 子任务

- [ ] 3.1 创建组件文件 (5 min)
  ```
  TaskLogs.tsx
  TaskLogs.css
  ```

- [ ] 3.2 实现 TaskLogs 核心 (25 min)
  - 日志列表展开/收起
  - 日志级别过滤 (debug/info/warn/error)
  - 虚拟滚动 (100+ 日志)
  - 时间戳格式化
  - 复制功能

- [ ] 3.3 虚拟滚动实现 (15 min)
  - 使用 React Window 或自实现
  - 性能测试 (60fps)
  - 内存占用监控

- [ ] 3.4 编写样式 (10 min)
  - 日志级别颜色
  - 可展开/收起 UI
  - Monospace 字体

- [ ] 3.5 单元测试 (15 min)
  - 日志过滤
  - 展开/收起
  - 复制功能

**验收条件**:
- [ ] 100+ 日志流畅滚动 (60fps)
- [ ] 过滤功能正常
- [ ] 复制 JSON 正确
- [ ] 覆盖率 ≥ 80%

---

### Task FE-4: ResultPreviewPanel 组件 (1.5 天)

**负责人**: FE-2  
**时间**: Day 3-5  
**依赖**: ImageLightbox 组件已存在

#### 子任务

- [ ] 4.1 创建组件文件 (5 min)
  ```
  ResultPreviewPanel.tsx
  ResultPreviewPanel.css
  ```

- [ ] 4.2 实现图片预览 (20 min)
  - 调用 ImageLightbox
  - 下载按钮
  - 放大功能

- [ ] 4.3 实现视频预览 (15 min)
  - HTML5 `<video>` 标签
  - 播放控制
  - 下载按钮

- [ ] 4.4 实现代码预览 (20 min)
  - 集成 Prism.js
  - 语言检测
  - 行号显示
  - 复制功能

- [ ] 4.5 实现 JSON 预览 (15 min)
  - 折叠/展开
  - 字段计数
  - 格式化显示

- [ ] 4.6 编写样式 (15 min)
  - 预览容器样式
  - 操作按钮样式
  - 代码高亮主题

- [ ] 4.7 单元测试 (15 min)
  - 各种类型预览
  - 按钮功能
  - 错误处理

**验收条件**:
- [ ] 图片/视频/代码/JSON 都能预览
- [ ] 加载时间 < 500ms
- [ ] 代码高亮工作正常
- [ ] 覆盖率 ≥ 80%

---

### Task FE-5: 集成与测试 (0.5 天)

**负责人**: FE-1 + FE-2  
**时间**: Day 6  
**依赖**: FE-1 至 FE-4 完成

#### 子任务

- [ ] 5.1 将 4 个组件集成到 BackgroundTaskCard (20 min)
  - 导入组件
  - 布局排列
  - Props 传递

- [ ] 5.2 集成测试 (10 min)
  - 组件间交互
  - 状态同步
  - 无崩溃

- [ ] 5.3 浏览器兼容性测试 (10 min)
  - Chrome
  - Firefox
  - Safari

- [ ] 5.4 样式回归测试 (10 min)
  - 暗色主题
  - 响应式布局
  - 其他组件未受影响

**验收条件**:
- [ ] 4 个组件可协同工作
- [ ] 兼容 3 大浏览器
- [ ] 样式无回归

---

## 🔧 后端任务 (2 人天)

### Task BE-1: BackgroundTaskManager 扩展 (1 天)

**负责人**: BE-1  
**时间**: Day 5  
**依赖**: 无

#### 子任务

- [ ] 1.1 分析现有 BackgroundTaskManager (20 min)
  - 文件: `apps/windows/src/main/agent-runtime/background-task-manager.ts`
  - 理解现有方法: start/update/complete/fail/cancel
  - 理解状态管理

- [ ] 1.2 扩展 BackgroundTask 接口 (15 min)
  - 文件: `apps/windows/src/renderer/hooks/business/useAgentRuntime/agent-runtime-store.ts`
  - 添加新字段: progress, currentStep, logs, milestones
  - 保持向后兼容 (所有字段可选)

- [ ] 1.3 实现 updateProgress 方法 (15 min)
  ```typescript
  updateProgress(taskId: string, progress: number, currentStep?: string): void
  ```

- [ ] 1.4 实现 addLog 方法 (15 min)
  ```typescript
  addLog(taskId: string, level: TaskLog['level'], message: string, context?: Record<string, unknown>): void
  ```

- [ ] 1.5 实现 setMilestones 方法 (15 min)
  ```typescript
  setMilestones(taskId: string, milestones: Milestone[]): void
  ```

- [ ] 1.6 实现 updateMilestone 方法 (10 min)
  ```typescript
  updateMilestone(taskId: string, step: string, status: Milestone['status'], duration?: number): void
  ```

- [ ] 1.7 单元测试 (15 min)
  - 测试所有 4 个新方法
  - 覆盖率 ≥ 80%

**验收条件**:
- [ ] 4 个方法实现完成
- [ ] 无 TypeScript 错误
- [ ] 向后兼容
- [ ] 单元测试通过

---

### Task BE-2: ComfyUI 工具适配 (0.5 天)

**负责人**: BE-2  
**时间**: Day 5  
**依赖**: BE-1 完成

#### 子任务

- [ ] 2.1 分析 ComfyUI 工作流 (15 min)
  - 理解 4 个阶段 (模型/生成/后期/保存)
  - 理解进度跟踪点

- [ ] 2.2 实现 ComfyUI 工具适配 (20 min)
  - 为 4 个阶段调用 BackgroundTaskManager 方法
  - 设置里程碑
  - 更新进度
  - 添加日志

- [ ] 2.3 测试 ComfyUI 工具集成 (10 min)
  - 进度正确更新
  - 日志正确记录
  - 里程碑完整

**验收条件**:
- [ ] ComfyUI 工具能正确上报进度
- [ ] 测试通过

---

### Task BE-3: MCP 工具适配 (0.5 天)

**负责人**: BE-1 (协作)  
**时间**: Day 6  
**依赖**: BE-1 完成

#### 子任务

- [ ] 3.1 编写 MCP 工具适配模板 (20 min)
  - 通用进度更新模式
  - 通用日志添加模式

- [ ] 3.2 适配现有 MCP 工具 (15 min)
  - 选择 1-2 个代表性工具
  - 集成进度跟踪

- [ ] 3.3 测试 MCP 工具集成 (10 min)

**验收条件**:
- [ ] MCP 工具模板可复用
- [ ] 1-2 个工具集成测试通过

---

### Task BE-4: 集成测试 (0.5 天)

**负责人**: BE-1 + BE-2  
**时间**: Day 6  
**依赖**: BE-1 至 BE-3 完成

#### 子任务

- [ ] 4.1 后端集成测试 (20 min)
  - BackgroundTaskManager ↔ UI 数据流
  - IPC 事件正确发送
  - 状态同步

- [ ] 4.2 工具集成测试 (15 min)
  - ComfyUI 完整流程
  - MCP 工具完整流程

- [ ] 4.3 性能测试 (10 min)
  - 100+ 日志内存占用
  - 日志添加性能

**验收条件**:
- [ ] 集成测试全通过
- [ ] 性能达标

---

## ✅ QA 任务 (1 人天)

### Task QA-1: 单元测试框架 (0.3 天)

**负责人**: QA  
**时间**: Day 1-6  
**依赖**: 前端/后端代码完成

#### 子任务

- [ ] 1.1 前端组件单元测试 (1.5 小时)
  - TaskProgressBar 测试
  - TaskMilestones 测试
  - TaskLogs 测试
  - ResultPreviewPanel 测试
  - 覆盖率 ≥ 80%

- [ ] 1.2 后端单元测试 (1.5 小时)
  - BackgroundTaskManager 测试
  - 工具适配测试

**验收条件**:
- [ ] 覆盖率 ≥ 80%
- [ ] 所有测试通过

---

### Task QA-2: 集成测试框架 (0.3 天)

**负责人**: QA  
**时间**: Day 7  
**依赖**: 前端+后端集成完成

#### 子任务

- [ ] 2.1 前后端交互测试 (1.5 小时)
  - 进度更新流程
  - 日志推送流程
  - 里程碑更新流程

**验收条件**:
- [ ] 交互流程测试通过

---

### Task QA-3: E2E 测试框架 (0.2 天)

**负责人**: QA  
**时间**: Day 7-8  
**依赖**: 前端+后端集成完成

#### 子任务

- [ ] 3.1 编写 3 个 E2E 用例 (1.2 小时)
  - 用例 1: 视频生成完整流程
  - 用例 2: 图片生成完整流程
  - 用例 3: 异常处理流程

**验收条件**:
- [ ] 3 个 E2E 用例通过

---

### Task QA-4: 性能测试 (0.2 天)

**负责人**: QA  
**时间**: Day 8  
**依赖**: 前端+后端集成完成

#### 子任务

- [ ] 4.1 性能基线测试 (1.2 小时)
  - 100+ 日志滚动帧率 (目标: 60fps)
  - 日志列表加载时间 (目标: < 500ms)
  - 视频预览加载时间 (目标: < 500ms)
  - 内存占用监控

**验收条件**:
- [ ] 帧率 ≥ 60fps
- [ ] 加载时间 < 500ms
- [ ] 内存占用稳定

---

## 📅 时间线甘特图

```
Week 1 (设计评审与规划)
Day 1: [设计评审 2h] [技术评审 1h] [环保搭建 2h]
       
Week 2 (开发)
Day 1: [FE-1: TaskProgressBar ▓▓▓▓▓] [FE-2: TaskMilestones ▓▓]
Day 2: [FE-1: TaskProgressBar 续]    [FE-2: TaskMilestones 续]
       [BE-1: 分析 BackgroundTaskManager ▓]
       
Day 3: [FE-1: TaskLogs ▓▓▓▓] [FE-2: ResultPreviewPanel ▓▓▓]
       [BE-1: 实现 4 个方法 ▓▓▓▓▓]
       
Day 4: [FE-1: TaskLogs 续]    [FE-2: ResultPreviewPanel 续]
       
Day 5: [FE-1: TaskLogs 测试 ▓] [FE-2: ResultPreviewPanel 测试 ▓]
       [BE-1: 单元测试] [BE-2: ComfyUI 适配]
       
Day 6: [FE-1+FE-2: 集成 & 测试]  [BE-1+BE-2: 集成 & 测试]
       [QA: 单元测试]

Week 3 (测试与发布)
Day 7: [QA: 集成测试] [QA: E2E 测试] [QA: 性能测试]
       [Team: 缺陷修复]
       
Day 8: [Team: 性能优化]
       [QA: 回归测试]
       
Day 9: [Release: Beta 版本准备]
       
Day 10: [Release: 发布 Beta] [PM: 用户反馈收集]
```

---

## 📊 工作量统计

| 角色 | 任务 | 工作量 | 占比 |
|------|------|--------|------|
| FE-1 | FE-1 + FE-3 + FE-5 | 2.5 天 | 35.7% |
| FE-2 | FE-2 + FE-4 + FE-5 | 2.5 天 | 35.7% |
| BE-1 | BE-1 + BE-3 + BE-4 | 1.5 天 | 21.4% |
| BE-2 | BE-2 + BE-4 | 0.5 天 | 7.1% |
| QA | QA-1 至 QA-4 | 1 天 | 14.3% |
| **总计** | | **7 人天** | **100%** |

---

## ✅ 完成标准

### 每个任务的通用完成标准

- [ ] 代码实现完成
- [ ] 单元测试覆盖 ≥ 80%
- [ ] Code Review 通过
- [ ] 无 TypeScript 错误
- [ ] 无 ESLint 警告
- [ ] 提交 commit 说明

### Phase 1 总体完成标准

- [ ] 所有 11 个任务完成
- [ ] 代码覆盖率 ≥ 80%
- [ ] 所有集成测试通过
- [ ] 所有 E2E 测试通过
- [ ] 性能基线达标
- [ ] 浏览器兼容性验证通过
- [ ] 用户满意度 > 70%

---

## 📞 日常流程

### 每日同步 (10:00)
- 昨日完成任务
- 今日计划任务
- Blockers 和风险

### 每周评审 (周五 16:00)
- 本周交付质量
- 下周计划调整
- 用户反馈收集

---

**准备开始了？** 打开 `PHASE-1-IMPLEMENTATION-GUIDE.md` 深入了解。
