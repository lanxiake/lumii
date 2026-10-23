# CopilotKit v2 源码分析 - 实现细节补充

**日期**: 2026-10-23  
**来源**: CopilotKit v2 源码深度分析  
**目的**: 为 Lumii 实施提供具体代码参考

---

## 一. Tool Call 渲染系统的三种模式

CopilotKit v2 实现了**三种外观模式**，这对 Lumii 的任务卡片设计有直接参考价值。

### 1.1 核心类型定义

```typescript
// 三种模式选择
type CopilotChatToolCallGroupAppearance = "card" | "line" | "stack";

// 工具调用状态
type CallStatus = "running" | "done" | "failed" | "stopped";

// 状态到图标映射
const STATUS_ICONS = {
  running: Loader2,    // 转圈动画
  done: Check,         // ✓
  failed: X,          // ✗
  stopped: Circle,    // ◯
};
```

### 1.2 Card 模式（默认）

**适用**: 主要展示区域，需要完整信息

```
┌──────────────────────────────────────┐
│ 🔧 run_command ×2, read_file        │
│                                      │
│ 参数: [展开 ▼]                      │
│ 结果: [展开 ▼]                      │
│                                      │
│ 🔄 运行中 (2.34s)                   │
└──────────────────────────────────────┘
```

**特点**:
- 工具名称聚合（`run_command ×2` 表示相同工具调用 2 次）
- 可折叠的参数和结果面板
- 清晰的状态指示

### 1.3 Line 模式（内联）

**适用**: 对话流内嵌入，空间受限

```
🔧 run_command: param1=value1 → ✓ result_summary
```

**特点**:
- 单行显示
- 极度紧凑
- 参数和结果摘要化

### 1.4 Stack 模式（堆叠）

**适用**: 多个工具顺序调用

```
┌──────────────────────┐
│ ✓ tool_1            │
│   结果: done        │
└──────────────────────┘
        ↓
┌──────────────────────┐
│ 🔄 tool_2           │
│   参数: ...         │
└──────────────────────┘
```

**特点**:
- 纵向排列，显示依赖关系
- 每个工具独立折叠/展开
- 箭头连接表示执行顺序

### 1.5 Lumii 适用性

**建议**: 采用 Card 模式作为 Phase 1 基础

```typescript
// Lumii 版本：支持两种模式
type BackgroundTaskCardAppearance = "card" | "compact";

// Card 模式 = 当前的 BackgroundTaskCard
// Compact 模式 = 对话流内嵌时的紧凑版本
```

---

## 二. 上下文感知的自适应渲染

CopilotKit 的关键设计：**组件根据所在位置自动调整**

### 2.1 Context 模式

```typescript
// 创建上下文
const ToolCallGroupContext = createContext<{
  appearance?: CopilotChatToolCallGroupAppearance;
  onExpand?: (toolCallId: string) => void;
  expandedIds?: Set<string>;
}>(null);

// 在 Group 组件内提供
<ToolCallGroupContext.Provider value={{ appearance: "card" }}>
  {toolCalls.map((call) => (
    <ToolCall key={call.id} {...call} />
  ))}
</ToolCallGroupContext.Provider>

// 在子组件中消费
const ToolCall = ({ id, ...props }) => {
  const context = useContext(ToolCallGroupContext);
  const appearance = appearanceProp ?? context?.appearance ?? "card";
  
  return appearance === "card" 
    ? <CardView {...props} />
    : <LineView {...props} />;
};
```

### 2.2 避免嵌套卡片混乱

**问题**: 如果每个工具调用都是完整卡片，会导致视觉过度复杂

```
❌ 不好的设计 (过度嵌套):
┌─────────────────────────────┐
│ 后台任务卡片                │
│ ┌─────────────────────────┐ │
│ │ 工具 1 卡片              │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ 工具 2 卡片              │ │
│ └─────────────────────────┘ │
└─────────────────────────────┘

✅ 好的设计 (自适应):
┌─────────────────────────────┐
│ 后台任务卡片                │
│ • 工具 1 ✓ (结果摘要)       │
│ • 工具 2 🔄 (进行中)       │
└─────────────────────────────┘
```

### 2.3 Lumii 应用

```typescript
// BackgroundTaskCard 中
const TaskLogs: React.FC<{ logs: TaskLog[] }> = ({ logs }) => {
  const context = useContext(TaskContext);
  const isEmbedded = context?.position === 'embedded';
  
  // 嵌入时: 最后 3 条日志 + "查看全部"
  // 独立时: 完整日志列表 + 搜索
  
  if (isEmbedded) {
    return <CompactLogView logs={logs.slice(-3)} />;
  }
  return <FullLogView logs={logs} />;
};
```

