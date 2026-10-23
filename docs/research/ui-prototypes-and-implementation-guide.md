# Lumii Agent UI 优化 - 原型设计与实施指南

**作者**: Lumii 研究组  
**日期**: 2026-10-23  
**范围**: 前端 UI 原型 + 开发指南

---

## 第一部分：当前问题诊断

### 痛点分析

```
当前流程图 (用户角度)：

用户提问
  ↓
等待中... (黑盒 5-120s)
  ↓
  看不到中间过程
  不知道 Agent 在做什么
  ↓
完成 / 失败
  ├─ 完成: "产出 5 个文件" → 要打开 5 个窗口才能看
  └─ 失败: "错误" → 看不到为什么失败

用户痛点：
❌ 不知道什么时候完成
❌ 看不到产出物
❌ 看不到执行过程
❌ 看不到错误原因
❌ 无法中断或重试
```

### 竞品对标

**Cursor AI**:
```
✅ Tool 执行进度实时显示 (20% → 40% → 100%)
✅ 错误时展示完整日志
✅ 产出物可在侧栏预览
❌ 不支持自定义渲染
```

**GitHub Copilot X**:
```
✅ 工具卡片实时刷新
✅ 结果就地展示（不需要打开新窗口）
✅ 支持多工具并行可视化
❌ 配置选项少
```

**Claude.ai (Claude Code)**:
```
✅ 文件改动实时显示
✅ 执行结果实时流式输出
✅ 工具调用详情可展开
✅ 日志可复制/导出
❌ 插件系统不开放
```

### Lumii 现有优势

1. ✅ 后台任务管理框架已经建立
2. ✅ Agent 多角色体系完整
3. ✅ 事件系统成熟
4. ✅ MCP 集成深度好

---

## 第二部分：UI 原型设计

### 原型 1: 增强的任务进度卡片

**当前状态**:
```
┌─────────────────────────────────────┐
│ ✓ 生成视频  已完成  耗时 2:34  产出 1 │
└─────────────────────────────────────┘
```

**目标状态**:
```
┌─────────────────────────────────────────────────┐
│ 🎬 生成视频 (3/7 处理中)                    ▼   │
├─────────────────────────────────────────────────┤
│                                                  │
│ 进度: [████████░░░░░░░░░░░░░░░] 42%            │
│                                                  │
│ 阶段: 正在处理第 3 个场景的贴图...              │
│                                                  │
│ 📋 实时日志 (5 条) [展开]                      │
│ [14:23:15] ℹ️  模型已加载 (GPU 内存 8GB/12GB)   │
│ [14:23:30] ℹ️  开始处理场景 1/7                  │
│ [14:24:12] ℹ️  贴图处理完毕 (耗时 42s)          │
│ [14:24:45] ⚠️  警告: GPU 温度 85°C              │
│ [14:25:02] ℹ️  开始处理场景 2/7                  │
│                                                  │
│ 🎬 产出 1                                       │
│                                                  │
│ ┌──────────────────────────────────┐           │
│ │ 🎥 scene-03-preview.mp4 (12MB)   │           │
│ │ [预览] [下载] [复制链接]         │           │
│ └──────────────────────────────────┘           │
│                                                  │
│ ┌─────────────────────────────────┐            │
│ │ [中止任务]  [查看完整日志] [导出] │            │
│ └─────────────────────────────────┘            │
└─────────────────────────────────────────────────┘
```

**关键改进点**:

1. **进度可视化**
   - 百分比 + 进度条
   - 当前阶段文本
   - 里程碑标记（可选）

2. **实时日志**
   - 最后 5-10 条日志可见
   - 按等级着色 (info/warn/error)
   - 可展开显示全部
   - 支持导出和复制

3. **产出物预览**
   - 就地显示（不打开新窗口）
   - 支持多格式（图片/视频/表格/代码）
   - 快捷操作（预览/下载/复制）

