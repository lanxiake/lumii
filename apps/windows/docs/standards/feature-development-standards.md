# Windows 应用功能开发标准文档

> 文档版本: 1.0
> 基于项目实际代码结构整理
> 适用范围: apps/windows 项目

---

## 1. 项目架构概览

### 1.1 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| 框架 | Electron | 28.1.3 |
| UI 库 | React | 18.2.0 |
| 语言 | TypeScript | 5.3.3 |
| 构建工具 | electron-vite | 2.0.0 |
| 测试框架 | Vitest | 2.1.9 |
| 状态管理 | React Context + Hooks | - |
| 样式 | CSS + CSS 变量 + CSS Modules | - |

### 1.2 进程架构

```
Electron App
├── Main Process (Node.js)
│   ├── 窗口管理
│   ├── WebSocket 连接
│   ├── 文件系统操作
│   ├── 自动更新
│   └── 系统托盘
├── Renderer Process (React)
│   ├── UI 渲染
│   ├── 状态管理
│   └── 用户交互
└── Preload Script
    └── IPC 桥接（安全隔离）
```

### 1.3 目录结构

```
src/
├── main/                    # 主进程代码
│   ├── index.ts            # 主进程入口
│   ├── gateway-client.ts   # 网关 WebSocket 客户端
│   ├── node-connection.ts  # Node 模式连接
│   ├── api-client.ts       # HTTP API 客户端
│   ├── connection/         # 连接管理模块
│   ├── device-pairing-service.ts      # 设备配对服务
│   ├── directory-manager.ts   # 目录管理服务
│   ├── exec-approvals-manager.ts      # 执行审批管理器
│   ├── file-logger.ts         # 文件日志服务
│   ├── logger.ts              # 日志服务
│   ├── node-mode-coordinator.ts # Node 模式协调器
│   ├── python-runner.ts       # Python 运行器
│   ├── security-utils.ts      # 安全工具
│   ├── shell-runner.ts        # Shell 运行器
│   ├── skill-*.ts             # 技能运行时模块（15+ 文件）
│   ├── stubs/                 # 主进程存根模块
│   ├── system-service.ts      # 系统服务
│   ├── tray-manager.ts        # 系统托盘管理
│   ├── ts-runner.ts           # TypeScript 运行器
│   ├── updater-service.ts     # 自动更新服务
│   └── types/                 # 主进程类型定义
│       └── skill-metadata.ts  # 技能元数据类型
├── preload/                # 预加载脚本
│   └── index.ts            # IPC 桥接实现（~1400+ 行）
└── renderer/               # 渲染进程（React 应用）
    ├── App.tsx             # 根组件
    ├── main.tsx            # React 入口
    ├── components/         # React 组件
    │   ├── business/       # 业务组件
    │   │   ├── ApprovalSettings/
    │   │   ├── ConnectionStatus/
    │   │   ├── CreditsView/
    │   │   ├── DeviceCard/
    │   │   ├── DualConnectionStatus/
    │   │   ├── ExecDenylistManager/
    │   │   ├── index.ts
    │   │   ├── SkillCard/
    │   │   ├── SkillStoreView/
    │   │   ├── SubscriptionView/
    │   │   ├── SystemStatus/
    │   │   └── UpdaterView/
    │   ├── layout/         # 布局组件
    │   │   ├── MainLayout/
    │   │   ├── Sidebar/
    │   │   └── TitleBar/
    │   ├── Router.tsx      # 视图路由
    │   ├── GlobalModals.tsx         # 全局模态框
    │   ├── DeviceBindWizard.tsx     # 设备绑定向导
    │   ├── WorkspaceWizard.tsx      # 工作空间向导
    │   └── ui/             # UI 基础组件
    │       ├── Avatar/
    │       ├── Badge/
    │       ├── Button/
    │       ├── Card/
    │       ├── Checkbox/
    │       ├── Divider/
    │       ├── Empty/
    │       ├── ErrorBanner/
    │       ├── Input/
    │       ├── Loading/
    │       ├── Modal/
    │       ├── PageHeader/
    │       ├── Radio/
    │       ├── Responsive/
    │       ├── Select/
    │       ├── Skeleton/
    │       ├── Switch/
    │       ├── Table/
    │       ├── Tag/
    │       ├── Toast/
    │       └── Tooltip/
    ├── contexts/                       # React Context
    │   ├── AppProviders.tsx            # Provider 组合
    │   ├── AuthContext/                # 认证状态
    │   ├── ConnectionContext/          # 连接状态
    │   ├── SettingsContext/            # 应用设置
    │   ├── SkillsContext/              # 技能状态
    │   ├── ThemeContext/               # 主题管理
    │   └── ... (6 contexts)
    ├── hooks/                          # 自定义 Hooks
    │   ├── common/                     # 通用 Hooks
    │   │   ├── useAsync/
    │   │   ├── useDebounce/
    │   │   ├── useLocalStorage/
    │   │   ├── useMutation/
    │   │   ├── usePagination/
    │   │   ├── usePolling/
    │   │   └── useQuery/
    │   └── business/                   # 业务 Hooks
    │       ├── useAgents/
    │       ├── useAuditLog/
    │       ├── useAuth/
    │       ├── useChat/
    │       ├── useCredits/
    │       ├── useDashboard/
    │       ├── useExecApprovals/
    │       ├── useFiles/
    │       ├── useGateway/
    │       ├── useMemories/
    │       ├── useServerCaptcha/
    │       ├── useSettings/
    │       ├── useSkills/
    │       ├── useSkillStore/
    │       ├── useSubagentRuns/
    │       ├── useSubscription/
    │       ├── useSystem/
    │       ├── useSystemMonitor/
    │       ├── useUserMemory/
    │       └── useWorkspace/
    ├── pages/                          # 页面组件
    │   ├── AccountPage/                # 账户管理 (订阅+积分合并)
    │   ├── AgentsPage/                 # Agent 管理
    │   ├── AuthPage/                   # 登录认证
    │   ├── AuditLogPage/               # 审计日志
    │   ├── ChatPage/                   # 对话界面
    │   ├── CreditsPage/                # 积分管理
    │   ├── DashboardPage/              # 概览仪表板
    │   ├── DevicesPage/                # 设备管理
    │   ├── FilesPage/                  # 工作空间文件
    │   ├── MemoriesPage/               # 记忆管理
    │   ├── SettingsPage/               # 应用设置
    │   ├── SkillsPage/                 # 技能管理
    │   ├── SubscriptionPage/           # 订阅管理
    │   ├── SystemPage/                 # 系统监控
    │   ├── TaskBoardPage/              # 任务看板
    │   └── index.ts                    # 页面导出
    ├── services/                       # API 服务层
    │   ├── __tests__/
    │   ├── agent-service.ts
    │   ├── auth-service.ts
    │   ├── chat-service.ts
    │   ├── file-service.ts
    │   ├── gateway-service.ts
    │   ├── index.ts
    │   ├── skill-service.ts
    │   ├── subscription-service.ts
    │   ├── system-service.ts
    │   ├── user-memory-service.ts
    │   └── ... (11+ services)
    ├── styles/                         # 样式文件
    │   ├── global.css                  # 全局样式
    │   ├── tokens.css                  # CSS 变量
    │   └── tokens/                     # TypeScript 设计令牌
    │       ├── colors.ts
    │       ├── spacing.ts
    │       ├── typography.ts
    │       ├── shadows.ts
    │       ├── radius.ts
    │       ├── transitions.ts
    │       ├── z-index.ts
    │       └── breakpoints.ts
    ├── test/                           # 测试文件
    │   ├── __tests__/
    │   │   ├── CreditsPage.test.tsx
    │   │   └── SubscriptionPage.test.tsx
    │   ├── components/
    │   ├── hooks/
    │   ├── README logout.md
    │   ├── README-memory.md
    │   ├── services/
    │   └── setup.ts
    └── types/                          # TypeScript 类型
        ├── user.ts
        ├── skill.ts
        ├── file.ts
        ├── system.ts
        ├── gateway.ts
        └── chat.ts
```

