# Windows 应用组件开发规范

> 文档版本: 1.0
> 组件标准和最佳实践

---

## 1. 组件分类体系

### 1.1 组件层次结构

```
components/
├── ui/              # 原子/基础组件 (Atomic)
├── layout/          # 布局组件 (Layout)
├── business/        # 业务组件 (Business)
├── pages/           # 页面组件 (Pages)
└── [根级组件]       # 应用级组件
```

### 1.2 组件类型定义

| 层级 | 说明 | 示例 | 依赖 |
|------|------|------|------|
| UI | 基础可复用组件 | Button, Input, Card | 无业务依赖 |
| Layout | 页面结构组件 | MainLayout, Sidebar | 可能依赖 UI |
| Business | 领域特定组件 | DeviceCard, SkillCard | 依赖 UI |
| Pages | 完整页面 | DashboardPage | 依赖所有下层 |

---

## 2. UI 组件规范

### 2.1 现有 UI 组件

位置: `src/renderer/components/ui/`

| 组件 | 路径 | 状态 | 用途 |
|------|------|------|------|
| Avatar | `ui/Avatar/` | ✅ 已实施 | 头像组件 |
| Badge | `ui/Badge/` | ✅ 已实施 | 徽章组件 |
| Button | `ui/Button/` | ✅ 已实施 | 按钮组件 |
| Card | `ui/Card/` | ✅ 已实施 | 卡片容器 |
| Checkbox | `ui/Checkbox/` | ✅ 已实施 | 复选框 |
| Divider | `ui/Divider/` | ✅ 已实施 | 分割线 |
| Empty | `ui/Empty/` | ✅ 已实施 | 空状态 |
| ErrorBanner | `ui/ErrorBanner/` | ✅ 已实施 | 错误展示 |
| Input | `ui/Input/` | ✅ 已实施 | 文本输入 |
| Loading | `ui/Loading/` | ✅ 已实施 | 加载状态 |
| Modal | `ui/Modal/` | ✅ 已实施 | 模态框 |
| PageHeader | `ui/PageHeader/` | ✅ 已实施 | 页面标题 |
| Radio | `ui/Radio/` | ✅ 已实施 | 单选框 |
| Responsive | `ui/Responsive/` | ✅ 已实施 | 响应式组件 |
| Select | `ui/Select/` | ✅ 已实施 | 下拉选择 |
| Skeleton | `ui/Skeleton/` | ✅ 已实施 | 骨架屏 |
| Switch | `ui/Switch/` | ✅ 已实施 | 开关 |
| Table | `ui/Table/` | ✅ 已实施 | 数据表格 |
| Tag | `ui/Tag/` | ✅ 已实施 | 标签 |
| Toast | `ui/Toast/` | ✅ 已实施 | 消息提示 |
| Tooltip | `ui/Tooltip/` | ✅ 已实施 | 工具提示 |

### 2.2 UI 组件模板

```typescript
// ComponentName.tsx
import React from 'react';
import styles from './ComponentName.module.css';

export interface ComponentNameProps {
  /** 组件类名 */
  className?: string;
  /** 禁用状态 */
  disabled?: boolean;
  /** 尺寸变体 */
  size?: 'small' | 'medium' | 'large';
  /** 点击回调 */
  onClick?: () => void;
}

export const ComponentName = React.forwardRef<
  HTMLDivElement,
  ComponentNameProps
>(({ className, disabled, size = 'medium', onClick }, ref) => {
  const classNames = [
    'component-name',
    `component-name--${size}`,
    disabled && 'component-name--disabled',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div ref={ref} className={classNames} onClick={onClick}>
      {/* 组件内容 */}
    </div>
  );
});

ComponentName.displayName = 'ComponentName';
```

```css
/* ComponentName.module.css */
.componentName {
  /* 基础样式 */
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
  transition: all var(--transition-fast);
}

/* 尺寸变体 */
.componentName--small {
  padding: var(--spacing-sm);
  font-size: var(--font-size-sm);
}

.componentName--medium {
  padding: var(--spacing-md);
  font-size: var(--font-size-base);
}

.componentName--large {
  padding: var(--spacing-lg);
  font-size: var(--font-size-lg);
}

/* 状态 */
.componentName--disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 交互 */
.componentName:hover:not(.componentName--disabled) {
  background-color: var(--color-primary-hover);
}
```