4. **用户操作**
   - 可中止（取消按钮）
   - 可查看详情（查看完整日志）
   - 可导出结果（导出按钮）

---

### 原型 2: 结果预览面板

**图片预览**:
```
┌─────────────────────────────────────┐
│ 图片产出                        ✕   │
├─────────────────────────────────────┤
│                                      │
│           ┌──────────────┐          │
│           │              │          │
│           │   [图片]     │ ← 可以缩放和拖动
│           │              │          │
│           └──────────────┘          │
│                                      │
│ 📊 信息:                             │
│  • 尺寸: 1920×1080                  │
│  • 格式: PNG                        │
│  • 大小: 2.4MB                      │
│  • 创建时间: 2026-10-23 14:25:30   │
│                                      │
│ 🛠️ 操作:                             │
│ [下载] [复制到剪贴板] [在浏览器打开] │
│ [AI 编辑] [去背景] [放大超清]       │
│                                      │
└─────────────────────────────────────┘
```

**表格预览**:
```
┌────────────────────────────────────────────┐
│ 数据表格: sales_data.csv                ✕  │
├────────────────────────────────────────────┤
│ 搜索: ________  [按 {名称 ▼}]              │
├───┬──────────┬──────────┬──────────┬───────┤
│# │ 产品名   │ 销售额   │ 同比增长 │ 排名  │
├───┼──────────┼──────────┼──────────┼───────┤
│1 │ 产品 A   │ ¥45.2M   │ ↑12.5%  │ 🥇    │
│2 │ 产品 B   │ ¥38.6M   │ ↑8.2%   │ 🥈    │
│3 │ 产品 C   │ ¥32.1M   │ ↓2.3%   │ 🥉    │
│4 │ 产品 D   │ ¥28.9M   │ ↑5.1%   │ 4     │
├───┴──────────┴──────────┴──────────┴───────┤
│ 显示 1-4 共 4 项                             │
│ [导出 CSV] [导出 Excel] [生成图表]         │
└────────────────────────────────────────────┘
```

**代码预览**:
```
┌──────────────────────────────────────────┐
│ 代码: query-optimizer.ts                 │
├──────────────────────────────────────────┤
│ 1  │ export function optimizeQuery(    │
│ 2  │   sql: string,                   │
│ 3  │   indexes: Index[]               │
│ 4  │ ): string {                      │
│ 5  │   return analyze(sql, indexes)   │
│ 6  │     .then(plan => execute(plan)) │
│ 7  │ }                                │
│    │                                  │
│ [复制] [在编辑器中打开] [应用此更改]   │
└──────────────────────────────────────────┘
```

---

### 原型 3: 工作流看板化视图

**并行 Agent 执行看板**:

```
┌─────────────────────────────────────────────────────────────┐
│ 📊 Agent 工作流看板                              [切换] [详情] │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ 任务: 生成一份市场分析报告 + 5 个数据图表 + 对比分析      │
│                                                              │
│  时间 →                                                    │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ [Agent-1] Excel 数据处理                           │  │
│  │  ├─ 📥 数据导入         ✓ (12s)                   │  │
│  │  ├─ 🔄 清洗与去重        ✓ (34s)                  │  │
│  │  ├─ 📊 生成统计         🔄 (...)  [取消]          │  │
│  │  └─ 📤 数据导出         ⏳ (待定)                  │  │
│  └──────────────────────────────────────────────────────┘  │
│           ↓ 依赖                                           │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ [Agent-2] 报告生成                                 │  │
│  │  ├─ 📝 结构设计         ✓ (8s)                    │  │
│  │  ├─ ✍️ 内容编写         🔄 (...)                   │  │
│  │  ├─ 🎨 样式排版         ⏳ (待定)                  │  │
│  │  └─ 📄 输出 PDF         ⏳ (待定)                  │  │
│  └──────────────────────────────────────────────────────┘  │
│           ↓ 依赖                                           │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ [Agent-3] 对比分析                                 │  │
│  │  ├─ 🔍 数据对齐         ⏳ (待定)                  │  │
│  │  └─ 📈 生成对比表       ⏳ (待定)                  │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│ 符号说明: ✓ 完成  🔄 进行中  ⏳ 等待中  ❌ 失败             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**关键特性**:

1. **纵向 Agent 分离** - 每个 Agent 一栏
2. **横向时间轴** - 显示执行顺序和耗时
3. **依赖关系** - 虚线箭头表示 task 间依赖
4. **实时更新** - 任务状态动态刷新
5. **可交互** - 点击任务查看详情/日志/重试

---

### 原型 4: 插件化卡片示例

**自定义图表卡片**:
```
┌─────────────────────────────────────────────────┐
│ 📊 销售趋势分析 (Plugin: Chart-Enhanced)       │
├─────────────────────────────────────────────────┤
│                                                  │
│  销售额 (万元)                                  │
│  │                                 ┌────        │
│  │      ┌────┐                ┌────┘           │
│  │  ┌───┘    └──┐  ┌──────┬──┘                │
│  ├──┼───────────┼──┼──────┬─────────────┤     │
│  │  │ Q1  Q2 Q3 │  │Q4    │             │     │
│  └──┴───────────┴──┴──────┴─────────────┘     │
│                                                  │
│ 💡 洞察:                                        │
│  • Q3 销售同比 +18%                            │
│  • 最高峰在 Q3 第 2 周                         │
│  • 预测 Q4 会继续增长                          │
│                                                  │
│ 🛠️ 图表操作:                                    │
│ [放大] [缩小] [导出 PNG] [导出数据] [分享]    │
│                                                  │
│ 📌 快捷操作 (插件注册):                         │
│ [添加预警规则] [添加到报告] [分享到飞书]     │
│                                                  │
└─────────────────────────────────────────────────┘
```

---

## 第三部分：技术实施指南

### 3.1 前端文件结构调整

```
apps/windows/src/renderer/
├── pages/ChatPage/
│  ├── components/
│  │  ├── BackgroundTaskCard/
│  │  │  ├── EnhancedTaskCard.tsx        ← 新增，替换旧卡片
│  │  │  ├── TaskProgressBar.tsx         ← 新增，进度条
│  │  │  ├── TaskLogs.tsx                ← 新增，日志面板
│  │  │  ├── TaskOutputs.tsx             ← 新增，产出物预览
│  │  │  ├── format.ts
│  │  │  └── index.tsx
│  │  │
│  │  ├── ResultPreviewPanel/            ← 新增目录
│  │  │  ├── ResultPreviewPanel.tsx
│  │  │  ├── ImagePreview.tsx
│  │  │  ├── VideoPreview.tsx
│  │  │  ├── TablePreview.tsx
│  │  │  ├── CodePreview.tsx
│  │  │  └── types.ts
│  │  │
│  │  ├── WorkflowKanban/                ← 新增目录
│  │  │  ├── WorkflowKanban.tsx
│  │  │  ├── KanbanLane.tsx
│  │  │  ├── TaskBox.tsx
│  │  │  └── types.ts
│  │  │
│  │  └── ...
│  │
│  └── ChatPage.tsx                      ← 修改，集成新组件
│
├── systems/                             ← 新增目录
│  ├── CardRegistry.ts                   ← 卡片注册表
│  ├── WidgetRegistry.ts                 ← 小组件注册表
│  ├── ActionRegistry.ts                 ← 操作注册表
│  ├── PluginLoader.ts                   ← 插件加载器
│  └── types.ts
│
├── plugins/                             ← 新增目录（官方示例）
│  ├── chart-enhanced/
│  ├── table-enhanced/
│  └── code-highlighter/
│
└── ...
```

### 3.2 核心组件 API

```typescript
// TaskProgressBar 组件
interface TaskProgressBarProps {
  progress?: number;           // 0-100
  currentPhase?: string;      // 当前阶段文本
  status: 'running' | 'done' | 'error';
}

