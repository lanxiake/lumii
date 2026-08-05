# Windows 应用 UI 设计标准文档

> 文档版本: 1.0
> 基于项目实际代码结构整理
> 适用范围: apps/windows 项目

---

## 1. 设计原则

### 1.1 核心设计理念
- **一致性**: 所有 UI 组件遵循统一的设计语言和交互模式
- **可用性**: 优先考虑用户操作效率和直观性
- **响应性**: 界面状态变化及时反馈
- **可访问性**: 支持键盘导航和屏幕阅读器

### 1.2 设计令牌 (Design Tokens)

所有视觉样式必须通过设计令牌管理，禁止硬编码值。

**令牌位置**:
- CSS 变量: `src/renderer/styles/tokens.css`
- TypeScript 令牌: `src/renderer/styles/tokens/*.ts`

**令牌分类**:
```typescript
// colors.ts - 颜色系统
// spacing.ts - 间距系统
// typography.ts - 字体系统
// shadows.ts - 阴影系统
// radius.ts - 圆角系统
// transitions.ts - 过渡动画
// z-index.ts - 层级系统
// breakpoints.ts - 断点系统
```

### 1.3 暗色主题优先

项目采用暗色主题作为默认主题：
- 主背景: `--bg-primary: #0f172a`
- 次背景: `--bg-secondary: #1e293b`
- 主文字: `--text-primary: #f8fafc`
- 强调色: `--color-primary: #6366f1`

#### 暗色主题适配指南

虽然项目默认使用暗色主题，但仍需考虑在特定场景下的浅色元素或主题切换需求：

**CSS变量使用原则**：
```css
/* ✅ 正确：始终使用CSS变量而非硬编码值 */
.component {
  background-color: var(--bg-primary);
  color: var(--text-primary);
  border-color: var(--border-color);
}

/* ❌ 错误：硬编码颜色值 */
.component {
  background-color: #0f172a; /* 避免这种硬编码 */
  color: #f8fafc;
}
```

**主题适配检查清单**：
1. 所有颜色值必须来自设计令牌（`var(--color-*)`）
2. 所有背景值必须来自设计令牌（`var(--bg-*)`或`var(--color-*)`）
3. 所有边框值必须来自设计令牌（`var(--border-color)`或`var(--color-*)`）
4. 所有阴影值必须来自设计令牌（`var(--shadow-*)`）
5. 浅色元素（如需）应使用专门的浅色变量或适当的透明度

**浅色元素处理**（当确实需要浅色元素时）：
```typescript
// 使用浅色变量（如果定义了）
.button-light {
  background-color: var(--bg-tertiary);
  color: var(--text-secondary);
}

// 使用透明度创建浅色效果
.button-with-transparency {
  background-color: rgba(255, 255, 255, 0.05); /* 非常轻的白色遮罩 */
}

/* 或使用CSS滤镜（慎用） */
.button-subtle {
  filter: brightness(1.2); /* 仅在必要时使用 */
}
```

#### 主题测试方法

1. **开发者工具测试**：
   - 在Chrome/Firefox开发者工具中禁用CSS或强制颜色方案
   - 使用"渲染"选项卡中的"强制颜色方案"进行测试

2. **手动验证**：
   - 检查所有文本在深色背景上的可读性（对比度应至少为4.5:1）
   - 验证图标和UI元素在深色背景上的可见性
   - 确保没有硬编码的白色或浅色背景意外出现

3. **自动化测试考虑**：
   - 在视觉回归测试中包含主题检查
   - 考虑使用工具自动检查对比度

---

## 2. 组件架构

### 2.1 组件层级

```
components/
├── ui/           # 原子/基础组件 (20+)
├── layout/       # 布局结构组件
├── business/     # 业务领域组件
└── pages/        # 页面级组件
```

### 2.2 组件分类标准

#### UI 组件 (原子组件)
位置: `src/renderer/components/ui/`

每个组件必须包含：
```
ComponentName/
├── ComponentName.tsx    # 组件实现
├── ComponentName.module.css    # 组件样式 (CSS Modules)
└── index.ts             # 导出文件
```

**现有 UI 组件清单**:
- Avatar - 头像组件
- Badge - 徽章组件
- Button - 按钮组件
- Card - 卡片容器
- Checkbox - 复选框
- Divider - 分割线
- Empty - 空状态
- ErrorBanner - 错误展示
- Input - 文本输入
- Loading - 加载状态
- Modal - 模态框
- PageHeader - 页面标题
- Radio - 单选框
- Responsive - 响应式组件 (Show/Hide)
- Select - 下拉选择
- Skeleton - 骨架屏
- Switch - 开关
- Table - 数据表格
- Tag - 标签
- Toast - 消息提示
- Tooltip - 工具提示