---

## 2. 代码组织规范

### 2.1 文件命名规范

| 类型 | 命名规范 | 示例 |
|------|----------|------|
| 组件 | PascalCase | `DashboardPage.tsx` |
| Hooks | camelCase + use 前缀 | `useDashboard.ts` |
| 类型 | camelCase + .types.ts | `dashboard.types.ts` |
| 样式 | kebab-case | `dashboard-page.css` |
| 工具函数 | camelCase | `formatDate.ts` |
| 常量 | UPPER_SNAKE_CASE | `API_ENDPOINTS.ts` |

### 2.2 文件组织结构

**组件文件** (使用 CSS Modules):
```
ComponentName/
├── ComponentName.tsx       # 组件实现（必需）
├── ComponentName.module.css # 组件样式（CSS Modules, 必需）
├── ComponentName.test.tsx  # 组件测试（可选）
├── types.ts                # 组件类型（如复杂）
└── index.ts                # 导出文件（必需）
```

**Hooks 文件**:
```
useFeature/
├── useFeature.ts           # Hook 实现
├── useFeature.types.ts     # 类型定义
├── useFeature.test.ts      # 测试
└── index.ts                # 导出
```

### 2.3 导入顺序规范

```typescript
// 1. React 导入
import React, { useState, useEffect } from 'react';

// 2. 第三方库导入
import { format } from 'date-fns';
import { debounce } from 'lodash';

// 3. UI 组件导入
import { Button, Input, Card } from '@/components/ui';

// 4. 业务组件导入
import { DashboardHeader } from '@/components/business';

// 5. Hooks 导入
import { useAuth } from '@/hooks/business/useAuth';
import { useQuery } from '@/hooks/common/useQuery';

// 6. 类型导入
import type { User, DashboardData } from '@/types';

// 7. 样式导入
import './DashboardPage.css';
```

