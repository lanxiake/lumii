# Lumii 插件化 UI 系统设计规范 v1.0

**版本**: 1.0  
**作者**: Lumii 研究组  
**日期**: 2026-10-23  
**状态**: 草案

---

## 第一章 概述

### 背景

当前 Lumii 的 Agent 工作流展示能力有限：
- Tool 执行结果都是通用的"卡片列表"
- 不同类型的产出物缺少专门的渲染器（图表、3D 模型、数据表等）
- 用户无法为特定场景定制 UI

### 目标

建立一套**零代码插件扩展系统**，让非开发者用户也能：
- 为特定工具类型定制产出物展示方式
- 添加快捷操作（导出、转换、集成）
- 自定义对话流中的组件和交互

### 核心原则

- **开放性**: 开放 UI 注册表，允许第三方贡献
- **隔离性**: 插件不影响核心流程，失败不中断主流程
- **向后兼容**: 不使用插件时，系统正常运行
- **易用性**: 插件开发者只需关注 UI，不需要理解核心架构

---

## 第二章 插件系统架构

### 2.1 四层架构

```
┌─────────────────────────────────────────┐
│  UI 层 (UI Components & Customization)  │
│  - CardRegistry (卡片类型注册)          │
│  - WidgetRegistry (小组件注册)          │
│  - ActionRegistry (快捷操作注册)        │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│  Hook 层 (Business Logic Exposure)      │
│  - useLumiiContext()                    │
│  - useMessageStream()                   │
│  - useAgentState()                      │
│  - useToolExecution()                   │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│  Bus 层 (Event Delivery)                │
│  - plugin:register                      │
│  - plugin:unregister                    │
│  - card:render                          │
│  - action:execute                       │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│  Core 层 (Agent Runtime & Storage)      │
│  - Message Store                        │
│  - Tool Registry                        │
│  - Agent Manager                        │
└─────────────────────────────────────────┘
```

### 2.2 插件加载流程

```
User Actions
    ↓
Plugin Loader
    ├─ Load plugin.json
    ├─ Validate manifest
    ├─ Load component bundle
    ├─ Execute initialization hook
    └─ Register to Registries
        ├─ CardRegistry.register(...)
        ├─ WidgetRegistry.register(...)
        ├─ ActionRegistry.register(...)
        └─ HookRegistry.register(...)
    ↓
Ready for Use
    ├─ User sends message
    ├─ Tool executes
    ├─ CardRegistry.getComponent() → Plugin Card
    ├─ Plugin Card renders with data
    └─ User can interact with custom actions
```

---

## 第三章 核心 API 定义

### 3.1 CardRegistry (卡片注册表)

**目的**: 为不同的工具输出类型注册自定义渲染器

```typescript
// 卡片注册项
interface CardRegistryEntry<T = unknown> {
  // 卡片类型标识
  type: string;
  
  // React 组件
  component: React.ComponentType<CardComponentProps<T>>;
  
  // 数据验证函数（返回 true 时使用这个卡片）
  validate?: (data: unknown) => data is T;
  
  // 优先级（高优先级优先被选中）
  priority?: number;  // 默认 0，建议 0-100
  
  // 元数据
  metadata?: {
    displayName: string;
    description: string;
    tags: string[];
    supportedTools?: string[];  // 适用于哪些工具
  };
}

// 卡片组件 Props
interface CardComponentProps<T = unknown> {
  data: T;
  actions: CardAction[];
  isLoading?: boolean;
  onAction?: (action: CardAction) => Promise<void>;
}

// 卡片支持的动作
type CardAction = 
  | { type: 'copy'; label: string; value: string }
  | { type: 'download'; label: string; url: string }
  | { type: 'export'; label: string; format: 'json' | 'csv' | 'pdf' }
  | { type: 'open'; label: string; url: string }
  | { type: 'custom'; label: string; payload?: unknown };

// API
class CardRegistry {
  // 注册新的卡片类型
  static register<T>(entry: CardRegistryEntry<T>): void;
  
  // 获取最匹配的卡片组件
  static getComponent(data: unknown): React.ComponentType<CardComponentProps> | null;
  
  // 覆盖现有卡片
  static override<T>(type: string, newEntry: Partial<CardRegistryEntry<T>>): void;
  
  // 注销卡片
  static unregister(type: string): void;
  
  // 列出所有已注册的卡片
  static list(): CardRegistryEntry[];
  
  // 事件订阅
  static onRegistered(callback: (entry: CardRegistryEntry) => void): () => void;
  static onUnregistered(callback: (type: string) => void): () => void;
}
```