---

## 三. 安全的序列化机制

工具输出（参数、结果）可能包含循环引用或不可序列化的对象。

### 3.1 安全字符串化

```typescript
function safeStringify(obj: unknown, depth = 0, maxDepth = 3): string {
  if (depth > maxDepth) {
    return "[Maximum depth exceeded]";
  }

  try {
    if (obj === null) return "null";
    if (typeof obj !== "object") return JSON.stringify(obj);

    // 检测循环引用
    if (obj instanceof Date) return obj.toISOString();
    if (obj instanceof RegExp) return obj.toString();
    if (Array.isArray(obj)) {
      return "[" + obj.map((v) => safeStringify(v, depth + 1, maxDepth)).join(", ") + "]";
    }

    // 对象
    const keys = Object.keys(obj);
    const pairs = keys.map((k) => {
      const val = (obj as Record<string, unknown>)[k];
      return `"${k}": ${safeStringify(val, depth + 1, maxDepth)}`;
    });
    return "{" + pairs.join(", ") + "}";
  } catch (e) {
    return "[Circular reference or non-serializable]";
  }
}

// 使用
const resultJson = safeStringify(toolResult);
// 输出: {"status":"done","data":[1,2,3],"[Maximum depth exceeded]"}
```

### 3.2 Lumii 应用

```typescript
// ResultPreviewPanel 中
export const ResultPreviewPanel: React.FC<{ output: BackgroundTaskOutput }> = 
  ({ output }) => {
  const safeData = useMemo(
    () => safeStringify(output.data),
    [output.data]
  );

  // 如果是代码，直接显示
  // 如果是表格，解析并渲染
  // 否则显示 JSON
};
```

---

## 四. 插件 UI 扩展的 Wildcard 模式

CopilotKit 允许用户注册自定义的工具渲染器。

### 4.1 Hook 接口

```typescript
function useRenderTool(config: {
  toolName?: string | "*";  // "*" 匹配所有工具
  render: (props: {
    name: string;
    toolCallId: string;
    parameters: unknown;
    status: CallStatus;
    result?: unknown;
  }) => React.ReactNode;
}): void;
```

### 4.2 注册示例

```typescript
// 示例 1: 只为特定工具自定义
useRenderTool({
  toolName: "generate_image",
  render: ({ result }) => (
    <div>
      <img src={result.url} />
      <button>下载</button>
    </div>
  ),
});

// 示例 2: 为所有工具添加统一的错误处理
useRenderTool({
  toolName: "*",
  render: ({ name, status, result, parameters }) => {
    if (status === "failed") {
      return <ErrorAlert title={name} error={result} />;
    }
    
    // 默认渲染
    return <DefaultToolView {...} />;
  },
});
```

### 4.3 Lumii 的 CardRegistry 对标

```typescript
// Lumii 版本
CardRegistry.register({
  type: "image",
  component: ImagePreview,
  validate: (data) => data?.url?.match(/\.(jpg|png|gif)/),
  priority: 50,
});

// 等价于 CopilotKit 的 wildcard 注册
useRenderTool({
  toolName: "*",
  render: ({ result }) => {
    const component = CardRegistry.getComponent(result);
    return component ? <component data={result} /> : <DefaultView />;
  },
});
```

---

## 五. 响应式绑定系统（A2UI）

CopilotKit 使用 `useSyncExternalStore` 实现高效的数据绑定。

### 5.1 问题背景

如何在 React 组件中订阅外部状态而不产生性能问题？

```typescript
// ❌ 问题：每次重新订阅时创建新对象
const [toolCalls, setToolCalls] = useState([]);
useEffect(() => {
  const unsubscribe = api.onToolCallsChange((newCalls) => {
    setToolCalls(newCalls); // 导致组件重新渲染
  });
  return () => unsubscribe();
}, []);

// ✅ 解决：使用 useSyncExternalStore
const toolCalls = useSyncExternalStore(
  (callback) => api.subscribe(callback),
  () => api.getSnapshot()
);
```

### 5.2 完整实现