export const TaskProgressBar: React.FC<TaskProgressBarProps> = ({ ... }) => {
  // 渲染进度条 + 百分比 + 阶段文本
};

// TaskLogs 组件
interface TaskLogsProps {
  logs: Array<{
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
    timestamp: number;
  }>;
  isExpanded?: boolean;
  onToggle?: () => void;
}

export const TaskLogs: React.FC<TaskLogsProps> = ({ ... }) => {
  // 渲染实时日志，支持展开/折叠
};

// ResultPreviewPanel 组件
interface ResultPreviewPanelProps {
  output: {
    kind: 'image' | 'video' | 'table' | 'code' | 'markdown';
    data: unknown;
    metadata?: Record<string, any>;
  };
  actions?: Array<{
    label: string;
    icon?: string;
    handler: () => Promise<void>;
  }>;
}

export const ResultPreviewPanel: React.FC<ResultPreviewPanelProps> = ({ ... }) => {
  // 根据 kind 渲染对应预览器
};
```

### 3.3 集成到现有组件

```typescript
// apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/index.tsx

// 改动前
export const BackgroundTaskCard: React.FC<{ task: BackgroundTask }> = ({ task }) => {
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        {/* 简单的状态显示 */}
      </div>
      {/* 简单的输出列表 */}
    </div>
  );
};

// 改动后
import { EnhancedTaskCard } from './EnhancedTaskCard';
import { TaskProgressBar } from './TaskProgressBar';
import { TaskLogs } from './TaskLogs';
import { ResultPreviewPanel } from '../ResultPreviewPanel';

export const BackgroundTaskCard: React.FC<{ task: BackgroundTask }> = ({ task }) => {
  const [expandedLogs, setExpandedLogs] = useState(false);
  
  // 如果是 Enhanced 版本，使用新组件；否则降级
  if (task.progress !== undefined || task.logs?.length > 0) {
    return (
      <EnhancedTaskCard
        task={task}
        expandedLogs={expandedLogs}
        onToggleLogs={() => setExpandedLogs(!expandedLogs)}
      />
    );
  }
  
  // 降级到旧组件
  return <OldTaskCard task={task} />;
};
```

### 3.4 后端数据结构扩展

```typescript
// shared/agent-runtime-events.ts

// 扩展现有的 BackgroundTask 类型
export interface BackgroundTask {
  // 现有字段
  taskId: string;
  toolName: string;
  label: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  result?: string;
  error?: string;
  summary?: string;
  outputs?: BackgroundTaskOutput[];
  
  // 新增字段
  progress?: number;              // 0-100，进度百分比
  currentPhase?: string;          // "正在处理第 3/7 个文件"
  logs?: Array<{                  // 实时日志
    level: 'info' | 'debug' | 'warn' | 'error';
    message: string;
    timestamp: number;
  }>;
  milestones?: Array<{            // 关键里程碑
    name: string;
    status: 'pending' | 'done' | 'error';
    startedAt?: number;
    endedAt?: number;
  }>;
  note?: string;                  // 运行中的额外提示
}

// 产出物增强
export interface BackgroundTaskOutput {
  kind: 'video' | 'image' | 'audio' | 'file' | 'table' | 'chart' | 'code';
  path: string;
  name: string;
  url?: string;
  
  // 新增：类型特定的元数据
  metadata?: {
    // 图片
    imageWidth?: number;
    imageHeight?: number;
    imageMimeType?: string;
    
    // 表格
    tableColumns?: string[];
    tableRows?: number;
    
    // 代码
    codeLanguage?: string;
    codeLinesOfCode?: number;
    
    // 通用
    mimeType?: string;
    sizeBytes?: number;
    createdAt?: number;
  };
  
