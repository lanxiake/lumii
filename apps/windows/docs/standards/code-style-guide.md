# Windows 应用代码风格指南

> 文档版本: 1.0
> 编码规范和风格一致性要求

---

## 1. 代码组织原则

### 1.1 单一职责原则

每个文件、函数、组件应该只负责一件事：

```typescript
// ✅ 好的实践：组件职责单一
const UserProfile: React.FC = () => {
  const { user } = useAuth();
  return <div>{user.name}</div>;
};

// ❌ 避免：组件做太多事
const UserDashboard: React.FC = () => {
  const { user } = useAuth();
  const { stats } = useStats();
  const [settings, setSettings] = useState();
  // ... 太多逻辑
};

// 💡 重构建议：将复杂组件拆分为更小的单一职责组件
const UserDashboard: React.FC = () => {
  const { user } = useAuth();
  const { stats } = useStats();
  
  return (
    <div>
      <UserProfile user={user} />
      <UserStats stats={stats} />
      {/* 可以继续拆分其他部分 */}
    </div>
  );
};
```

#### 常见单一职责违规及修复方案
| 违规类型 | 问题描述 | 修复方案 |
|----------|----------|----------|
| UI+Logic混用 | 组件同时包含UI渲染和业务逻辑 | 将业务逻辑移到自定义hook或服务层 |
| 数据获取+展示 | 组件既获取数据又负责展示 | 将数据获取移到容器组件或hook，保持展示组件纯净 |
| 状态管理过多 | 组件管理过多局部状态 | 考虑使用context或状态管理库（如Zustand、Jotai） |

### 1.2 文件大小限制

- **目标**: 单个文件不超过 500 行
- **警告**: 500-700 行需要审查
- **最大**: 不超过 700 行

如果文件过大，考虑拆分为：
- 子组件
- 自定义 Hooks
- 工具函数

---

## 2. 命名规范

### 2.1 文件命名

| 类型 | 规范 | 示例 |
|------|------|------|
| 组件 | PascalCase.tsx | `DashboardPage.tsx` |
| Hook | camelCase.ts | `useDashboard.ts` |
| 类型定义 | camelCase.types.ts | `dashboard.types.ts` |
| 工具函数 | camelCase.ts | `formatDate.ts` |
| 样式文件 (CSS Modules) | kebab-case.module.css | `dashboard-page.module.css` |
| 样式文件 (全局) | kebab-case.css | `dashboard-page.css` |
| 常量文件 | UPPER_SNAKE_CASE.ts | `API_ENDPOINTS.ts` |
| 配置文件 | kebab-case.config.ts | `vite.config.ts` |

### 2.2 变量命名

```typescript
// 常量
const MAX_RETRY_COUNT = 3;
const API_BASE_URL = 'https://api.example.com';

// 变量
let userCount = 0;
let isLoading = false;

// 布尔值 - 使用 is/has/should 前缀
const isActive = true;
const hasPermission = false;
const shouldRetry = true;

// 数组 - 使用复数名词
const users = [];
const selectedItems = [];

// 函数 - 使用动词开头
const fetchData = () => {};
const handleClick = () => {};
const validateInput = () => {};
const formatDate = () => {};

// 回调函数 - 使用 on/handle 前缀
const onSubmit = () => {};
const handleChange = () => {};
```

### 2.3 组件命名

```typescript
// 页面组件 - 以 Page 结尾
const DashboardPage: React.FC = () => {};
const SettingsPage: React.FC = () => {};

// UI 组件 - 描述功能
const Button: React.FC = () => {};
const Modal: React.FC = () => {};
const DataTable: React.FC = () => {};

// 业务组件 - 领域+功能
const DeviceCard: React.FC = () => {};
const ConnectionStatus: React.FC = () => {};
const SkillStoreView: React.FC = () => {};

// 高阶组件 - 以 with 开头
const withAuth = (Component) => {};
const withLoading = (Component) => {};

// Hook - 以 use 开头
const useAuth = () => {};
const useDashboard = () => {};
```

### 2.4 接口命名

```typescript
// Props 接口
interface ButtonProps { }
interface UserCardProps { }

// 类型别名
type ViewType = 'dashboard' | 'chat' | 'settings';
type ButtonVariant = 'primary' | 'secondary' | 'danger';

// 枚举
enum ConnectionStatus {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
}

// 工具类型
type Nullable<T> = T | null;
type Optional<T> = T | undefined;
```

---

## 3. 代码格式规范