```typescript
// index.ts
export { ComponentName } from './ComponentName';
export type { ComponentNameProps } from './ComponentName';
```

### 2.3 UI 组件原则

1. **单一职责**: 每个组件只做一件事
2. **可组合性**: 支持通过 children 组合
3. **可定制性**: 支持 className 扩展
4. **可访问性**: 支持键盘导航和 ARIA 属性
5. **类型安全**: 完整的 TypeScript 类型
6. **CSS Modules**: 使用 .module.css 文件进行样式隔离

---

## 3. 布局组件规范

### 3.1 现有布局组件

| 组件 | 路径 | 职责 |
|------|------|------|
| MainLayout | `layout/MainLayout/` | 应用外壳 |
| Sidebar | `layout/Sidebar/` | 侧边导航 |
| TitleBar | `layout/TitleBar/` | 窗口标题栏 |

### 3.2 MainLayout 规范

```typescript
interface MainLayoutProps {
  children: React.ReactNode;
  activeView: ViewType;
  onViewChange: (view: ViewType) => void;
}
```

**职责**:
- 包裹整个应用内容
- 管理 Sidebar 和 TitleBar
- 提供内容区域

### 3.3 Sidebar 规范

**导航项定义**:
```typescript
interface NavItem {
  id: ViewType;
  label: string;
  icon: React.ComponentType;
  disabled?: boolean;
  badge?: string | number;
}
```

**现有导航项**:
```typescript
const navItems: NavItem[] = [
  { id: 'dashboard', label: '概览', icon: HomeIcon },
  { id: 'chat', label: '对话', icon: MessageSquareIcon },
  { id: 'files', label: '工作空间', icon: FolderIcon },
  { id: 'skills', label: '技能管理', icon: ZapIcon, disabled: true },
  { id: 'memories', label: '记忆管理', icon: BrainIcon },
  { id: 'devices', label: '设备管理', icon: MonitorIcon },
  { id: 'settings', label: '设置', icon: SettingsIcon },
];
```

---

## 4. 业务组件规范

### 4.1 现有业务组件

| 组件 | 路径 | 用途 |
|------|------|------|
| ApprovalSettings | `business/ApprovalSettings/` | 执行审批设置 |
| ConnectionStatus | `business/ConnectionStatus/` | 连接状态指示器 |
| CreditsView | `business/CreditsView/` | 积分查看界面 |
| DeviceCard | `business/DeviceCard/` | 设备信息卡片 |
| DualConnectionStatus | `business/DualConnectionStatus/` | 双连接状态 |
| ExecDenylistManager | `business/ExecDenylistManager/` | 执行拒绝列表管理 |
| index.ts | `business/index.ts` | 业务组件导出 |
| SkillCard | `business/SkillCard/` | 技能信息卡片 |
| SkillStoreView | `business/SkillStoreView/` | 技能商店界面 |
| SubscriptionView | `business/SubscriptionView/` | 订阅查看界面 |
| SystemStatus | `business/SystemStatus/` | 系统状态面板 |
| UpdaterView | `business/UpdaterView/` | 更新检查界面 |

### 4.2 业务组件模板

```typescript
// FeatureComponent.tsx
import React from 'react';
import { Card, Button, Loading, ErrorBanner } from '@/components/ui';
import { useFeature } from '@/hooks/business/useFeature';
import type { FeatureData } from '@/types/feature';
import './FeatureComponent.css';

export interface FeatureComponentProps {
  data?: FeatureData;
  onAction?: (id: string) => void;
}

export const FeatureComponent: React.FC<FeatureComponentProps> = ({
  data,
  onAction,
}) => {
  const { loading, error, execute } = useFeature();

  if (loading) return <Loading />;
  if (error) return <ErrorBanner message={error.message} />;

  return (
    <Card className="feature-component">
      <div className="feature-component__header">
        <h3>{data?.name}</h3>
      </div>
      <div className="feature-component__content">
        {/* 业务内容 */}
      </div>
      <div className="feature-component__actions">
        <Button onClick={() => data?.id && onAction?.(data.id)}>
          执行操作
        </Button>
      </div>
    </Card>
  );
};
```