---

## 3. TypeScript 规范

### 3.1 类型定义位置

**全局类型**: `src/renderer/types/*.ts`
- `user.ts` - 用户相关类型
- `skill.ts` - 技能相关类型
- `file.ts` - 文件相关类型
- `system.ts` - 系统相关类型
- `gateway.ts` - 网关相关类型
- `chat.ts` - 聊天相关类型

**组件/Hook 专属类型**: 与实现文件同级，命名为 `*.types.ts`

### 3.2 接口命名规范

```typescript
// Props 接口
interface ComponentNameProps {
  // ...
}

// Hook 返回类型
interface UseFeatureReturn {
  // ...
}

// API 请求/响应类型
interface ApiRequestBody {
  // ...
}

interface ApiResponse {
  // ...
}
```

### 3.3 类型导出规范

```typescript
// 默认导出组件
export const ComponentName: React.FC<ComponentNameProps> = () => {};

// 命名导出类型
export type { ComponentNameProps };

// 导出 Hook
export { useFeature } from './useFeature';
export type { UseFeatureReturn } from './useFeature.types';
```

---

## 4. 状态管理规范

### 4.1 Context 创建规范

**文件位置**: `src/renderer/contexts/ContextName/`

```typescript
// types.ts
export interface ContextType {
  state: State;
  actions: Actions;
}

// Context.tsx
import { createContext } from 'react';
import type { ContextType } from './types';

export const ContextName = createContext<ContextType | undefined>(undefined);

// Provider.tsx
export const ContextNameProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // 实现
};

// useContext.ts
export const useContextName = () => {
  const context = useContext(ContextName);
  if (!context) {
    throw new Error('useContextName must be used within ContextNameProvider');
  }
  return context;
};

// index.ts
export { ContextNameProvider } from './Provider';
export { useContextName } from './useContext';
export type { ContextType } from './types';
```