### 3.1 缩进和空格

- 使用 2 个空格缩进
- 最大行长度: 100 字符
- 使用单引号
- 语句末尾使用分号

```typescript
// ✅ 正确
const fetchData = async () => {
  const response = await api.get('/data');
  return response.data;
};

// ❌ 错误
const fetchData = async () => {
    const response = await api.get("/data")
    return response.data
}
```

### 3.2 对象和数组格式

```typescript
// 简单对象 - 单行
const user = { id: 1, name: 'John' };

// 复杂对象 - 多行
const config = {
  apiUrl: 'https://api.example.com',
  timeout: 5000,
  retries: 3,
  headers: {
    'Content-Type': 'application/json',
  },
};

// 数组 - 多行（超过 3 项）
const features = [
  'authentication',
  'authorization',
  'logging',
  'monitoring',
];

// 解构 - 多行（超过 2 项）
const {
  id,
  name,
  email,
  role,
} = user;
```

### 3.3 函数格式

```typescript
// 箭头函数 - 简洁
const double = (x: number) => x * 2;

// 箭头函数 - 带逻辑
const calculate = (a: number, b: number) => {
  const sum = a + b;
  return sum * 2;
};

// 函数声明 - 复杂逻辑
function processUserData(
  user: User,
  options: ProcessingOptions
): ProcessedUser {
  // 实现
}

// 异步函数
async function fetchUserData(id: string): Promise<User> {
  const response = await api.get(`/users/${id}`);
  return response.data;
}
```

---

## 4. TypeScript 规范

### 4.1 类型定义

```typescript
// ✅ 显式返回类型（公共 API）
export function calculateTotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}

// ✅ 类型推断（简单函数）
const double = (x: number) => x * 2;

// ✅ 接口优于类型别名（对象）
interface User {
  id: string;
  name: string;
  email: string;
}

// ✅ 类型别名（联合类型）
type Status = 'idle' | 'loading' | 'success' | 'error';

// ❌ 避免 any
data: any;  // 不推荐

// ✅ 使用 unknown
function processData(data: unknown) {
  if (typeof data === 'string') {
    // 处理字符串
  }
}
```

### 4.2 泛型使用

```typescript
// 函数泛型
function identity<T>(value: T): T {
  return value;
}

// 接口泛型
interface ApiResponse<T> {
  data: T;
  status: number;
  message: string;
}

// 类型约束
interface HasId {
  id: string;
}

function findById<T extends HasId>(items: T[], id: string): T | undefined {
  return items.find(item => item.id === id);
}

// 默认值
interface Container<T = string> {
  value: T;
}
```

### 4.3 枚举 vs 联合类型

```typescript
// ✅ 使用联合类型（推荐）
type ViewType = 'dashboard' | 'chat' | 'taskboard' | 'files' | 'skills' | 'devices' | 'settings' | 'memories' | 'audit' | 'agents' | 'account';

// 必要时使用枚举
enum ConnectionStatus {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
}
```

---

## 5. React 规范

### 5.1 组件定义

```typescript
// ✅ 函数组件 + 显式返回类型
export const Button: React.FC<ButtonProps> = ({ children, onClick }) => {
  return <button onClick={onClick}>{children}</button>;
};

// ✅ 使用 forwardRef
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ value, onChange }, ref) => {
    return <input ref={ref} value={value} onChange={onChange} />;
  }
);
Input.displayName = 'Input';

// ✅ 使用 memo
export const ExpensiveComponent = React.memo<Props>(({ data }) => {
  // 复杂渲染逻辑
});
```

### 5.2 Hooks 使用

```typescript
// ✅ Hooks 规则
const Component: React.FC = () => {
  // 1. 所有 Hooks 在顶部
  const [count, setCount] = useState(0);
  const [name, setName] = useState('');
  const ref = useRef(null);
  
  // 2. 派生状态使用 useMemo
  const doubled = useMemo(() => count * 2, [count]);
  
  // 3. 回调函数使用 useCallback
  const handleClick = useCallback(() => {
    setCount(c => c + 1);
  }, []);
  
  // 4. 副作用使用 useEffect
  useEffect(() => {
    // 副作用逻辑
    return () => {
      // 清理逻辑
    };
  }, [dependency]);
  
  // 5. 条件渲染在 return 中
  if (loading) return <Loading />;
  
  return <div>{/* 渲染 */}</div>;
};
```

### 5.3 Props 处理