**UI 组件规范**:
1. 必须接受 `className` 属性用于样式扩展
2. Props 接口必须完整定义
3. 样式必须使用 CSS 变量 (通过样式对象访问，如 `styles.className`)
4. 必须支持 ref 转发
5. 使用 CSS Modules 进行样式隔离，文件名称为 `[componentName].module.css`

#### 布局组件
位置: `src/renderer/components/layout/`

- **MainLayout**: 应用外壳（标题栏 + 侧边栏 + 内容区）
- **Sidebar**: 导航菜单
- **TitleBar**: 窗口控制按钮

#### 业务组件
位置: `src/renderer/components/business/`

领域特定的复合组件：
- ConnectionStatus - 连接状态显示
- DeviceCard - 设备卡片
- SkillCard - 技能卡片
- SystemStatus - 系统状态

---

## 3. 页面开发标准

### 3.1 页面结构

位置: `src/renderer/pages/`

**页面必须包含**:
```
PageName/
├── PageName.tsx         # 页面组件
├── PageName.css         # 页面样式
├── components/          # 页面专属子组件 (可选)
└── hooks/               # 页面专属 hooks (可选)
```

### 3.2 页面规范清单

每个页面必须遵循以下规范：

**必需组件**:
- [ ] 使用 `PageHeader` 显示页面标题
- [ ] 错误状态使用 `ErrorBanner`
- [ ] 加载状态使用 `Loading` 组件
- [ ] 空数据使用 `Empty` 组件
- [ ] 所有按钮使用 `Button` 组件（禁止原生 button）

**布局要求**:
- [ ] 页面内容包裹在 `page-container` 类中
- [ ] 顶部使用 `page-header` 类
- [ ] 内容区使用 `page-content` 类
- [ ] 底部操作区使用 `page-actions` 类（如适用）

**类型定义**:
- [ ] 在 `src/renderer/types/` 定义页面相关类型
- [ ] Props 接口必须完整注释
- [ ] API 响应类型必须定义

### 3.3 页面模板

```typescript
// src/renderer/pages/ExamplePage/ExamplePage.tsx
import React from 'react';
import { PageHeader, Button, Loading, Empty, ErrorBanner } from '@/components/ui';
import { useExample } from '@/hooks/business/useExample';
import type { ExampleData } from '@/types/example';
import './ExamplePage.css';

export const ExamplePage: React.FC = () => {
  const { data, loading, error, refresh } = useExample();

  if (loading) return <Loading fullPage />;
  if (error) return <ErrorBanner message={error.message} onRetry={refresh} />;

  return (
    <div className="page-container">
      <PageHeader title="页面标题" subtitle="页面副标题">
        <Button variant="primary" onClick={refresh}>刷新</Button>
      </PageHeader>
      
      <div className="page-content">
        {data?.length === 0 ? (
          <Empty description="暂无数据" />
        ) : (
          // 内容渲染
        )}
      </div>
    </div>
  );
};
```

### 3.4 现有页面清单

| 页面 | 路径 | 状态 | 说明 |
|------|------|------|------|
| AuthPage | `/auth` | 活跃 | 登录认证 |
| DashboardPage | `/dashboard` | 活跃 | 概览仪表板 |
| ChatPage | `/chat` | 活跃 | 对话界面 |
| FilesPage | `/files` | 活跃 | 工作空间文件 |
| SkillsPage | `/skills` | 部分禁用 | 技能管理 |
| DevicesPage | `/devices` | 活跃 | 设备管理 |
| SettingsPage | `/settings` | 活跃 | 应用设置 |
| SystemPage | `/system` | 部分禁用 | 系统监控 |
| SubscriptionPage | `/subscription` | 活跃 | 订阅管理 |
| CreditsPage | `/credits` | 活跃 | 积分管理 |
| MemoriesPage | `/memories` | 活跃 | 记忆管理 |
| AuditLogPage | `/audit` | 部分禁用 | 审计日志 |

---

## 4. 样式规范

### 4.1 CSS 架构

```
styles/
├── global.css          # 全局重置和基础样式
├── tokens.css          # CSS 变量定义
└── tokens/             # TypeScript 设计令牌
```

### 4.2 样式编写规则

**必须使用**:
- CSS 变量用于所有颜色、间距、字体大小
- BEM 命名规范（区块__元素--修饰符）
- 组件级 CSS 文件（与组件同名）

**禁止使用**:
- 行内样式 `style={{}}`
- CSS-in-JS 库
- 硬编码颜色/尺寸值
- `!important`（除非覆盖第三方库）

### 4.3 命名规范

**CSS 类名**:
```css
/* 区块 */
.page-container { }
.card-list { }

/* 元素 */
.page-container__header { }
.card-list__item { }

/* 修饰符 */
.button--primary { }
.button--disabled { }
.card--highlighted { }
```