  // 新增：预览数据（可选，减少加载时间）
  preview?: {
    imageBase64?: string;      // 缩略图
    textPreview?: string;      // 文本预览前 500 字
    htmlPreview?: string;      // HTML 预览
  };
}
```

### 3.5 Hook 暴露实现

```typescript
// systems/LumiiHooks.ts

export namespace LumiiHooks {
  // 获取当前对话上下文
  export function useLumiiContext(): {
    currentAgent?: Agent;
    currentSession?: Session;
    config: PluginConfig;
    user?: User;
  } {
    // 从 Redux store 获取
    const dispatch = useDispatch();
    const state = useSelector((s) => s);
    return {
      currentAgent: state.agents.current,
      currentSession: state.sessions.current,
      config: state.plugins.config,
      user: state.auth.user,
    };
  }

  // 获取消息流
  export function useMessageStream() {
    const messages = useSelector((s) => s.messages.list);
    const isLoading = useSelector((s) => s.messages.isLoading);
    return { messages, isLoading };
  }

  // 获取工具执行状态
  export function useToolExecution(toolName: string) {
    const execution = useSelector(
      (s) => s.tools.executions[toolName]
    );
    return {
      isRunning: execution?.status === 'running',
      progress: execution?.progress,
      logs: execution?.logs ?? [],
    };
  }

  // 更多 Hook...
}
```

---

## 第四部分：实施时间表

### 第 1 周: 前期准备 (10h)
- [ ] 设计评审与原型批准 (2h)
- [ ] 技术栈选型（Plotly vs ECharts for charts）(2h)
- [ ] 数据结构定义与后端接口设计 (3h)
- [ ] 开发环境搭建 (3h)

### 第 2 周: 核心组件开发 (20h)
- [ ] TaskProgressBar 组件 (3h)
- [ ] TaskLogs 组件 (3h)
- [ ] ResultPreviewPanel (图片/视频) (4h)
- [ ] CardRegistry 系统 (5h)
- [ ] 集成与测试 (5h)

### 第 3 周: 扩展与优化 (20h)
- [ ] 表格/代码预览器 (4h)
- [ ] 工作流看板原型 (6h)
- [ ] WidgetRegistry & ActionRegistry (4h)
- [ ] 官方示例插件 (3h)
- [ ] 文档编写 (3h)

### 第 4 周: 测试与发布 (15h)
- [ ] 完整 E2E 测试 (5h)
- [ ] 性能优化 (4h)
- [ ] 文档完善 (3h)
- [ ] Beta 版本发布 (3h)

**总计**: ~65 小时 = 约 2 周全职开发

---

## 第五部分：风险评估与缓解

| 风险 | 概率 | 影响 | 缓解方案 |
|------|------|------|---------|
| 后端日志推送延迟 | 中 | 中 | 降级到轮询，设定合理间隔 |
| 插件加载器性能问题 | 低 | 高 | 使用 Web Worker，异步加载 |
| 浏览器兼容性 | 低 | 低 | 降级渲染，Polyfill |
| 用户数据隐私 | 低 | 高 | 权限系统，数据本地化处理 |

---

## 第六部分：成功指标

### 定性指标
- ✅ 用户能清晰看到 Agent 执行进度
- ✅ 产出物无需打开新窗口即可预览
- ✅ 用户反馈"体验更好"

### 定量指标
- 📊 **任务完成时感知延迟**: < 2 秒（从完成到看到通知）
- 📊 **卡片渲染性能**: < 100ms（包含日志和产出物）
- 📊 **插件加载时间**: < 500ms
- 📊 **用户点开卡片比例**: > 60%（当前未测）

---

## 附录：完整代码示例

### A. EnhancedTaskCard 完整实现

```typescript
// components/EnhancedTaskCard.tsx
import React, { useState, useEffect } from 'react';
import { BackgroundTask } from '../types';
import { TaskProgressBar } from './TaskProgressBar';
import { TaskLogs } from './TaskLogs';
import { ResultPreviewPanel } from '../ResultPreviewPanel';
import styles from './EnhancedTaskCard.module.css';