### 4.2 现有 Context 清单

| Context | 路径 | 用途 |
|---------|------|------|
| AuthContext | `contexts/AuthContext/` | 认证状态管理 |
| ConnectionContext | `contexts/ConnectionContext/` | 网关连接状态 |
| SettingsContext | `contexts/SettingsContext/` | 应用设置 |
| ThemeContext | `contexts/ThemeContext/` | 主题管理 |
| SkillsContext | `contexts/SkillsContext/` | 技能状态 |

### 4.3 Hook 开发规范

**通用 Hook 位置**: `src/renderer/hooks/common/`

**业务 Hook 位置**: `src/renderer/hooks/business/`

**Hook 模板**:
```typescript
// useFeature.ts
import { useState, useEffect, useCallback } from 'react';
import type { UseFeatureReturn, FeatureData } from './useFeature.types';

export const useFeature = (): UseFeatureReturn => {
  const [data, setData] = useState<FeatureData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 获取数据
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const clearError = useCallback(() => setError(null), []);

  return {
    data,
    loading,
    error,
    refresh: fetchData,
    clearError,
  };
};
```

**Hook 返回规范**:
```typescript
interface UseFeatureReturn {
  data: FeatureData | null;        // 数据
  loading: boolean;                // 加载状态
  error: Error | null;             // 错误对象
  refresh: () => Promise<void>;    // 刷新方法
  clearError: () => void;          // 清除错误
}
```

---

## 5. 服务层规范

### 5.1 服务层位置

位置: `src/renderer/services/`

### 5.2 现有服务清单

| 服务 | 文件 | 用途 |
|------|------|------|
| AuthService | `auth-service.ts` | 认证相关 API |
| SkillService | `skill-service.ts` | 技能管理 API |
| FileService | `file-service.ts` | 文件操作 API |
| SystemService | `system-service.ts` | 系统监控 API |
| GatewayService | `gateway-service.ts` | 网关连接 API |
| ChatService | `chat-service.ts` | 聊天相关 API |

### 5.3 服务实现规范

```typescript
// services/feature-service.ts
import { apiClient } from '@/utils/apiClient';
import type { FeatureData, FeatureParams } from '@/types/feature';

export const featureService = {
  async getAll(): Promise<FeatureData[]> {
    const response = await apiClient.get('/features');
    return response.data;
  },

  async getById(id: string): Promise<FeatureData> {
    const response = await apiClient.get(`/features/${id}`);
    return response.data;
  },

  async create(params: FeatureParams): Promise<FeatureData> {
    const response = await apiClient.post('/features', params);
    return response.data;
  },

  async update(id: string, params: Partial<FeatureParams>): Promise<FeatureData> {
    const response = await apiClient.patch(`/features/${id}`, params);
    return response.data;
  },

  async delete(id: string): Promise<void> {
    await apiClient.delete(`/features/${id}`);
  },
};
```

---

## 6. IPC 通信规范

### 6.1 IPC 架构

**Preload 脚本**: `src/preload/index.ts`

**通信模式**:
- `invoke/handle` - 请求/响应（异步）
- `send/on` - 事件发布/订阅

### 6.2 IPC 命名规范

**通道名称格式**: `domain:action`

```typescript
// 命名示例
'gateway:connect'
'gateway:disconnect'
'gateway:sendMessage'
'file:open'
'file:save'
'system:getInfo'
```

### 6.3 IPC 实现规范

**Preload 暴露**:
```typescript
// preload/index.ts
contextBridge.exposeInMainWorld('electronAPI', {
  gateway: {
    connect: (url: string, options: ConnectOptions) => 
      ipcRenderer.invoke('gateway:connect', url, options),
    disconnect: () => 
      ipcRenderer.invoke('gateway:disconnect'),
    onMessage: (callback: (message: Message) => void) => 
      ipcRenderer.on('gateway:message', (_, message) => callback(message)),
  },
  // ...
});
```