```typescript
interface UserCardProps {
  user: User;
  showEmail?: boolean;
  onEdit?: (user: User) => void;
  className?: string;
}

export const UserCard: React.FC<UserCardProps> = ({
  user,
  showEmail = false,
  onEdit,
  className,
}) => {
  // 解构时设置默认值
  
  return (
    <div className={className}>
      <h3>{user.name}</h3>
      {showEmail && <p>{user.email}</p>}
      {onEdit && <button onClick={() => onEdit(user)}>编辑</button>}
    </div>
  );
};
```

---

## 6. 注释规范

### 6.1 文件头注释

```typescript
/**
 * @file 文件简短描述
 * @description 详细描述文件功能和用途
 * @module 所属模块
 */
```

### 6.2 JSDoc 注释

```typescript
/**
 * 计算订单总价
 * 
 * @param items - 订单项列表
 * @param discount - 折扣百分比（0-100）
 * @returns 折后总价
 * @throws 当折扣无效时抛出错误
 * 
 * @example
 * ```typescript
 * const total = calculateTotal(items, 10);
 * console.log(total); // 90
 * ```
 */
function calculateTotal(items: Item[], discount: number): number {
  // 实现
}
```

### 6.3 行内注释

```typescript
// ✅ 解释 "为什么" 而非 "是什么"
// 使用防抖避免频繁请求 API
const debouncedSearch = useDebounce(search, 300);

// ❌ 避免显而易见的注释
// 设置 count 为 0
setCount(0);

// ✅ 标记 TODO/FIXME
// TODO: 添加错误重试逻辑
// FIXME: 处理边界情况
```

### 6.4 类型注释

```typescript
// 复杂类型需要解释
/**
 * 用户角色权限映射
 * 键为角色 ID，值为权限列表
 */
type RolePermissions = Map<string, Permission[]>;

// 泛型参数注释
interface ApiResponse<
  T, // 响应数据类型
  E = ApiError // 错误类型（可选）
> {
  data: T;
  error?: E;
}
```

---

## 7. 导入导出规范

### 7.1 导入顺序

```typescript
// 1. React 导入
import React, { useState, useEffect } from 'react';

// 2. 第三方库
import { format } from 'date-fns';
import { debounce } from 'lodash';
import { useQuery } from '@tanstack/react-query';

// 3. 绝对路径导入 - UI 组件
import { Button, Input, Card } from '@/components/ui';

// 4. 绝对路径导入 - 业务组件
import { DashboardHeader } from '@/components/business';

// 5. 绝对路径导入 - Hooks
import { useAuth } from '@/hooks/business/useAuth';
import { useQuery as useCustomQuery } from '@/hooks/common/useQuery';

// 6. 绝对路径导入 - 服务
import { userService } from '@/services/user-service';

// 7. 绝对路径导入 - 类型
import type { User, DashboardData } from '@/types';

// 8. 绝对路径导入 - 工具
import { formatDate } from '@/utils/date';

// 9. 相对路径导入
import { SubComponent } from './SubComponent';
import { useLocalState } from '../hooks/useLocalState';

// 10. 样式导入（最后）
// CSS Modules (推荐)
import styles from './ComponentName.module.css';
// 全局样式（如需要）
// import './ComponentName.css';
```

### 7.2 导出规范

```typescript
// ✅ 命名导出（推荐）
export const ComponentName: React.FC = () => {};
export type { ComponentNameProps };
export { helperFunction };

// index.ts 桶式导出
export { Button } from './Button';
export { Input } from './Input';
export type { ButtonProps, InputProps } from './types';

// ❌ 避免默认导出（除非是页面/配置）
export default ComponentName;  // 不推荐
```

### 7.3 类型导入

```typescript
// ✅ 显式类型导入
import type { User } from '@/types';
import { type User, getUser } from '@/services/user';

// 混合导入
import React, { type FC, useState } from 'react';
```

---

## 8. 错误处理规范

### 8.1 错误类型定义

```typescript
// 基础错误类
class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// 具体错误类型
class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

class NetworkError extends AppError {
  constructor(message = '网络连接失败') {
    super(message, 'NETWORK_ERROR');
  }
}
```

### 8.2 错误处理模式