### 4.4 响应式设计

断点定义（来自 `breakpoints.ts`）:
- Mobile: < 768px
- Tablet: 768px - 1024px
- Desktop: > 1024px

#### 响应式设计实现方式

推荐使用CSS媒体查询和响应式组件（如`Responsive`）两种方式结合：

```css
/* 响应式容器示例 */
.responsive-container {
  padding: var(--spacing-md);
  
  /* 平板设备 */
  @media (max-width: 1024px) {
    padding: var(--spacing-sm);
  }
  
  /* 移动设备 */
  @media (max-width: 768px) {
    padding: var(--spacing-xs);
  }
}
```

#### 响应式组件（Responsive）使用

项目提供了`Responsive`组件用于条件渲染：

```typescript
import { Responsive } from '@/components/ui/Responsive';

// 在组件中使用
<div className="page-content">
  {/* 在桌面端显示侧边栏 */}
  <Responsive visible={['lg', 'xl']}>
    <Sidebar />
  </Responsive>
  
  {/* 在移动端显示汉堡菜单按钮 */}
  <Responsive visible={['sm', 'md']}>
    <Button icon="menu" onClick={toggleSidebar} variant="ghost" />
  </Responsive>
  
  {/* 主内容区域 */}
  <MainContent />
</div>
```

**Responsive组件属性**:
- `visible`: 指定在哪些断点可见 (xs, sm, md, lg, xl)
- `hidden`: 指定在哪些断点隐藏
- `inline`: 为内联元素显示 (默认为块级)

#### 响应式布局模式

1. **流式布局**（默认）：使用百分比或flex布局随容器缩放
2. **断点适配**：在特定断点调整布局
3. **条件显示**：根据设备类型显示/隐藏内容
4. **导航转换**：移动端将横向导航转换为抽屉或底部导航

#### 常见响应式模式实现

**导航栏响应式转换**：
```typescript
// Header.tsx
import { Responsive } from '@/components/ui';

export const Header: React.FC = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  
  return (
    <header className="app-header">
      {/* 桌面端显示完整导航 */}
      <Responsive visible={['lg', 'xl']}>
        <NavigationBar />
      </Responsive>
      
      {/* 移动端显示汉堡菜单 */}
      <Responsive visible={['sm', 'md']}>
        <Button 
          icon="menu" 
          onClick={() => setSidebarOpen(!sidebarOpen)}
          variant="ghost"
          aria-label="打开导航菜单"
        />
      </Responsive>
      
      {/* 响应式标题 */}
      <h1 className="responsive-title">
        <Responsive visible={['lg', 'xl']}>完整应用名称</Responsive>
        <Responsive visible={['sm', 'md']}>简称</Responsive>
      </h1>
    </header>
  );
};
```

**表格响应式处理**：
```typescript
// ResponsiveTable.tsx
import { Responsive } from '@/components/ui/Responsive';

export const ResponsiveTable: React.FC<{ data: any[] }> = ({ data }) => {
  return (
    <div className="table-responsive">
      {/* 桌面端显示完整表格 */}
      <Responsive visible={['lg', 'xl']}>
        <DataTable data={data} showAllColumns />
      </Responsive>
      
      {/* 移动端显示卡片视图 */}
      <Responsive visible={['sm', 'md']}>
        <div className="mobile-card-view">
          {data.map(item => (
            <Card key={item.id}>
              <CardHeader title={item.title} />
              <CardContent>
                {/* 显示重要字段 */}
                <p><strong>状态:</strong> {item.status}</p>
                <p><strong>时间:</strong> {item.timestamp}</p>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => viewDetails(item.id)}
                >
                  查看详情
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </Responsive>
    </div>
  );
};
```

---

## 5. 状态管理规范

### 5.1 架构模式

采用 **React Context + Custom Hooks** 架构：

**Provider 层级**:
```
AuthProvider
  └── ConnectionProvider
        └── SettingsProvider
              └── ThemeProvider
                    └── SkillsProvider
```

### 5.2 Context 使用规范

**位置**: `src/renderer/contexts/`

**每个 Context 必须包含**:
```
ContextName/
├── types.ts           # 类型定义
├── Context.tsx        # Context 创建
├── Provider.tsx       # Provider 实现
├── useContext.ts      # Hook 封装
└── index.ts           # 导出
```

### 5.3 Hooks 规范

**通用 Hooks** 位置: `src/renderer/hooks/common/`
- useQuery - 数据获取
- useMutation - 数据变更
- useAsync - 异步操作
- useLocalStorage - 本地存储
- useDebounce - 防抖
- usePolling - 轮询
- usePagination - 分页

**业务 Hooks** 位置: `src/renderer/hooks/business/`