**主进程处理**:
```typescript
// main/index.ts
ipcMain.handle('gateway:connect', async (event, url: string, options: ConnectOptions) => {
  try {
    await gatewayClient.connect(url, options);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
```

**渲染进程使用**:
```typescript
// 组件中使用
const connect = async () => {
  const result = await window.electronAPI.gateway.connect(url, options);
  if (!result.success) {
    showError(result.error);
  }
};
```

### 6.4 IPC 类型定义

位置: `src/renderer/types/electron.d.ts`

```typescript
declare global {
  interface Window {
    electronAPI: {
      gateway: {
        connect: (url: string, options: ConnectOptions) => Promise<ConnectResult>;
        disconnect: () => Promise<void>;
        onMessage: (callback: (message: Message) => void) => void;
      };
      // ...
    };
  }
}
```

---

## 7. 错误处理规范

### 7.1 错误处理层级

```
API 层 → 服务层 → Hook 层 → 组件层
```

### 7.2 错误类型

```typescript
// 应用错误基类
class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// 具体错误类型
class NetworkError extends AppError {
  constructor(message = '网络连接失败') {
    super(message, 'NETWORK_ERROR');
  }
}

class ValidationError extends AppError {
  constructor(message = '数据验证失败') {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

class PermissionError extends AppError {
  constructor(message = '权限不足') {
    super(message, 'PERMISSION_ERROR', 403);
  }
}

class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super(message, 'NOT_FOUND_ERROR', 404);
  }
}

class ConflictError extends AppError {
  constructor(message = '资源冲突') {
    super(message, 'CONFLICT_ERROR', 409);
  }
}
```

### 7.3 错误处理模式库

#### 7.3.1 错误包装模式

```typescript
// 在服务层包装底层错误
async function fetchUserData(userId: string): Promise<User> {
  try {
    const response = await apiClient.get(`/users/${userId}`);
    return response.data;
  } catch (error) {
    // 包装网络错误
    if (error instanceof NetworkError) {
      throw new AppError(
        `无法获取用户 ${userId} 的数据`,
        'FETCH_USER_FAILED',
        error.statusCode
      );
    }
    
    // 包装验证错误
    if (error instanceof ValidationError) {
      throw new AppError(
        `用户数据验证失败: ${error.message}`,
        'USER_VALIDATION_FAILED',
        400
      );
    }
    
    // 重新抛出已知的应用错误
    if (error instanceof AppError) {
      throw error;
    }
    
    // 包装未知错误
    throw new AppError(
      '获取用户数据时发生未知错误',
      'UNKNOWN_ERROR'
    );
  }
}
```

#### 7.3.2 错误降级模式

```typescript
// 在Hook中实现错误降级
const useUserProfile = (): UseUserProfileReturn => {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  
  const fetchProfile = useCallback(async (userId: string) => {
    setLoading(true);
    setError(null);
    
    try {
      const profileData = await userService.getProfile(userId);
      setProfile(profileData);
    } catch (err) {
      // 尝试从缓存获取降级数据
      const cachedProfile = await userService.getCachedProfile(userId);
      if (cachedProfile) {
        setProfile(cachedProfile);
        // 记录但不向用户显示错误
        console.warn('Using cached profile data due to:', err);
        return;
      }
      
      // 只有当没有降级数据时才显示错误
      setError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      setLoading(false);
    }
  }, []);
  
  // ... 其余代码
};
```

#### 7.3.3 错误边界模式

```typescript
// 创建错误边界组件
class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ComponentType<any> },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // 可以在这里上传错误到监控系统
    console.error('Uncaught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const FallbackComponent = this.props.fallback;
      return <FallbackComponent error={this.state.error} />;
    }

    return this.props.children;
  }
}

// 使用错误边界
// 在页面或重要组件周围包裹
/* 
<ErrorBoundary fallback={ErrorFallback}>
  <UserProfilePanel />
</ErrorBoundary>
*/
```

### 7.4 错误显示规范

**必须**使用 `ErrorBanner` 组件：