```typescript
import { useSyncExternalStore } from "react";

function GenericBinder({ 
  snapshot, 
  dataModel, 
  Component 
}: {
  snapshot: unknown;
  dataModel: {
    subscribe: (callback: () => void) => () => void;
    getSnapshot: () => unknown;
  };
  Component: React.ComponentType<any>;
}) {
  // 订阅外部状态
  const state = useSyncExternalStore(
    dataModel.subscribe,
    dataModel.getSnapshot
  );

  // 错误边界：状态变化时重新挂载
  const key = useMemo(
    () => JSON.stringify(state),
    [state]
  );

  return (
    <RenderBoundary key={key} snapshot={snapshot}>
      <Component {...state} />
    </RenderBoundary>
  );
}

// DataModel 实现示例
class ToolCallDataModel {
  private listeners: Set<() => void> = new Set();
  private state: ToolCall[] = [];

  subscribe(callback: () => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getSnapshot() {
    return this.state;
  }

  private notify() {
    this.listeners.forEach((cb) => cb());
  }

  updateToolCall(id: string, update: Partial<ToolCall>) {
    const idx = this.state.findIndex((t) => t.id === id);
    if (idx >= 0) {
      this.state[idx] = { ...this.state[idx], ...update };
      this.notify();
    }
  }
}
```

### 5.3 Lumii 应用

```typescript
// Lumii 中使用
const useBackgroundTask = (taskId: string) => {
  const taskModel = useRef(new BackgroundTaskModel(taskId)).current;
  
  return useSyncExternalStore(
    (callback) => taskModel.subscribe(callback),
    () => taskModel.getSnapshot()
  );
};

// 使用组件
const BackgroundTaskCard: React.FC<{ taskId: string }> = ({ taskId }) => {
  const task = useBackgroundTask(taskId);
  
  // 当任务状态变化时自动更新
  return <TaskCardView task={task} />;
};
```

---

## 六. 状态流转映射

CopilotKit 与 Lumii 的状态映射。

### 6.1 工具调用状态

```typescript
// CopilotKit 状态
type CopilotToolCallStatus = 
  | "inProgress"    // 执行中
  | "executing"     // 正在执行
  | "complete"      // 完成
  | "error"         // 错误
  | "canceled";     // 已取消

// 映射到通用状态
type UnifiedStatus = 
  | "running"       // inProgress | executing
  | "done"          // complete
  | "failed"        // error
  | "stopped";      // canceled

// Lumii 状态
type LumiiTaskStatus = 
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

// 转换函数
function copilotToLumii(status: CopilotToolCallStatus): LumiiTaskStatus {
  return {
    "inProgress": "running",
    "executing": "running",
    "complete": "succeeded",
    "error": "failed",
    "canceled": "cancelled",
  }[status] as LumiiTaskStatus;
}
```

---

## 七. 实施建议

### 7.1 Phase 1 中直接可用的设计

```
✅ Card 模式框架
   → 用于 BackgroundTaskCard
   
✅ 上下文感知渲染
   → TaskLogs 的嵌入/展开模式
   
✅ 安全序列化
   → ResultPreviewPanel 的代码显示
   
✅ 状态映射
   → 工具调用状态 → 任务卡片状态
```

### 7.2 Phase 2 中需要的设计

```
✅ Wildcard 插件注册
   → CardRegistry 的实现基础
   
✅ 响应式绑定
   → 实时日志更新的数据模型
```

### 7.3 优先级

```
1. 状态映射 (第 2 周)
   → 复用现有的 CopilotKit 映射表

2. Card 模式 (第 2 周)
   → 直接参考 CopilotChatToolCallGroup 设计

3. 安全序列化 (第 3 周)
   → 在 ResultPreviewPanel 中集成

4. 上下文感知 (Phase 2)
   → CardRegistry 的 validate 和 priority

5. 响应式绑定 (Phase 2)
   → 实时日志流的底层实现
```

---

## 八. 代码清单

### 可直接复用的片段

1. **safeStringify** - 安全序列化工具函数
2. **StatusIcon 映射** - 工具状态到图标的映射
3. **useSyncExternalStore 模式** - 响应式数据绑定
4. **Appearance 模式** - Card/Line/Stack 三种渲染模式

### 需要适配的设计

1. **Context 结构** - 从 ToolCallGroupContext 适配到 TaskContext
2. **Hook 接口** - 从 useRenderTool 适配到 CardRegistry
3. **状态机** - 从 CopilotToolCallStatus 映射到 LumiiTaskStatus

---

## 九. 文档关联

- **主研究文档**: copilotkit-ux-research.md (架构全景)
- **实施指南**: ui-prototypes-and-implementation-guide.md (代码示例)
- **插件规范**: plugin-system-design-spec.md (API 定义)

---

**版本**: 1.0  
**最后更新**: 2026-10-23  
**状态**: 可用于 Phase 1 实施参考

