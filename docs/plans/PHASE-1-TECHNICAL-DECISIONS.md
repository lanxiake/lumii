# Phase 1 关键技术决策

**版本**: 1.0  
**更新日期**: 2026-10-23  
**决策权人**: Architecture Team

---

## 1️⃣ 数据模型设计

### 决策 1.1: BackgroundTask 扩展 vs 新建 ProgressTask

**选项 A**: 扩展 BackgroundTask (现有接口)  
**选项 B**: 创建新的 ProgressTask 接口

**选择**: ✅ **选项 A - 扩展 BackgroundTask**

**理由**:
- ✅ 向后兼容 (所有新字段可选)
- ✅ 无需修改现有工具
- ✅ 单一数据源
- ❌ 选项 B 会破坏现有工具

**实现**:
```typescript
interface BackgroundTask {
  // 现有字段
  id: string
  agentName: string
  title: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  startTime: number
  endTime?: number
  output?: BackgroundTaskOutput
  
  // === Phase 1 新增 (可选) ===
  progress?: number                    // 0-100%
  currentStep?: string                 // 当前步骤
  logs?: TaskLog[]                    // 实时日志
  milestones?: Milestone[]            // 任务里程碑
}
```

**升级路径**:
1. Phase 1: 新增可选字段 (不修改现有字段)
2. Phase 2: 其他工具逐步迁移使用新字段
3. Phase 3+: 考虑字段重组或版本化

---

### 决策 1.2: 日志存储 - 内存 vs IndexedDB

**选项 A**: 内存存储 (限制 1000 条)  
**选项 B**: IndexedDB 本地存储  
**选项 C**: 混合 (内存 + 滚动到磁盘)

**选择**: ✅ **选项 A - 内存存储，限制 1000 条**

**理由**:
- ✅ 简单快速 (无 I/O 延迟)
- ✅ Phase 1 不需要持久化
- ✅ 1000 条日志 < 10MB 内存
- ❌ 选项 B 增加复杂度
- ❌ 选项 C 过度设计

**升级路径**:
- Phase 2: 如果日志过多，评估 IndexedDB 持久化
- 保留接口便于未来切换

---

### 决策 1.3: 日志级别 - 4 级 vs 5 级

**选项 A**: 4 级 (debug/info/warn/error)  
**选项 B**: 5 级 (trace/debug/info/warn/error)

**选择**: ✅ **选项 A - 4 级标准**

**理由**:
- ✅ 与 Python logging、JavaScript console 一致
- ✅ 够用且不过度
- ✅ UI 过滤按钮数量合理

---

## 2️⃣ UI 组件架构

### 决策 2.1: 组件分离 vs 单一组件

**选项 A**: 分离为 4 个独立组件  
**选项 B**: 单一 BackgroundTaskFullCard 组件

**选择**: ✅ **选项 A - 分离为 4 个独立组件**

**理由**:
- ✅ 单一职责原则
- ✅ 可独立复用
- ✅ 便于测试
- ✅ 易于维护

**组件清单**:
1. `TaskProgressBar` - 进度条
2. `TaskMilestones` - 里程碑
3. `TaskLogs` - 日志面板
4. `ResultPreviewPanel` - 结果预览

---

### 决策 2.2: 日志虚拟滚动 - React Window vs 自实现

**选项 A**: 使用 `react-window`  
**选项 B**: 自实现虚拟滚动  
**选项 C**: 不虚拟滚动 (限制显示条数)

**选择**: ✅ **选项 B - 自实现虚拟滚动**

**理由**:
- ✅ 依赖已足够多，避免添加新包
- ✅ 日志场景相对简单 (单列表)
- ✅ 自实现便于定制
- ❌ 选项 A 增加依赖体积
- ❌ 选项 C 不适合生产环境

**实现策略**:
```typescript
// 自实现虚拟滚动
const visibleLogs = useMemo(() => {
  const scrollTop = logsContainerRef.current?.scrollTop ?? 0
  const itemHeight = 24  // 每条日志高度
  const startIndex = Math.floor(scrollTop / itemHeight)
  const endIndex = startIndex + Math.ceil(maxHeight / itemHeight)
  
  return filteredLogs.slice(startIndex, endIndex + 50)
}, [filteredLogs, maxHeight])
```

---

### 决策 2.3: 结果预览 - 类型检测方式

**选项 A**: 基于 MIME type  
**选项 B**: 基于文件扩展名  
**选项 C**: 基于内容结构 (嵌套逻辑)