```typescript
import { ErrorBanner } from '@/components/ui';

const Page: React.FC = () => {
  const { data, error, clearError } = useFeature();

  if (error) {
    return (
      <ErrorBanner 
        message={error.message} 
        code={error.code}
        onRetry={refresh}
        onClose={clearError}
      />
    );
  }
  // ...
};
```

---

## 8. 测试规范

### 8.1 测试配置

**测试框架**: Vitest
**DOM 环境**: jsdom
**测试工具**: @testing-library/react

### 8.2 测试文件位置

- 单元测试: 与被测文件同级，命名 `*.test.ts`
- 集成测试: `src/__tests__/*.test.ts`
- E2E 测试: `e2e/*.spec.ts`

### 8.3 测试命名规范

```typescript
describe('useFeature', () => {
  describe('数据获取', () => {
    it('应该成功获取数据', async () => {
      // 测试代码
    });

    it('应该在网络错误时返回错误', async () => {
      // 测试代码
    });
  });
});
```

### 8.4 组件测试模板

```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { ComponentName } from './ComponentName';

describe('ComponentName', () => {
  const defaultProps = {
    title: 'Test Title',
    onClick: vi.fn(),
  };

  it('应该正确渲染', () => {
    render(<ComponentName {...defaultProps} />);
    expect(screen.getByText('Test Title')).toBeInTheDocument();
  });

  it('点击应该触发 onClick', () => {
    render(<ComponentName {...defaultProps} />);
    fireEvent.click(screen.getByRole('button'));
    expect(defaultProps.onClick).toHaveBeenCalled();
  });
});
```

---

## 9. 性能优化规范

### 9.1 渲染优化

```typescript
// ✅ 使用 memo（适用于纯净组件且渲染开销较大时）
export const ListItem = React.memo<ListItemProps>(({ item }) => {
  return <div>{item.name}</div>;
});

// ✅ 使用 useMemo（适用于计算开销较大且依赖变化不频繁的值）
const sortedItems = useMemo(() => {
  return items.sort((a, b) => a.order - b.order);
}, [items]);

// ✅ 使用 useCallback（适用于作为props传递给子组件的回调函数）
const handleClick = useCallback((id: string) => {
  selectItem(id);
}, [selectItem]);

// ✅ key 使用稳定标识（避免使用数组索引作为key）
{items.map(item => (
  <ListItem key={item.id} item={item} />
))}

// ✅ 使用懒加载和代码分割（路由级和组件级）
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const HeavyChart = lazy(() => import('./components/HeavyChart'));

// 在Suspense边界中使用
<Suspense fallback={<LoadingSpinner />}>
  <DashboardPage />
</Suspense>
```

### 9.2 何时使用性能优化技术

| 优化技术 | 适用场景 | 何时避免使用 |
|----------|----------|--------------|
| React.memo | 组件渲染开销大且props变化不频繁 | 组件渲染开销小或props经常变化 |
| useMemo | 计算开销大且依赖变化不频繁 | 计算开销小或依赖经常变化 |
| useCallback | 回调函数作为props传递给子组件且子组件依赖引用相等性 | 回调函数不作为props传递或子组件不依赖引用相等性 |
| React.lazy/Suspense | 大组件或路由级代码分割 | 小组件或首屏必需组件 |
| virtualized lists (react-window) | 大列表数据（>100项） | 小列表或变化频繁的列表 |

### 9.3 避免常见性能陷阱