**示例 - 注册一个图表卡片**:

```typescript
// plugin-chart/index.ts
import { CardRegistry } from 'lumii-ui';
import ChartCard from './ChartCard.tsx';

CardRegistry.register({
  type: 'chart',
  component: ChartCard,
  validate: (data): data is ChartData => {
    return Array.isArray(data?.points) && data?.chartType in CHART_TYPES;
  },
  priority: 50,
  metadata: {
    displayName: '数据图表',
    description: '使用 Plotly 渲染交互式图表',
    tags: ['visualization', 'data'],
    supportedTools: ['generate-chart', 'analyze-data'],
  },
});
```

---

### 3.2 WidgetRegistry (小组件注册表)

**目的**: 在对话流特定位置注入自定义 UI

```typescript
// 小组件注册项
interface WidgetRegistryEntry {
  id: string;
  
  // 小组件位置
  position: 'top-of-chat' | 'bottom-of-chat' | 'agent-panel-top' 
          | 'agent-panel-bottom' | 'sidebar-after-sessions';
  
  // React 组件
  component: React.ComponentType<WidgetProps>;
  
  // 显示条件
  showWhen?: (context: LumiiContext) => boolean;
  
  // 优先级（同一位置多个 widget 时决定顺序）
  priority?: number;
  
  metadata?: {
    displayName: string;
    description: string;
  };
}

interface WidgetProps {
  context: LumiiContext;
  onClose?: () => void;
}

// API
class WidgetRegistry {
  static register(entry: WidgetRegistryEntry): void;
  static unregister(id: string): void;
  static getWidgetsForPosition(position: string): WidgetRegistryEntry[];
}
```

**示例 - 添加一个"今日任务统计"小组件**:

```typescript
WidgetRegistry.register({
  id: 'daily-stats-widget',
  position: 'sidebar-after-sessions',
  component: DailyStatsWidget,
  showWhen: (ctx) => ctx.currentAgent?.isEnabled,
  priority: 10,
  metadata: {
    displayName: '今日统计',
    description: '显示今日执行的任务数和成功率',
  },
});
```

---

### 3.3 ActionRegistry (快捷操作注册表)

**目的**: 为工具结果添加自定义操作按钮

```typescript
// 快捷操作
interface ActionRegistryEntry {
  id: string;
  
  // 操作所属的工具或卡片类型
  targetType: 'tool' | 'card' | '*';
  targetName?: string;  // 如果是 card，则是卡片类型；如果是 tool，则是工具名
  
  // 操作定义
  action: {
    label: string;
    icon?: string;  // 图标 SVG 或 emoji
    description?: string;
    handler: (data: unknown, context: LumiiContext) => Promise<void>;
  };
  
  // 显示条件
  showWhen?: (data: unknown) => boolean;
  
  // 优先级
  priority?: number;
}

class ActionRegistry {
  static register(entry: ActionRegistryEntry): void;
  static unregister(id: string): void;
  static getActionsFor(targetType: string, targetName?: string): ActionRegistryEntry[];
}
```

**示例 - 添加"转发到飞书"操作**:

```typescript
ActionRegistry.register({
  id: 'send-to-feishu',
  targetType: 'card',
  targetName: '*',  // 所有卡片都可以转发
  action: {
    label: '转发到飞书',
    icon: '✈️',
    description: '将结果转发到飞书群组',
    handler: async (data, context) => {
      const { feishuToken, groupId } = context.config.plugins['send-to-feishu'];
      await sendToFeishu(data, feishuToken, groupId);
    },
  },
  priority: 20,
});
```

---

### 3.4 HookRegistry (Hook 暴露)

**目的**: 让插件访问 Lumii 的核心状态和功能

```typescript
// 暴露给插件的 Hook
namespace LumiiHooks {
  // 获取当前上下文
  function useLumiiContext(): LumiiContext;
  
  // 获取消息流
  function useMessageStream(): {
    messages: Message[];
    isLoading: boolean;
    error?: Error;
  };
  
  // 获取 Agent 状态
  function useAgentState(): {
    agents: Agent[];
    currentAgent?: Agent;
    isRunning: boolean;
  };
  
  // 获取当前工具执行状态
  function useToolExecution(toolName: string): {
    isRunning: boolean;
    progress?: number;
    logs: string[];
  };
  
  // 发送消息
  function useSendMessage(): {
    send: (message: string) => Promise<void>;
    isLoading: boolean;
  };
  
  // 订阅事件
  function usePluginEvent(eventName: string): (callback) => () => void;
}

// 在插件中使用
import { useLumiiContext, useMessageStream } from 'lumii-hooks';

export const MyPlugin = () => {
  const context = useLumiiContext();
  const { messages, isLoading } = useMessageStream();
  
  return (
    <div>
      <h3>当前 Agent: {context.currentAgent?.name}</h3>
      <p>消息数: {messages.length}</p>
    </div>
  );
};
```