**选择**: ✅ **选项 C - 基于内容结构**

**理由**:
- ✅ 最可靠 (工具输出不一定有 MIME type)
- ✅ 支持多种格式变体
- ✅ 易于扩展

**检测优先级**:
1. 检查 `url` 字段 → 图片预览
2. 检查 `videoUrl` / `video_url` → 视频预览
3. 检查 `code` + `language` → 代码预览
4. 能否 JSON stringify → JSON 预览
5. 其他 → 通用预览

---

## 3️⃣ 后端集成

### 决策 3.1: 工具适配方式 - 侵入式 vs 非侵入式

**选项 A**: 在工具代码中直接调用 `BackgroundTaskManager`  
**选项 B**: 创建 ToolAdapter 装饰器模式

**选择**: ✅ **选项 A - 直接调用（Phase 1）**

**理由**:
- ✅ 简单快速
- ✅ 工具完全控制进度逻辑
- ✅ Phase 1 不需要统一适配器
- 🔮 Phase 2: 考虑装饰器模式统一管理

**实现**:
```typescript
// ComfyUI 工具内直接调用
async runComfyUI(taskId: string, params: any) {
  const taskManager = BackgroundTaskManager.getInstance()
  
  taskManager.updateProgress(taskId, 20, '加载模型')
  // ... 工具逻辑
  taskManager.updateProgress(taskId, 100, '完成')
}
```

---

### 决策 3.2: 日志推送 - WebSocket vs 轮询 vs IPC Event

**选项 A**: WebSocket (实时推送)  
**选项 B**: 定时轮询 (500ms 间隔)  
**选项 C**: IPC Event (当日志变化时)

**选择**: ✅ **选项 C + 选项 B 降级**

**理由**:
- ✅ 选项 C: IPC Event 是现有机制，无需新依赖
- ✅ 选项 B: 轮询作为降级
- ❌ 选项 A: 需要额外 WebSocket 基础设施

**实现**:
```typescript
// 事件驱动 (优先)
ipcMain.emit('background-task:logs-updated', { taskId, logs })

// 降级轮询 (如果事件丢失)
setInterval(() => {
  const task = backgroundTasks[taskId]
  if (task && task.logs.length > lastSeenCount) {
    ipcRenderer.send('background-task:pull-logs', { taskId })
  }
}, 500)
```

---

### 决策 3.3: 工具超时处理

**选项 A**: MCP 30s 硬超时 (现有)  
**选项 B**: 工具自定义超时  
**选项 C**: 后台任务长期运行

**选择**: ✅ **选项 C - 后台任务机制（已落地）**

**理由**:
- ✅ BackgroundTaskManager 已支持
- ✅ 不受 MCP 30s 限制
- ✅ 用户可离线操作