```typescript
// ❌ 避免：在render期间创建新对象/数组（会导致子组件不必要的重渲染）
const BadComponent = ({ items }) => {
  // 每次渲染都创建新对象
  const processedItems = items.map(item => ({ ...item, processed: true }));
  return <List items={processedItems} />;
};

// ✅ 正确：使用useMemo缓存计算结果
const GoodComponent = ({ items }) => {
  const processedItems = useMemo(() => {
    return items.map(item => ({ ...item, processed: true }));
  }, [items]); // 只有items变化时才重新计算
  return <List items={processedItems} />;
};

// ❌ 避免：在render期间创建新函数（会导子组件的useMemo/useCallback失效）
const BadComponent2 = ({ onClick }) => {
  // 每次渲染都创建新函数
  const handleClick = () => {
    onClick();
  };
  return <Child onClick={handleClick} />;
};

// ✅ 正确：使用useCallback缓存函数引用
const GoodComponent2 = ({ onClick }) => {
  const handleClick = useCallback(() => {
    onClick();
  }, [onClick]); // 只有onClick变化时才创建新函数
  return <Child onClick={handleClick} />;
};
```

### 9.4 数据获取优化最佳实践

#### 9.4.1 请求去重和合并

```typescript
// 防止重复请求的缓存层
const useQueryWithDeduplication = <T,>(queryKey: QueryKey, queryFn: () => Promise<T>) => {
  const queryClient = useQueryClient();
  
  return useQuery<T>({
    queryKey,
    queryFn,
    // 如果相同的queryKey正在加载，则不重新发起请求
    staleTime: 5 * 60 * 1000, // 5分钟
    // 可以结合状态管理实现请求合并
  });
};

// 在同一时间发起多个相同请求时，只执行一次
const batchRequests = async <T,>(requests: Array<() => Promise<T>>): Promise<T[]> => {
  // 实现请求去重逻辑
  const uniqueRequests = [...new Set(requests.map(req => req.toString()))];
  const promises = uniqueRequests.map(req => req());
  return Promise.all(promises);
};
```

#### 9.4.2 数据缓存策略

```typescript
// 多级缓存策略
const useCachedData = <T,>(key: string, fetchFn: () => Promise<T>, options?: { ttl?: number }) => {
  const [data, setData] = useState<T | null>(null);
  const [timestamp, setTimestamp] = useState<number>(0);
  
  const ttl = options?.ttl ?? 5 * 60 * 1000; // 默认5分钟
  
  useEffect(() => {
    // 1. 首先尝试从localStorage读取
    const cached = localStorage.getItem(key);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.timestamp < ttl) {
        setData(parsed.data);
        setTimestamp(parsed.timestamp);
        return;
      }
    }
    
    // 2. 如果本地缓存失效或不存在，则fetch
    fetchFn().then(result => {
      setData(result);
      setTimestamp(Date.now());
      // 存储到localStorage
      localStorage.setItem(key, JSON.stringify({
        data: result,
        timestamp: Date.now()
      }));
    });
  }, [key, fetchFn, ttl]);
  
  return { data, timestamp };
};
```

#### 9.4.3 分页和虚拟列表

```typescript
// 使用react-window实现虚拟列表
import { FixedSizeList as List } from 'react-window';

const VirtualizedList = ({ items, itemHeight, renderItem }: {
  items: any[];
  itemHeight: number;
  renderItem: (item: any, index: number) => React.ReactNode;
}) => {
  return (
    <List
      height={600} // 可见区域高度
      itemCount={items.length}
      itemSize={itemHeight}
    >
      {({ index, style }) => (
        <div style={style}>
          {renderItem(items[index], index)}
        </div>
      )}
    </List>
  );
};

// 传统分页加载
const usePaginatedQuery = <T,>(fetchPageFn: (page: number) => Promise<T[]>) => {
  const [pages, setPages] = useState<T[][]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  
  const loadMore = useCallback(async (pageNumber: number) => {
    setIsLoading(true);
    try {
      const newData = await fetchPageFn(pageNumber);
      setPages(prev => [...prev, newData]);
      setHasMore(newData.length > 0); // 假设空数组表示没有更多
    } finally {
      setIsLoading(false);
    }
  }, [fetchPageFn]);
  
  return {
    pages: pages.flat(),
    isLoading,
    hasMore,
    loadMore
  };
};
```

### 9.5 常见性能问题诊断工具