```typescript
// 服务层
async function fetchData(): Promise<Data> {
  try {
    const response = await api.get('/data');
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      throw new AppError('数据不存在', 'NOT_FOUND', 404);
    }
    throw new NetworkError();
  }
}

// Hook 层
const useData = () => {
  const [error, setError] = useState<Error | null>(null);
  
  const fetch = async () => {
    try {
      setError(null);
      const data = await fetchData();
      return data;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      setError(error);
      throw error;
    }
  };
  
  return { fetch, error, clearError: () => setError(null) };
};

// 组件层
const DataComponent: React.FC = () => {
  const { data, error, loading } = useData();
  
  if (error) {
    return <ErrorBanner message={error.message} />;
  }
  
  return <div>{/* 渲染 */}</div>;
};
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

### 9.2 数据获取优化

```typescript
// ✅ 防抖处理
const debouncedSearch = useDebounce(searchTerm, 300);

// ✅ 分页加载
const { data, fetchNextPage, hasNextPage } = useInfiniteQuery({
  queryKey: ['items'],
  queryFn: fetchItems,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
});

// ✅ 数据缓存
const { data } = useQuery({
  queryKey: ['user', userId],
  queryFn: () => fetchUser(userId),
  staleTime: 5 * 60 * 1000, // 5分钟
});
```

### 9.3 代码分割

```typescript
// ✅ 路由级分割
const DashboardPage = lazy(() => import('./pages/DashboardPage'));

// ✅ 组件级分割
const Chart = lazy(() => import('./components/Chart'));

// 使用 Suspense
<Suspense fallback={<Loading />}>
  <DashboardPage />
</Suspense>
```

---

## 10. 测试规范

### 10.1 测试文件组织

```
ComponentName/
├── ComponentName.tsx
├── ComponentName.module.css
├── ComponentName.test.tsx    # 组件测试
└── index.ts
```

### 10.2 测试命名和结构

```typescript
describe('ComponentName', () => {
  // 使用describe块组织相关测试
  describe('渲染', () => {
    it('应该正确渲染默认状态', () => {});
    it('应该正确渲染加载状态', () => {});
  });

  describe('交互', () => {
    it('点击按钮应该触发 onClick', () => {});
    it('输入应该触发 onChange', () => {});
  });

  describe('数据流', () => {
    it('应该从props正确接收和显示数据', () => {});
    it('应该处理空数据状态', () => {});
  });

  describe('边界情况', () => {
    it('空数组应该显示 Empty 组件', () => {});
    it('错误应该显示 ErrorBanner', () => {});
  });
});
```

### 10.3 测试最佳实践

#### 10.3.1 模拟和Mock策略

```typescript
// 正确的hook mock方式（在导入组件前）
vi.mock('../../hooks/business/useFeature', () => ({
  useFeature: vi.fn(),
}));

// 导入被测试的组件
import { useFeature } from '../../hooks/business/useFeature';
import { ComponentName } from './ComponentName';

// 在beforeEach中设置默认返回值
beforeEach(() => {
  vi.clearAllMocks();
  (useFeature as any).mockReturnValue({
    data: mockData,
    loading: false,
    error: null,
    // ... 返回值
  });
});
```

#### 10.3.2 元素查询策略

```typescript
// ✅ 推荐：使用角色查询（无障碍友好）
screen.getByRole('button', { name: /提交/i });
screen.getByRole('textbox', { name: /用户名/i });

// ✅ 推荐：使用label文本查询
screen.getByLabelText(/用户名/i);

// ✅ 推荐：使用占位符查询
screen.getByPlaceholderText(/请输入/i);

// ✅ 使用测试ID（当无法通过语义查询时）
screen.getByTestId('submit-button');

// ❌ 避免：使用实现细节查询
// screen.getByClassName('submit-btn');
// screen.getById('submit-button');
```

#### 10.3.3 用户行为模拟

```typescript
// ✅ 使用userEvent模拟真实用户行为
import userEvent from '@testing-library/user-event';

// 点击
await userEvent.click(button);

// 输入
await userEvent.type(input, 'Hello World');
await userEvent.keyboard('[Enter]');

// 选择
await userEvent.selectOptions(select, 'option value');

// 上传文件
await userEvent.upload(fileInput, file);
```

#### 10.3.4 异步测试和等待策略

```typescript
// ✅ 使用waitFor等待非断言条件
await waitFor(() => {
  expect(screen.getByText('加载完成')).toBeInTheDocument();
});

// ✅ 使用findBy系列查询（自带重试机制）
await screen.findByText(/加载完成/i);

// ✅ 明确的等待时间（仅在必要时）
await waitFor(() => {
  expect(mockFunction).toHaveBeenCalled();
}, { timeout: 5000 });
```

#### 10.3.5 测试数据和mock数据

```typescript
// ✅ 使用真实数据结构的mock数据
const mockUser = {
  id: 'user-123',
  username: 'testuser',
  email: 'test@example.com',
  createdAt: new Date().toISOString(),
};