**参考**: [`background-task-offloading.md`](#) (已记录)

---

## 4️⃣ 性能与兼容性

### 决策 4.1: 日志限制 - 1000 vs 5000 vs 无限制

**选项 A**: 限制 1000 条 (Phase 1)  
**选项 B**: 限制 5000 条  
**选项 C**: 无限制 (+ IndexedDB 持久化)

**选择**: ✅ **选项 A - 限制 1000 条**

**理由**:
- ✅ 内存占用合理 (< 10MB)
- ✅ UI 响应快速
- ✅ 足够诊断大多数问题
- ✅ Phase 2+ 评估升级

**实现**:
```typescript
const newLog = { level, message, timestamp }
const logs = [...(task.logs || []), newLog]
if (logs.length > 1000) {
  logs.shift()  // 丢弃最早的日志
}
```

---

### 决策 4.2: 样式兼容性 - CSS-in-JS vs CSS 文件 vs Tailwind

**选项 A**: CSS 文件 (.css)  
**选项 B**: CSS-in-JS (styled-components)  
**选项 C**: Tailwind CSS

**选择**: ✅ **选项 A - CSS 文件**

**理由**:
- ✅ 项目现有模式
- ✅ 简单直接
- ✅ 易于维护

**文件组织**:
```
TaskProgressBar.tsx
TaskProgressBar.css
TaskMilestones.tsx
TaskMilestones.css
TaskLogs.tsx
TaskLogs.css
ResultPreviewPanel.tsx
ResultPreviewPanel.css
```

---

### 决策 4.3: 浏览器支持范围

**选项 A**: Chrome + Firefox + Safari (现代浏览器)  
**选项 B**: IE 11+ (全兼容)  
**选项 C**: Chrome 只 (最小化)

**选择**: ✅ **选项 A - 现代浏览器**

**理由**:
- ✅ 与项目现状一致
- ✅ 使用现代 API (Promise, CSS Grid 等)
- ✅ 不需要 Polyfill

**验证清单**:
- [ ] Chrome (最新 2 版本)
- [ ] Firefox (最新 2 版本)
- [ ] Safari (最新 2 版本)

---

## 5️⃣ 测试策略

### 决策 5.1: 测试框架 - Vitest vs Jest vs Playwright

**选项 A**: Vitest (单元/集成)  
**选项 B**: Jest (单元/集成)  
**选项 C**: Playwright (E2E)

**选择**: ✅ **选项 A + 选项 C - Vitest + Playwright**

**理由**:
- ✅ Vitest: 快速，Vite 集成
- ✅ Playwright: 真实浏览器测试
- ✅ 项目现有工具链

**测试范围**:
- 单元测试: Vitest (组件 + 工具函数)
- 集成测试: Vitest (BackgroundTaskManager)
- E2E 测试: Playwright (完整流程)

---

### 决策 5.2: 覆盖率目标 - 80% vs 90% vs 100%

**选项 A**: 80% (Phase 1)  
**选项 B**: 90%  
**选项 C**: 100%

**选择**: ✅ **选项 A - 80%**

**理由**:
- ✅ 实际可达，投入回报率高
- ✅ 覆盖 critical path
- ✅ 不过度测试 (UI 边界情况)
- ⏭️ Phase 2+: 评估升级到 90%

---

## 6️⃣ 向后兼容性

### 决策 6.1: 现有工具迁移策略

**选项 A**: 立即要求所有工具迁移 (强制)  
**选项 B**: 新字段可选，工具选择性迁移  
**选项 C**: 创建兼容层，自动适配旧工具

**选择**: ✅ **选项 B - 新字段可选**

**理由**:
- ✅ Phase 1 不破坏现有工具
- ✅ 工具作者可选择性采用
- ✅ 降低升级复杂度

**迁移时间表**:
- Phase 1: 新字段可选
- Phase 2: 文档更新，鼓励迁移
- Phase 3: 考虑弃用旧模式

---

### 决策 6.2: UI 版本控制

**选项 A**: 新旧 UI 共存 (功能开关)  
**选项 B**: 立即替换旧 UI  
**选项 C**: 新增 Tab 页

**选择**: ✅ **选项 A - 新旧 UI 共存（功能开关）**

**理由**:
- ✅ 降低风险
- ✅ 用户可回退
- ✅ 便于 A/B 测试

**实现**:
```typescript
// 用户设置中添加开关
const useNewTaskUI = useSettings().get('experimental.newTaskUI', false)

return useNewTaskUI 
  ? <NewBackgroundTaskCard /> 
  : <LegacyBackgroundTaskCard />
```

---

## 7️⃣ 风险与缓解

| 决策 | 风险 | 缓解 |
|------|------|------|
| **数据模型扩展** | 字段冲突 | 命名规范 + code review |
| **虚拟滚动** | 渲染不完整 | 单元测试 + E2E 测试 |
| **日志 1000 条限制** | 日志丢失 | 用户可导出 + 日志分页 |
| **IPC Event 轮询降级** | 日志延迟 | 500ms 轮询间隔 |
| **工具直接调用** | 工具知道太多 | Phase 2 重构为装饰器 |
| **CSS 文件** | 样式冲突 | 命名规范 (bem) + scoped class |

---

## 📋 决策检查清单

- [ ] **架构师**: 审核数据模型设计 (决策 1)
- [ ] **前端 Lead**: 审核 UI 组件架构 (决策 2)
- [ ] **后端 Lead**: 审核工具集成方式 (决策 3)
- [ ] **DevOps/性能**: 审核性能指标 (决策 4)
- [ ] **QA Lead**: 审核测试策略 (决策 5)
- [ ] **产品**: 审核向后兼容性 (决策 6)

---

## 📞 决策变更流程

如果实施过程中需要修改这些决策：

1. **小改** (文档更新，无代码影响): 直接更新本文档
2. **中改** (代码重构，影响 < 20%): 团队评审后执行
3. **大改** (架构变更，影响 > 20%): 停止开发，重新评估

**变更日志**: (待记录)

---

## 版本历史

| 版本 | 日期 | 更新 |
|------|------|------|
| 1.0 | 2026-10-23 | 初稿，7 个关键决策 |

---

**所有决策已获批准，可进入 Phase 1 开发阶段。**