---

## 第四章 插件开发指南

### 4.1 插件清单 (plugin.json)

```json
{
  "id": "plugin-chart-enhanced",
  "name": "图表增强",
  "version": "1.0.0",
  "description": "为生成的数据图表提供交互式预览和导出功能",
  "author": "Lumii Team",
  "license": "MIT",
  
  "entry": "dist/index.js",
  "styles": "dist/styles.css",
  
  "requirements": {
    "lumii": ">=0.87.0",
    "plugins": ["plugin-core-ui"]
  },
  
  "permissions": {
    "ui": ["card-registry", "widget-registry", "action-registry"],
    "hooks": ["useLumiiContext", "useMessageStream"],
    "network": ["https://api.chart-service.com"],
    "storage": ["plugin-state"]
  },
  
  "capabilities": {
    "cards": ["chart", "table", "heatmap"],
    "widgets": ["chart-stats"],
    "actions": ["export-png", "export-svg", "share-link"]
  },
  
  "config": {
    "schema": {
      "theme": {
        "type": "select",
        "options": ["light", "dark", "auto"],
        "default": "auto"
      },
      "defaultChartType": {
        "type": "select",
        "options": ["line", "bar", "pie", "scatter"],
        "default": "line"
      }
    }
  }
}
```

### 4.2 最小化插件示例

```typescript
// plugins/simple-hello/index.ts
import React from 'react';
import { CardRegistry, WidgetRegistry } from 'lumii-ui';

// 1. 定义卡片组件
const HelloCard: React.FC<{ data: { message: string } }> = ({ data }) => (
  <div style={{ padding: '10px', background: '#f0f0f0', borderRadius: '4px' }}>
    <p>Hello Plugin:</p>
    <p>{data.message}</p>
  </div>
);

// 2. 定义小组件
const HelloWidget: React.FC = () => (
  <div style={{ padding: '10px', color: '#666' }}>
    ✨ Hello 插件已加载
  </div>
);

// 3. 导出初始化函数
export function initialize() {
  // 注册卡片
  CardRegistry.register({
    type: 'hello',
    component: HelloCard,
    validate: (data): data is { message: string } => 
      typeof data?.message === 'string',
    priority: 10,
    metadata: {
      displayName: 'Hello 卡片',
      tags: ['demo'],
    },
  });

  // 注册小组件
  WidgetRegistry.register({
    id: 'hello-widget',
    position: 'sidebar-after-sessions',
    component: HelloWidget,
  });

  console.log('Hello 插件已初始化');
}
```

---

### 4.3 完整插件示例：数据表格