---

## 5. 页面组件规范

### 5.1 页面结构标准

```
PageName/
├── PageName.tsx              # 页面组件
├── PageName.css              # 页面样式
├── components/               # 页面专属子组件
│   ├── SubComponentA/
│   └── SubComponentB/
├── hooks/                    # 页面专属 hooks
│   └── usePageSpecific.ts
└── types.ts                  # 页面类型（可选）
```

### 5.2 页面组件模板

```typescript
// PageName.tsx
import React from 'react';
import { PageHeader, Button, Loading, Empty, ErrorBanner } from '@/components/ui';
import { usePageFeature } from '@/hooks/business/usePageFeature';
import './PageName.css';

export const PageName: React.FC = () => {
  const { 
    data, 
    loading, 
    error, 
    refresh, 
    clearError 
  } = usePageFeature();

  // 加载状态
  if (loading && !data) {
    return <Loading fullPage />;
  }

  // 错误状态
  if (error) {
    return (
      <div className="page-container">
        <ErrorBanner 
          message={error.message} 
          onRetry={refresh}
          onClose={clearError}
        />
      </div>
    );
  }

  return (
    <div className="page-container">
      {/* 页面头部 */}
      <PageHeader 
        title="页面标题" 
        subtitle="页面描述"
      >
        <Button variant="primary" onClick={refresh}>
          刷新
        </Button>
      </PageHeader>

      {/* 页面内容 */}
      <div className="page-content">
        {!data || data.length === 0 ? (
          <Empty 
            description="暂无数据" 
            action={<Button onClick={refresh}>刷新</Button>}
          />
        ) : (
          <div className="data-list">
            {data.map(item => (
              <DataCard key={item.id} data={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
```

### 5.3 页面样式模板

```css
/* PageName.css */
.page-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: var(--spacing-lg);
  overflow: hidden;
}

.page-content {
  flex: 1;
  overflow-y: auto;
  margin-top: var(--spacing-lg);
}

.data-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--spacing-lg);
}
```

---

## 6. 组件通信规范

### 6.1 Props 传递

**推荐方式**:
```typescript
// 显式传递必要 Props
interface ParentProps {
  user: User;
  onUpdate: (user: User) => void;
}

const Parent: React.FC<ParentProps> = ({ user, onUpdate }) => {
  return <Child user={user} onUpdate={onUpdate} />;
};
```

**避免**:
```typescript
// 避免展开所有 props
const Parent = (props) => {
  return <Child {...props} />;
};
```

### 6.2 回调函数命名

```typescript
// 事件触发方
onClick        // 点击
onChange       // 值改变
onSelect       // 选择
onSubmit       // 提交
onCancel       // 取消
onClose        // 关闭

// 状态更新方
onUpdate       // 更新
onRefresh      // 刷新
onDelete       // 删除
onCreate       // 创建
```

### 6.3 Context 使用场景

**使用 Context**:
- 跨多层级的主题/语言设置
- 全局认证状态
- 全局连接状态
- 全局设置

**不使用 Context**:
- 仅父子组件通信（直接用 props）
- 局部状态（用 useState）
- 可提升的共享状态

---

## 7. 组件文档规范

### 7.1 JSDoc 注释

```typescript
export interface ButtonProps {
  /** 按钮变体样式 */
  variant?: 'primary' | 'secondary' | 'danger';
  /** 按钮尺寸 */
  size?: 'small' | 'medium' | 'large';
  /** 禁用状态 */
  disabled?: boolean;
  /** 点击事件处理器 */
  onClick?: () => void;
  /** 按钮内容 */
  children: React.ReactNode;
}

/**
 * 按钮组件
 * 
 * 用于触发操作或事件的基础组件
 * 
 * @example
 * ```tsx
 * <Button variant="primary" onClick={handleClick}>
 *   提交
 * </Button>
 * ```
 */
export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'medium',
  disabled,
  onClick,
  children,
}) => {
  // 实现
};
```