**每个业务 Hook 结构**:
```
useFeature/
├── useFeature.types.ts    # 类型定义
├── useFeature.ts          # Hook 实现
└── index.ts               # 导出
```

**Hook 编写原则**:
1. 单一职责：每个 Hook 只做一件事
2. 返回对象格式：`{ data, loading, error, ...actions }`
3. 错误处理：统一返回 error 对象和 clearError 方法
4. 清理逻辑：useEffect 返回清理函数

---

## 6. 图标和图片规范

### 6.1 图标使用

**图标库**: Lucide React (`lucide-react`)

**使用方式**:
```typescript
import { Home, Settings, User } from 'lucide-react';

<Home size={20} />
<Settings className="icon-medium" />
```

**图标尺寸规范**:
- 小图标: 16px
- 中图标: 20px
- 大图标: 24px

### 6.2 图片资源

**位置**: `assets/`

**命名规范**:
- 图标: `icon-{name}.png`
- 徽标: `logo-{variant}.png`
- 插图: `illustration-{name}.png`

---

## 7. 动画和过渡

### 7.1 过渡标准

使用 CSS 变量定义的过渡：

```css
/* 来自 transitions.ts */
--transition-fast: 150ms ease;
--transition-base: 200ms ease;
--transition-slow: 300ms ease;
```

**应用场景**:
- 按钮悬停: `transition-fast`
- 模态框出现: `transition-base`
- 页面切换: `transition-slow`

### 7.2 加载动画

**必须使用** `Loading` 组件，禁止自定义加载动画。

**加载类型**:
- `spinner` - 旋转指示器
- `skeleton` - 骨架屏
- `dots` - 点状动画

---

## 8. 表单规范

### 8.1 表单组件

**必须使用** 项目内 UI 组件：
- `Input` - 文本输入
- `Select` - 下拉选择
- `Checkbox` - 复选框
- `Radio` - 单选框
- `TextArea` - 多行文本

### 8.2 表单验证

**验证时机**:
- 实时验证: 输入停止 500ms 后
- 提交验证: 点击提交按钮时
- 失焦验证: 字段失去焦点时

**错误显示**:
- 错误信息在字段下方显示
- 使用 `var(--color-error)` 颜色
- 配合 `AlertCircle` 图标

---

## 9. 导航规范

### 9.1 导航结构

项目使用**视图路由**（非 React Router）：

**视图类型** (`src/renderer/components/Router.tsx`):
```typescript
type ViewType = 
  | 'dashboard' 
  | 'chat' 
  | 'files' 
  | 'skills' 
  | 'devices' 
  | 'settings' 
  | 'system' 
  | 'subscription' 
  | 'credits' 
  | 'memories' 
  | 'audit';
```

### 9.2 侧边栏导航

**位置**: `src/renderer/components/layout/Sidebar.tsx`

**导航项定义**:
```typescript
interface NavItem {
  id: ViewType;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  badge?: string;
}
```

**当前导航项**:
1. Dashboard (概览)
2. Chat (对话)
3. Files (工作空间)
4. Skills (技能管理) - 部分禁用
5. System (系统监控) - 部分禁用
6. Audit (审计日志) - 部分禁用
7. Memories (记忆管理)
8. Devices (设备管理)
9. Settings (设置)

---

## 10. 检查清单

### 10.1 开发前检查

- [ ] 阅读本设计标准文档
- [ ] 检查设计令牌是否满足需求
- [ ] 确认所需 UI 组件已存在
- [ ] 查看是否有类似页面可参考

### 10.2 开发中检查

- [ ] 使用设计令牌而非硬编码值
- [ ] 遵循组件文件结构规范
- [ ] 实现所有必需的状态（加载、错误、空数据）
- [ ] 使用正确的图标和组件

### 10.3 开发后检查

- [ ] 代码通过 lint 检查
- [ ] 所有 TypeScript 类型正确
- [ ] 响应式布局测试通过
- [ ] 暗色主题显示正常

---

## 附录 A: 设计令牌速查

### 颜色
```css
--color-primary: #6366f1;
--color-primary-hover: #4f46e5;
--color-success: #22c55e;
--color-warning: #eab308;
--color-error: #ef4444;
--color-info: #3b82f6;
```

### 间距
```css
--spacing-xs: 4px;
--spacing-sm: 8px;
--spacing-md: 12px;
--spacing-lg: 16px;
--spacing-xl: 24px;
--spacing-2xl: 32px;
```

### 字体大小
```css
--font-size-xs: 10px;
--font-size-sm: 12px;
--font-size-base: 14px;
--font-size-lg: 16px;
--font-size-xl: 20px;
--font-size-2xl: 24px;
```

---

## 附录 B: 参考文档

- [页面开发模板](page-template.md)
- [项目架构文档](dual-connection-architecture.md)
- [Hook 使用指南](README.md)