```typescript
// plugins/table-enhanced/TableCard.tsx
import React, { useState } from 'react';
import { useCSVExport } from './hooks';

interface TableData {
  columns: string[];
  rows: unknown[][];
  title?: string;
}

export const TableCard: React.FC<{
  data: TableData;
  actions?: Array<{ type: string; label: string }>;
  onAction?: (action) => Promise<void>;
}> = ({ data, actions = [], onAction }) => {
  const [sortBy, setSortBy] = useState<{ column: number; desc: boolean } | null>(null);
  const { exportCSV, isExporting } = useCSVExport();

  // 排序逻辑
  let displayRows = [...data.rows];
  if (sortBy) {
    displayRows.sort((a, b) => {
      const aVal = a[sortBy.column];
      const bVal = b[sortBy.column];
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortBy.desc ? -cmp : cmp;
    });
  }

  const handleExport = async () => {
    const csv = exportCSV(data.columns, displayRows);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.title || 'export'}.csv`;
    a.click();
  };

  return (
    <div className="table-card">
      {data.title && <h4>{data.title}</h4>}
      
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {data.columns.map((col, idx) => (
                <th
                  key={idx}
                  onClick={() => setSortBy({
                    column: idx,
                    desc: sortBy?.column === idx ? !sortBy.desc : false,
                  })}
                  style={{ cursor: 'pointer' }}
                >
                  {col} {sortBy?.column === idx && (sortBy.desc ? '↓' : '↑')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, ridx) => (
              <tr key={ridx}>
                {row.map((cell, cidx) => (
                  <td key={cidx}>{String(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-actions">
        <button onClick={handleExport} disabled={isExporting}>
          {isExporting ? '导出中...' : '导出 CSV'}
        </button>
        {actions.map((action) => (
          <button
            key={action.type}
            onClick={() => onAction?.(action)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
};

// plugins/table-enhanced/index.ts
import { CardRegistry } from 'lumii-ui';
import { TableCard } from './TableCard';

export function initialize() {
  CardRegistry.register({
    type: 'table',
    component: TableCard,
    validate: (data): data is TableData => 
      Array.isArray(data?.columns) && Array.isArray(data?.rows),
    priority: 50,
    metadata: {
      displayName: '数据表格（增强版）',
      description: '支持排序、筛选、导出 CSV',
      tags: ['table', 'data'],
      supportedTools: ['analyze-csv', 'query-database'],
    },
  });
}
```

---

## 第五章 安全性与隔离

### 5.1 权限模型

```typescript
type Permission = 
  | 'ui:card-registry'        // 注册卡片
  | 'ui:widget-registry'      // 注册小组件
  | 'ui:action-registry'      // 注册操作
  | 'hooks:useLumiiContext'   // 访问上下文
  | 'hooks:useMessageStream'  // 访问消息
  | 'hooks:useAgentState'     // 访问 Agent 状态
  | 'network:*'               // 网络请求（需声明域名）
  | 'storage:plugin-state'    // 本地存储
  | 'exec:tool'               // 执行工具
  | '*';                       // 完全权限

interface PluginManifest {
  permissions: Permission[];
}
```

### 5.2 沙箱隔离 (阶段 2)

当前不实施，但架构预留：

```typescript
// 未来实现
class PluginSandbox {
  // 在 Web Worker 中运行不可信代码
  async executeInWorker(pluginCode: string, permissions: string[]): Promise<void>;
  
  // 拦截和验证所有 API 调用
  validateAPICall(api: string, args: unknown[]): boolean;
}
```

---

## 第六章 部署与发布

### 6.1 插件包结构

```
my-plugin/
├── plugin.json              # 清单
├── src/
│  ├── index.ts             # 主入口
│  ├── components/
│  │  ├── MyCard.tsx
│  │  └── MyWidget.tsx
│  ├── hooks/
│  │  └── useMyPlugin.ts
│  └── styles.css
├── dist/                    # 构建产物
│  ├── index.js
│  └── styles.css
├── README.md
├── LICENSE
└── package.json
```

### 6.2 插件发布流程

1. **本地开发**
   ```bash
   npm install
   npm run dev
   ```

2. **构建**
   ```bash
   npm run build
   ```

3. **上传到 Lumii 插件市场**
   ```bash
   lumii-cli publish --token <API_TOKEN>
   ```

4. **用户安装**
   - 通过 Lumii 设置面板 → 插件市场
   - 或本地加载: `lumii-cli load ./my-plugin`

---

## 第七章 实施路线

### 阶段 1: MVP (第 2-3 周)
- [ ] CardRegistry 系统实现
- [ ] 5 个内置卡片迁移到 Registry
- [ ] 简单的插件加载器（本地文件）
- [ ] 3 个官方示例插件

### 阶段 2: 扩展 (第 4-6 周)
- [ ] WidgetRegistry 实现
- [ ] ActionRegistry 实现
- [ ] HookRegistry 暴露（只读模式）
- [ ] 插件市场前端（仅展示）

### 阶段 3: 生态 (第 7-10 周)
- [ ] 插件市场后端
- [ ] 权限管理 UI
- [ ] 沙箱隔离 (Web Worker)
- [ ] 社区贡献指南发布

---

## 第八章 常见问题

### Q: 插件是否支持 npm 包？
**A**: MVP 不支持，阶段 2 支持通过 unpkg 加载。

### Q: 可以访问用户私密信息吗？
**A**: 可以，但需要权限声明。沙箱隔离后会有更细的控制。

### Q: 插件之间可以相互通信吗？
**A**: 目前不支持。可以通过 EventBus 实现（阶段 3）。

### Q: 如何调试插件？
**A**: Chrome DevTools，支持 source map。

---

## 附录 A: TypeScript 类型定义

见 `/packages/lumii-ui-types/plugin.d.ts`

## 附录 B: 官方示例插件清单

1. `plugin-chart-plotly` - 交互式图表
2. `plugin-table-handsontable` - 高级表格
3. `plugin-code-prism` - 代码高亮与执行
4. `plugin-markdown-remark` - Markdown 预处理
5. `plugin-ai-detect` - AI 内容检测

---

**文档版本**: 1.0  
**最后更新**: 2026-10-23  
**下一次审查**: 2026-11-23