interface EnhancedTaskCardProps {
  task: BackgroundTask;
  expandedLogs?: boolean;
  onToggleLogs?: () => void;
}

export const EnhancedTaskCard: React.FC<EnhancedTaskCardProps> = ({
  task,
  expandedLogs = false,
  onToggleLogs,
}) => {
  const [displayedLogs, setDisplayedLogs] = useState(task.logs ?? []);
  const running = task.status === 'running';

  // 实时日志订阅（模拟）
  useEffect(() => {
    if (!running) return;

    const interval = setInterval(() => {
      // 在实际应用中，这里会订阅 WebSocket 或轮询新日志
      // setDisplayedLogs((prev) => [...prev, newLog]);
    }, 500);

    return () => clearInterval(interval);
  }, [running]);

  const hasOutputs = (task.outputs ?? []).length > 0;

  return (
    <div className={styles.container}>
      {/* 头部：标题 + 状态 */}
      <div className={styles.header}>
        <span className={styles.icon}>{task.status === 'running' ? '⏳' : '✓'}</span>
        <h4 className={styles.title}>{task.label}</h4>
        {task.currentPhase && <span className={styles.phase}>({task.currentPhase})</span>}
      </div>

      {/* 进度条 */}
      {task.progress !== undefined && (
        <TaskProgressBar
          progress={task.progress}
          currentPhase={task.currentPhase}
          status={task.status}
        />
      )}

      {/* 日志面板 */}
      {displayedLogs.length > 0 && (
        <TaskLogs
          logs={displayedLogs}
          isExpanded={expandedLogs}
          onToggle={onToggleLogs}
        />
      )}

      {/* 产出物 */}
      {hasOutputs && (
        <div className={styles.outputs}>
          <h5 className={styles.outputsTitle}>📦 产出物 ({task.outputs?.length})</h5>
          {task.outputs?.map((output) => (
            <ResultPreviewPanel
              key={`${output.kind}:${output.path}`}
              output={output}
            />
          ))}
        </div>
      )}

      {/* 底部操作 */}
      <div className={styles.footer}>
        {running && (
          <button className={styles.btn} onClick={() => cancelTask(task.taskId)}>
            中止
          </button>
        )}
        <button className={styles.btn}>导出日志</button>
      </div>
    </div>
  );
};

function cancelTask(taskId: string) {
  // 调用取消 API
  const api = (window as any).electronAPI;
  api?.agentRuntime?.sendCommand?.({
    type: 'background-task:cancel',
    taskId,
  });
}
```

### B. CardRegistry 实现

```typescript
// systems/CardRegistry.ts
import React from 'react';

export interface CardRegistryEntry<T = unknown> {
  type: string;
  component: React.ComponentType<any>;
  validate?: (data: unknown) => data is T;
  priority?: number;
  metadata?: {
    displayName: string;
    description: string;
    tags: string[];
    supportedTools?: string[];
  };
}

class CardRegistry {
  private static entries: Map<string, CardRegistryEntry> = new Map();
  private static listeners: Set<Function> = new Set();

  static register<T>(entry: CardRegistryEntry<T>): void {
    this.entries.set(entry.type, entry);
    this.listeners.forEach((listener) => listener('register', entry));
  }

  static getComponent(
    data: unknown
  ): React.ComponentType<any> | null {
    const entries = Array.from(this.entries.values()).sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
    );

    for (const entry of entries) {
      if (!entry.validate || entry.validate(data)) {
        return entry.component;
      }
    }

    return null;
  }

  static unregister(type: string): void {
    this.entries.delete(type);
    this.listeners.forEach((listener) => listener('unregister', type));
  }

  static on(
    event: 'register' | 'unregister',
    callback: (event: string, data: any) => void
  ): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
}

export { CardRegistry };
```

---

**文档完成日期**: 2026-10-23  
**下一步**: 创建详细的 Jira 任务单，开始第 1 周工作