1. **React DevTools Profiler**：识别渲染瓶颈
2. **Chrome Performance面板**：分析JS执行和渲染时间
3. **为什么组件重新渲染**：使用`react-addons-update`或自定义hook追踪
4. **网络面板**：检查重复请求和大响应
5. **内存面板**：检查内存泄漏和意外保持的引用

### 9.6 性能预算和监控

- **首次内容绘制 (FCP)**: < 1.5秒
- **最大内容绘制 (LCP)**: < 2.5秒
- **交互到下一个绘制延迟 (INP)**: < 200毫秒
- **总阻塞时间 (TBT)**: < 200毫秒
- **累积布局偏移 (CLS)**: < 0.1

建议在CI中集成Lighthouse CI或WebPageTest进行性能回归测试。

---

## 10. 安全规范

### 10.1 安全原则

1. **永远不要**在渲染进程直接使用 Node.js API
2. **永远不要**在渲染进程暴露敏感信息
3. **总是**通过 Preload 脚本进行 IPC 通信
4. **总是**验证 IPC 输入数据

### 10.2 Preload 安全

```typescript
// ✅ 正确：暴露最小必要接口
contextBridge.exposeInMainWorld('electronAPI', {
  gateway: {
    connect: (url: string) => ipcRenderer.invoke('gateway:connect', url),
  },
});

// ❌ 错误：暴露 ipcRenderer 全部功能
contextBridge.exposeInMainWorld('ipcRenderer', ipcRenderer);
```

### 10.3 输入验证

```typescript
// 验证 IPC 输入
ipcMain.handle('gateway:connect', async (event, url: unknown) => {
  if (typeof url !== 'string') {
    throw new Error('Invalid URL type');
  }
  
  if (!isValidUrl(url)) {
    throw new Error('Invalid URL format');
  }
  
  // 处理逻辑
});
```

---

## 11. Git 提交规范

### 11.1 提交信息格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

### 11.2 提交类型

| 类型 | 说明 |
|------|------|
| feat | 新功能 |
| fix | 修复 bug |
| docs | 文档更新 |
| style | 代码格式（不影响功能）|
| refactor | 重构 |
| test | 测试相关 |
| chore | 构建/工具相关 |

### 11.3 提交示例

```
feat(dashboard): 添加系统监控图表

- 实现 CPU/内存使用率图表
- 添加实时数据更新
- 优化图表响应式布局

Closes #123
```

---

## 12. 开发工作流

### 12.1 启动开发环境

```bash
# 安装依赖
pnpm install

# 启动开发模式（热重载）
pnpm dev

# 运行测试
pnpm test

# 构建生产版本
pnpm build
```

### 12.2 添加新功能步骤

1. **设计阶段**
   - 阅读相关标准文档
   - 查看类似功能实现
   - 确认设计令牌满足需求

2. **开发阶段**
   - 创建功能分支
   - 按规范实现功能
   - 编写单元测试
   - 确保类型正确

3. **验证阶段**
   - 运行全部测试
   - 进行手动测试
   - 代码审查

4. **提交阶段**
   - 遵循提交规范
   - 更新相关文档
   - 合并到主分支

---

## 附录: 检查清单

### 功能开发前检查

- [ ] 阅读本功能开发标准文档
- [ ] 阅读 UI 设计标准文档
- [ ] 确认技术方案
- [ ] 创建功能分支

### 功能开发中检查

- [ ] 遵循文件命名规范
- [ ] 遵循导入顺序规范
- [ ] 使用 TypeScript 严格模式
- [ ] 实现完整的错误处理
- [ ] 添加必要的注释

### 功能开发后检查

- [ ] 代码通过 lint 检查 (`pnpm lint`)
- [ ] 类型检查通过 (`pnpm typecheck`)
- [ ] 单元测试通过 (`pnpm test`)
- [ ] 手动测试通过
- [ ] 文档已更新

---

## 参考文档

- [UI 设计标准](ui-design-standards.md)
- [页面开发模板](page-template.md)
- [项目架构文档](dual-connection-architecture.md)
