# CopilotKit 交互设计研究与 Lumii 适配建议

**研究时间**: 2026-10-23  
**研究对象**: CopilotKit (https://www.copilotkit.ai)  
**应用场景**: Lumii Agent 工作流可视化与用户体验优化

---

## 执行摘要

### 核心发现

CopilotKit 的设计哲学是**分层交互**与**即时反馈**的结合：

1. **动静分离** - 长流程后台化，关键决策点前置到对话流
2. **实时可视化** - Tool 执行、状态转换、数据产出逐步展示（而非等待完成）
3. **上下文内操作** - 避免弹窗打断，结果就地展示/编辑/预览
4. **渐进式扩展** - 插件只改变渲染和交互，不触及核心流程

### Lumii 现状评估

**现有优势**:
- ✅ 后台任务卡片设计完整（BackgroundTaskCard）
- ✅ Agent 多角色切换框架（专项 Agent 设计 v3.1）
- ✅ MCP 工具集成成熟

**现有缺陷**:
- ❌ Tool 执行过程"黑盒" - 只看到完成态，不知道中间步骤
- ❌ 产出物缺少预览 - 图片/视频/文档都要打开新窗口
- ❌ 插件系统虽存在但UI扩展能力有限 - 只能改业务逻辑，难以扩展组件库
- ❌ 对话流缺少"看板化" - 一条条消息堆叠，难以看清 Agent 全局进度

---

## 一. CopilotKit 核心架构

### 1.1 分层组件模型

```
┌─────────────────────────────────────────┐
│  Copilot Shell (根容器)                  │
│  ├─ Chat Sidebar Panel                  │
│  ├─ In-Context Canvas (浮窗)            │
│  └─ Document Editor Integration         │
├─────────────────────────────────────────┤
│  UI State Provider (状态管理)            │
│  ├─ Message History                     │
│  ├─ Tool Execution State                │
│  ├─ Artifact Management                 │
│  └─ Floating Buttons                    │
├─────────────────────────────────────────┤
│  Hook Layer (业务逻辑)                   │
│  ├─ useCopilot()                        │
│  ├─ useAgent()                          │
│  └─ Custom Tool Hooks                   │
└─────────────────────────────────────────┘
```

**设计原则**: 
- 组件只负责渲染，状态托管给 Context
- Hook 暴露给外部，允许业务逻辑注入
- 每个交互维度可独立开关

### 1.2 动静分离的交互模式

| 场景 | 展示方式 | 用户交互 |
|------|--------|--------|
| **工具执行进度** | 对话流内实时卡片 | 可中断、可查看日志 |
| **数据预览** | 对话流内嵌（图片/表格），支持全屏 | 就地编辑或导出 |
| **长流程** | 后台化 → 心跳通知 → 结果卡片 | 异步查看，不阻塞对话 |
| **关键决策** | 模态对话框 | 同步等待用户反馈 |
| **代码/文件生成** | Artifact 面板 + 对话内链接 | 对比/复制/插入 |

**Lumii 当前状态**: 后台任务部分实现，但缺少中间步骤可视化

---

## 二. 四大设计维度

### 2.1 维度 A: 状态可视化（Status Visualization）

#### 目标
让用户**实时看到** Agent 在做什么，而不是"请稍候..."

#### CopilotKit 实现

```typescript
// 工具执行状态流
type ToolExecutionState = 
  | { phase: 'queued' }           // 排队中
  | { phase: 'running', progress: number }  // 0-100
  | { phase: 'streaming', chunk: string }  // 实时流出结果
  | { phase: 'rendering' }        // 结果正在渲染
  | { phase: 'done', result: any }  // 完成
  | { phase: 'error', reason: string }  // 失败
```

#### UI 表现
- **排队/运行中**: 转圈动画 + 进度百分比 + "执行中..." 文本
- **流式输出**: Markdown 逐字出现（类似 ChatGPT）
- **完成**: 结果卡片固定，支持折叠/展开/导出
- **失败**: 红色标记 + 错误堆栈/日志，可重试

#### Lumii 当前实现
```typescript
// BackgroundTaskCard 实现了基础进度展示
const STATUS_TEXT = {
  running: '后台执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}
```

**缺口**:
- 没有 `progress` 百分比
- 没有 `phase` 的中间状态区分
- 没有流式输出（streaming）支持
- 没有日志实时查看（必须展开卡片）

---

### 2.2 维度 B: 结果可视化（Result Rendering）

#### 目标
产出物就地展示，支持多种格式和快速预览

#### CopilotKit 策略: Card Registry

```typescript
// 注册卡片类型
CardRegistry.register({
  type: 'code',
  renderer: CodeBlock,          // 代码高亮 + 复制 + 插入
  actions: ['copy', 'insert', 'export']
})

CardRegistry.register({
  type: 'chart',
  renderer: ChartCanvas,        // 图表可交互
  actions: ['export-png', 'data-export']
})

CardRegistry.register({
  type: 'document',
  renderer: DocumentPreview,    // PDF/Word 预览
  actions: ['open', 'download']
})
```

#### UI 表现
- **代码**: 语法高亮、行号、复制按钮、"插入到编辑器"
- **表格**: 可排序、可筛选、可导出 CSV/Excel
- **图表**: Plotly 交互式探索、截图、数据导出
- **文档**: 预览 + 下载 + "在编辑器中打开"
- **图片**: Lightbox + EXIF 信息 + 去背景/编辑快捷链接
- **视频**: 播放器 + 进度条 + 下载

#### Lumii 当前实现
```typescript
// 支持的产出物类型
type BackgroundTaskOutput = 
  | { kind: 'video', path: string, url?: string }
  | { kind: 'image', path: string, url?: string }
  | { kind: 'audio', path: string, url?: string }
  | { kind: 'file', path: string, url?: string }
```

**缺口**:
- 只有文件列表 + 外链，没有就地预览
- 图片/视频/音频都要点开才能看
- 没有快捷操作（复制、导出、编辑）
- 没有数据类型感知（表格/图表/代码自动识别）

---

### 2.3 维度 C: 工作流看板化（Workflow Kanban）

#### 目标
让用户**一眼看清** Agent 团队的全局进度

#### CopilotKit 方案: Parallel Execution View

```
┌─ 用户请求 ─────────────────────────┐
│  "分析这个 Excel，生成报告与图表"   │
└────────────────────────────────────┘
         ↓ 分解为三条并行任务
  ┌──────────┴──────────┬──────────┐
  ↓                     ↓          ↓
[Agent-1]        [Agent-2]   [Agent-3]
Excel 解析       生成报告     绘制图表
├─ 读文件 ✓      ├─ 组织文本  ├─ 数据聚合
├─ 解析表格 ✓    ├─ 求和统计  ├─ 选择图表
├─ 数据清理 🔄   └─ 导出 PDF  └─ 渲染中
```

**UI 设计**:
- 横向看板卡片，每个 Agent 一列
- 每列内依次显示 Task，用 checkbox + 颜色标记进度
- 日志流就地展示在卡片底部（可折叠）
- 任务间有依赖箭头连线（可视化流程图）

#### Lumii 当前状态
有专项 Agent 设计框架，但 UI 上：
- 还是串行的对话形式
- 看不到 Agent 间的并行执行
- 看不到子任务的细粒度进度

---

### 2.4 维度 D: 插件化扩展（Plugin System）

#### CopilotKit 的插件设计

**两个层面的扩展**:

##### a) 工具层扩展 (Tool Registration)
```typescript
const customTool = {
  name: 'image-enhance',
  description: 'Enhance image quality using AI',
  parameters: {
    imageUrl: { type: 'string' },
    strength: { type: 'number', min: 0, max: 100 }
  },
  handler: async (params) => {
    // 业务逻辑
    return { enhancedUrl: '...' }
  }
}

copilot.registerTool(customTool)
```

##### b) UI 层扩展 (Card Registry + Component Override)
```typescript
// 1. 注册自定义卡片渲染
CardRegistry.register({
  type: 'custom-result',
  renderer: MyCustomResultComponent,
  actions: ['view', 'export']
})

// 2. 覆盖现有卡片样式
ComponentProvider.override('ToolResultCard', MyStyledCard)

// 3. 注入自定义 Hook
const MyExtension = () => {
  const { messages, sendMessage } = useCopilot()
  // 可以访问完整的对话状态
  return <CustomUI />
}
```

#### Lumii 当前插件系统
- ✅ 有 MCP 工具注册机制
- ❌ 没有 UI 组件注册表（Card Registry）
- ❌ 没有组件覆盖机制
- ❌ 没有暴露 Hook 给外部插件

---

## 三. 对标项目分析

### 3.1 vs Vercel AI SDK

| 特性 | CopilotKit | Vercel AI SDK | Lumii |
|------|-----------|---------------|-------|
| **Tool 进度可视化** | ✅ 完整 | ⚠️ 基础 | ❌ 无 |
| **结果即地预览** | ✅ Rich | ⚠️ 需要自己写 | ⚠️ 基础 |
| **流式输出** | ✅ 原生支持 | ✅ 原生支持 | ⚠️ 需改进 |
| **插件系统** | ✅ 完善 | ❌ 无 | ⚠️ 仅工具层 |
| **工作流可视化** | ✅ 看板 | ❌ 无 | ❌ 无 |
| **后台任务管理** | ✅ 有 | ⚠️ 需要自己做 | ✅ 有 |

### 3.2 vs Langchain UI

| 特性 | LangChain UI | Lumii |
|------|-------------|-------|
| **代理可视化** | 基于 Langraph，DAG 图展示 | 对话形式 |
| **工具执行跟踪** | 完整的执行树 | 卡片列表 |
| **交互性** | 可重试、可调试 | 基础 |
| **定制性** | 高（基于 Python） | 中等 |

---

## 四. Lumii 适配方案

### 4.1 短期优化（1-2周）

#### 方案 A: 增强后台任务卡片

```typescript
// 增强后的任务卡片状态
type EnhancedBackgroundTask = BackgroundTask & {
  progress?: number;              // 0-100%
  phase?: 'queued' | 'running' | 'streaming' | 'rendering' | 'done' | 'error';
  logs?: Array<{                  // 实时日志
    level: 'info' | 'debug' | 'error';
    message: string;
    timestamp: number;
  }>;
  milestones?: Array<{            // 关键步骤
    name: string;
    status: 'pending' | 'done' | 'error';
    duration?: number;
  }>;
};
```

**UI 改动**:
- Header 显示进度条 `[====>    ] 45%`
- 中间显示当前步骤 `正在处理第 3/7 个文件`
- 底部有"展开日志"，展开后显示实时日志流
- 右上角"日志导出"快捷按钮

**工作量**: ~3 天（前端 2d + 后端适配 1d）

---

#### 方案 B: 结果预览面板

```typescript
type ResultPreviewConfig = {
  kind: 'image' | 'video' | 'table' | 'code' | 'chart' | 'markdown';
  inline?: boolean;           // 在消息内展示还是浮窗
  actions?: ('view' | 'download' | 'copy' | 'edit')[];
  theme?: 'light' | 'dark';
};
```

**UI 改动**:
- 图片产出：Lightbox 预览（可放大/缩小）+ 下载按钮
- 视频产出：HTML5 播放器 + 进度条 + 下载
- 表格/数据：嵌入表格组件，可排序筛选
- 代码/文本：语法高亮 + 行号 + 复制 + 格式转换

**工作量**: ~4-5 天（UI 组件开发 3d + 集成 1-2d）

---

### 4.2 中期架构（3-4周）

#### 方案 C: Card Registry 系统

```typescript
// 新增卡片注册表
interface CardRegistryEntry {
  type: string;
  component: React.ComponentType<{
    data: unknown;
    actions: string[];
  }>;
  validate?: (data: unknown) => boolean;
  priority?: number;  // 高优先级卡片优先匹配
}

class CardRegistry {
  static register(entry: CardRegistryEntry) { }
  static getComponent(data: unknown) { }
  static override(type: string, newComponent) { }
}
```

**实施步骤**:
1. 定义 Registry 数据结构 (1d)
2. 迁移现有卡片到 Registry (2d)
3. 开放插件注册接口 (1d)
4. 编写文档与示例 (1d)

**效果**: 允许用户定制 Agent 输出的渲染方式

---

#### 方案 D: 工作流看板化

```typescript
type AgentTaskSnapshot = {
  agentId: string;
  agentName: string;
  status: 'idle' | 'running' | 'waiting' | 'done';
  tasks: Array<{
    taskId: string;
    name: string;
    status: 'pending' | 'running' | 'done' | 'error';
    progress?: number;
    duration?: number;
    logs?: string[];
  }>;
  parentTaskId?: string;  // 如果在并行中，指向父任务
};
```

**UI 设计**:
- 侧栏新增"看板"视图（并行于对话流）
- 纵向按 Agent，横向按执行时间轴
- 鼠标 hover 显示任务详情（日志、输入/输出）
- 点击任务可在对话流中定位到对应消息

**工作量**: ~5-6 天（前端看板组件 3d + 后端数据适配 2-3d）

---

### 4.3 长期愿景（1-2个月）

#### 方案 E: 完整插件系统升级

```typescript
// 插件清单
interface LumiiPlugin {
  id: string;
  version: string;
  
  // UI 扩展
  uiExtensions?: {
    cards?: CardRegistryEntry[];
    components?: {
      sidePanelWidgets?: React.ComponentType[];
      floatingButtons?: FloatingButtonConfig[];
      dialogs?: DialogConfig[];
    };
    hooks?: Hook[];
  };
  
  // 工具扩展
  tools?: ToolDefinition[];
  
  // 配置扩展
  config?: PluginConfig;
}

// 插件加载器
class PluginLoader {
  async load(pluginUrl: string): Promise<LumiiPlugin>;
  async registerAll(plugins: LumiiPlugin[]): Promise<void>;
}
```

**分阶段实施**:
- P0: Card Registry + 基础工具注册 (已做)
- P1: Hook 暴露给插件 (新增)
- P2: 浮窗组件注册 (新增)
- P3: 对话助手插件 (新增)
- P4: 沙箱隔离 + 权限管理 (新增)

---

## 五. 参考设计与代码示例

### 5.1 状态可视化完整示例

```typescript
// components/EnhancedTaskCard.tsx
import React, { useEffect, useState } from 'react'

interface TaskLog {
  level: 'info' | 'debug' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

interface EnhancedTaskCardProps {
  taskId: string;
  title: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  progress?: number;          // 0-100
  currentPhase?: string;      // "正在处理第 3/7 个文件"
  logs?: TaskLog[];
  outputs?: Array<{ kind: string; name: string; url?: string }>;
}

const EnhancedTaskCard: React.FC<EnhancedTaskCardProps> = ({
  taskId,
  title,
  status,
  progress,
  currentPhase,
  logs = [],
  outputs = [],
}) => {
  const [expandedLogs, setExpandedLogs] = useState(false);
  
  const running = status === 'running';
  const [displayLogs, setDisplayLogs] = useState<TaskLog[]>(logs);

  // 实时日志流
  useEffect(() => {
    if (running) {
      const interval = setInterval(() => {
        // 订阅新日志
        // const newLogs = await fetchLogs(taskId)
        // setDisplayLogs(newLogs)
      }, 500);
      return () => clearInterval(interval);
    }
  }, [running, taskId]);

  return (
    <div className="enhanced-task-card">
      <div className="card-header">
        <StatusIcon status={status} />
        <div className="header-content">
          <h4 className="title">{title}</h4>
          {currentPhase && <p className="phase">{currentPhase}</p>}
        </div>
      </div>

      {progress !== undefined && (
        <div className="progress-bar">
          <div className="fill" style={{ width: `${progress}%` }} />
          <span className="percent">{progress}%</span>
        </div>
      )}

      {expandedLogs && displayLogs.length > 0 && (
        <div className="logs-panel">
          {displayLogs.map((log, idx) => (
            <div key={idx} className={`log-line log-${log.level}`}>
              <span className="level">{log.level.toUpperCase()}</span>
              <span className="time">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <span className="message">{log.message}</span>
            </div>
          ))}
        </div>
      )}

      {outputs.length > 0 && (
        <div className="outputs">
          {outputs.map((out) => (
            <ResultPreview key={`${out.kind}:${out.name}`} output={out} />
          ))}
        </div>
      )}

      <div className="card-footer">
        <button
          onClick={() => setExpandedLogs(!expandedLogs)}
          className="btn-toggle-logs"
        >
          {expandedLogs ? '隐藏' : '展开'}日志 ({displayLogs.length})
        </button>
        <button className="btn-export-logs">导出</button>
      </div>
    </div>
  );
};

export { EnhancedTaskCard };
```

### 5.2 Card Registry 实现

```typescript
// systems/CardRegistry.ts
type CardComponent = React.ComponentType<{ data: unknown; actions: string[] }>;

interface CardRegistryEntry {
  type: string;
  component: CardComponent;
  validate?: (data: unknown) => boolean;
  priority?: number;
}

class CardRegistry {
  private static entries: Map<string, CardRegistryEntry> = new Map();

  static register(entry: CardRegistryEntry) {
    this.entries.set(entry.type, entry);
  }

  static getComponent(data: unknown): CardComponent | null {
    // 按 priority 排序，找到第一个 validate 通过的
    const sorted = Array.from(this.entries.values()).sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
    );

    for (const entry of sorted) {
      if (!entry.validate || entry.validate(data)) {
        return entry.component;
      }
    }
    return null;
  }

  static override(type: string, component: CardComponent) {
    const entry = this.entries.get(type);
    if (entry) {
      this.entries.set(type, { ...entry, component });
    }
  }
}

// 内置卡片注册
CardRegistry.register({
  type: 'code',
  component: CodeCardComponent,
  validate: (data) => data?.language && data?.code,
  priority: 10,
});

CardRegistry.register({
  type: 'image',
  component: ImageCardComponent,
  validate: (data) => /^data:image|https?:.*\.(jpg|png|gif)/.test(data?.url),
  priority: 9,
});

// 用户自定义插件可以这样扩展
export { CardRegistry };
```

---

## 六. 实施路线图

```timeline
第 1 周 (短期 - 快速赢)
├─ 📝 需求澄清与设计评审
├─ 🎨 UI 草图与原型
└─ ✅ Review

第 2 周 (短期 - 开发)
├─ 🔧 EnhancedTaskCard 开发 (方案 A)
├─ 🖼️  ResultPreview 面板 (方案 B)
└─ ✅ 集成 + 测试

第 3 周 (中期 - 架构)
├─ 📦 Card Registry 系统设计 (方案 C)
├─ 🎯 工作流看板原型 (方案 D)
└─ ✅ MVP 版本

第 4 周 (中期 - 实施)
├─ 🔨 Card Registry 完整实现
├─ 📊 看板化 UI 开发
├─ 📚 文档与示例
└─ ✅ Beta 版本发布

第 5-8 周 (长期 - 生态)
├─ 🧩 插件系统升级 (方案 E)
├─ 🔒 权限与沙箱
├─ 🎓 插件开发者文档
└─ ✅ GA 版本
```

---

## 七. 成本-收益分析

| 方案 | 工作量 | 收益 | 优先级 |
|------|--------|------|--------|
| A: 任务进度增强 | 3d | 用户看得清楚 Agent 在做什么 | **P0** |
| B: 结果预览 | 4-5d | 不用打开多个窗口看产出物 | **P0** |
| C: Card Registry | 5d | 允许插件定制输出渲染 | P1 |
| D: 工作流看板 | 5-6d | 看清 Agent 团队的并行进度 | P1 |
| E: 完整插件系统 | 15-20d | 第三方生态 | P2 |

---

## 八. 关键技术决策

### 决策 1: 日志实时性
**问题**: 后台任务运行中，日志是拉取还是推送？
**方案**: 优先推送 (WebSocket)，降级轮询 (HTTP polling)
**理由**: 实时性好，但会增加后端复杂度；轮询成本低，延迟可控 (500ms)

### 决策 2: 结果格式
**问题**: 产出物是固定类型列表，还是动态判断？
**方案**: 两层：基础类型列表 + Card Registry 二次识别
**理由**: 向后兼容，同时支持插件扩展

### 决策 3: 插件隔离
**问题**: 插件代码是否需要沙箱隔离？
**方案**: MVP 版信任用户插件，后续引入 Web Worker 隔离
**理由**: 快速上线，迭代时再加安全

---

## 九. 用户体验对标

### 现状（Lumii 当前）
```
用户: "帮我生成一个视频"
System: 发送请求 → 等待... → 等待... → 
"完成！点击查看" → 打开新窗口 → 下载 → 看视频
```

### 目标（优化后）
```
用户: "帮我生成一个视频"

System: [Agent-1]
  准备参数... ✓
  启动模型... 🔄
  
  日志:
  [14:23:15] 模型已加载
  [14:23:16] 开始推理...
  [14:23:45] 中断检查点... (45%)

视频产出:
┌─────────────────┐
│ 预览视频        │
│ [播放] [下载]   │
└─────────────────┘
```

---

## 十. 相关文档与资源

### CopilotKit 官方参考
- Repo: https://github.com/CopilotKit/CopilotKit
- Docs: https://copilotkit.ai/docs
- Components: `/packages/react-ui/` (组件库)
- Hooks: `/packages/react-core/` (核心 Hook)

### Lumii 相关代码
- 后台任务卡片: `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/`
- Agent 运行时: `apps/windows/src/renderer/hooks/business/useAgentRuntime/`
- 消息流: `apps/windows/src/renderer/pages/ChatPage/components/ChatMessage/`

### 参考实现
- Vercel AI SDK: https://github.com/vercel/ai
- LangChain: https://github.com/langchain-ai/langchain
- Flowise: https://github.com/FlowiseAI/Flowise (开源 LLM UI)

---

## 十一. 建议的后续研究方向

1. **用户调研** - 5-10 个 Lumii 用户，了解当前 Agent 工作流的痛点
2. **竞品分析** - 深入对标 Cursor AI、Replit Agent 的交互设计
3. **可访问性** - 确保增强的 UI 符合 WCAG 标准（屏幕阅读器等）
4. **移动端适配** - 看板化设计如何在手机上展现

---

## 结论

CopilotKit 的核心价值在于**分层交互与即时反馈**的组合。Lumii 已有良好的后台任务基础，只需：

1. **短期** (2 周): 增强任务进度显示 + 结果预览
2. **中期** (1 个月): Card Registry + 工作流看板
3. **长期** (2 个月+): 完整插件生态

这样可以让 Agent 工作流从"对话框"升级到"可视化看板"，用户体验质的飞跃。