// ✅ 为不同测试场景准备不同的mock数据
const mockEmptyState = {
  items: [],
  total: 0,
};

const mockErrorState = {
  error: new Error('Network error'),
  isLoading: false,
};

// ✅ 在测试文件顶部声明常用mock数据
const mockCreditsBalance = {
  id: 'balance-1',
  userId: 'user-123',
  totalBalance: 1000,
  totalEarned: 2000,
  totalConsumed: 800,
  // ... 其他字段
};
```

#### 10.3.6 测试文件组织和命名

```typescript
// 测试文件命名
ComponentName.test.tsx

// 测试目录结构（单元测试）
src/test/__tests__/
├── components/
│   ├── Button.test.tsx
│   ├── Input.test.tsx
│   └── ...
├── hooks/
│   ├── useAuth.test.ts
│   └── ...
├── pages/
│   ├── CreditsPage.test.tsx
│   └── ...
└── services/
    ├── auth-service.test.ts
    └── ...
```

#### 10.3.7 常见测试场景模板

```typescript
describe('ComponentName', () => {
  const mockOnChange = vi.fn();
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应该正确渲染初始状态', () => {
    render(<ComponentName />);
    expect(screen.getByText('初始值')).toBeInTheDocument();
  });

  it('应该在用户输入时调用onChange回调', async () => {
    render(<ComponentName onChange={mockOnChange} />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'test');
    expect(mockOnChange).toHaveBeenCalledWith('test');
  });

  it('应该在禁用状态下不响应用户交互', async () => {
    render(<ComponentName disabled />);
    const button = screen.getByRole('button');
    await userEvent.click(button);
    expect(mockOnChange).not.toHaveBeenCalled();
  });

  it('应该在加载状态下显示加载指示器', () => {
    render(<ComponentName loading />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('应该在错误状态下显示错误信息', () => {
    render(<ComponentName error="加载失败" />);
    expect(screen.getByText(/加载失败/i)).toBeInTheDocument();
  });
});
```

### 10.4 性能测试考虑

```typescript
// 测试重复渲染性能
it('不应该在props未变化时重新渲染', () => {
  const { rerender } = render(<ComponentName value="test" />);
  const originalRenderCount = getRenderCount();
  
  rerender(<ComponentName value="test" />);
  expect(getRenderCount()).toBe(originalRenderCount);
});

// 测试大数据列表渲染
it('应该正确处理大数据集（虚拟列表）', () => {
  const largeArray = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `Item ${i}` }));
  render(<DataList items={largeArray} />);
  // 验证只渲染可见项
  expect(screen.getAllByRole('row').length).toBeLessThan(50); // 假设可见项少于50
});
```

### 10.5 测试覆盖率和质量标准

- **行覆盖率**: 目标 > 80%
- **函数覆盖率**: 目标 > 80%  
- **分支覆盖率**: 目标 > 70%
- **语句覆盖率**: 目标 > 80%

#### 测试质量检查清单
- [ ] 所有公开的函数和组件都有测试覆盖
- [ ] 边界情况和错误状态都有测试
- [ ] 测试能够独立运行（不依赖测试顺序）
- [ ] 测试能够清晰描述所测试的行为
- [ ] 使用了适当的断言，不仅仅是测试是否抛出异常
- [ ] 测试不依赖实现细节（如类名、内部变量名）
- [ ] 异步测试有适当的等待机制
- [ ] mock被正确重置以避免测试间污染

---

## 附录: 快速检查清单

### 代码提交前检查

- [ ] 代码通过 `pnpm lint`
- [ ] 类型检查通过 `pnpm typecheck`
- [ ] 测试通过 `pnpm test`
- [ ] 没有 console.log（或已移除）
- [ ] 没有 TODO 注释（或已记录 issue）

### 代码审查检查

- [ ] 命名清晰且有描述性
- [ ] 函数长度合适（< 50 行）
- [ ] 复杂度适中（无深层嵌套）
- [ ] 错误处理完善
- [ ] TypeScript 类型完整
- [ ] 注释解释 "为什么" 而非 "是什么"

### 性能检查

- [ ] 避免不必要的重渲染
- [ ] 大数据集使用虚拟列表
- [ ] 图片使用懒加载
- [ ] 避免内存泄漏（清理副作用）