### 7.2 Storybook (未来)

考虑使用 Storybook 记录组件：

```typescript
// Button.stories.tsx
export default {
  title: 'UI/Button',
  component: Button,
};

export const Primary = () => <Button variant="primary">主要按钮</Button>;
export const Secondary = () => <Button variant="secondary">次要按钮</Button>;
export const Danger = () => <Button variant="danger">危险按钮</Button>;
```

---

## 8. 组件测试规范

### 8.1 测试文件位置

```
ComponentName/
├── ComponentName.tsx
├── ComponentName.css
├── ComponentName.test.tsx    # 测试文件
└── index.ts
```

### 8.2 组件测试模板

```typescript
// ComponentName.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { ComponentName } from './ComponentName';

describe('ComponentName', () => {
  const defaultProps = {
    title: 'Test Title',
    onClick: vi.fn(),
  };

  it('应该正确渲染标题', () => {
    render(<ComponentName {...defaultProps} />);
    expect(screen.getByText('Test Title')).toBeInTheDocument();
  });

  it('点击应该触发 onClick 回调', () => {
    render(<ComponentName {...defaultProps} />);
    fireEvent.click(screen.getByRole('button'));
    expect(defaultProps.onClick).toHaveBeenCalledTimes(1);
  });

  it('禁用时应该不响应点击', () => {
    render(<ComponentName {...defaultProps} disabled />);
    fireEvent.click(screen.getByRole('button'));
    expect(defaultProps.onClick).not.toHaveBeenCalled();
  });
});
```

---

## 9. 组件开发检查清单

### 创建新组件前

- [ ] 检查是否已有类似组件
- [ ] 确定组件分类（ui/layout/business/page）
- [ ] 设计 Props 接口
- [ ] 确认设计令牌可用
- [ ] 考虑组件是否真的需要是状态组件（ stateless vs stateful）

### 开发组件时

- [ ] 遵循文件结构规范
- [ ] 使用 TypeScript 严格类型
- [ ] 实现所有 Props 变体
- [ ] 添加 JSDoc 注释
- [ ] 使用 CSS 变量（通过样式对象）
- [ ] 确保组件是纯净的（相同props产生相同输出）
- [ ] 正确处理禁用和加载状态
- [ ] 使用React.memo进行性能优化（当组件渲染开销大且props变化不频繁时）

### 组件完成后

- [ ] 编写单元测试
- [ ] 更新组件索引导出
- [ ] 在类似页面中测试
- [ ] 运行 lint 和 typecheck
- [ ] 在Storybook中验证所有状态（如果适用）
- [ ] 测试组件在不同主题下的表现（浅色/深色）

---

## 附录 A: 组件快速参考

### UI 组件索引

```typescript
// 从 ui 目录导入
import { 
  Button, 
  Input, 
  Card, 
  Modal, 
  Select,
  Table,
  Loading,
  Empty,
  Toast,
  Skeleton,
  ErrorBanner,
  PageHeader 
} from '@/components/ui';
```

### 布局组件索引

```typescript
// 从 layout 目录导入
import { MainLayout, Sidebar, TitleBar } from '@/components/layout';
```

### 业务组件索引

```typescript
// 从 business 目录导入
import { 
  ConnectionStatus,
  DeviceCard,
  SkillCard,
  SystemStatus 
} from '@/components/business';
```

---

## 附录 B: 常见问题

### Q: 新组件应该放在哪里？

**A**: 根据组件职责：
- 纯 UI 元素 → `components/ui/`
- 页面结构 → `components/layout/`
- 业务领域 → `components/business/`
- 完整页面 → `pages/`

### Q: 如何扩展现有组件？

**A**: 
1. 优先考虑通过 props 扩展
2. 必要时创建 wrapper 组件
3. 避免直接修改组件内部逻辑

### Q: 组件应该接收多少 props？

**A**: 
- 基础 UI 组件：5-8 个 props 为宜
- 业务组件：可以更多，但应考虑拆分
- 超过 10 个 props 考虑使用配置对象模式
