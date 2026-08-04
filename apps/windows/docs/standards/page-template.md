# 页面模板规范

## 标准页面结构

所有新页面应遵循以下模板：

```tsx
import React from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { ErrorBanner } from '@/components/ui/ErrorBanner'
import { Loading } from '@/components/ui/Loading'
import { Button } from '@/components/ui/Button'
import { useSomeData } from '@/hooks/business/useSomeData'

const PageName: React.FC = () => {
  const { data, isLoading, error, refetch } = useSomeData()
  
  // Loading state
  if (isLoading && !data) {
    return <Loading fullPage />
  }
  
  return (
    <div className="page-container">
      {/* Header with title and actions */}
      <PageHeader
        title="页面标题"
        subtitle="可选的副标题描述"
        actions={
          <Button onClick={refetch} variant="secondary">
            刷新
          </Button>
        }
      />
      
      {/* Error display */}
      {error && (
        <ErrorBanner
          message={error instanceof Error ? error.message : String(error)}
          onRetry={refetch}
        />
      )}
      
      {/* Page content */}
      <div className="page-content">
        {/* Your content here */}
      </div>
    </div>
  )
}

export default PageName
```

## 组件使用规范

### 1. 页面头部 (PageHeader)

**必须**: 每个页面都必须使用 PageHeader 组件

```tsx
<PageHeader
  title="页面标题"           // 必需
  subtitle="描述文字"       // 可选
  actions={<Button>操作</Button>}  // 可选 - 右上角操作按钮
/>
```

### 2. 错误提示 (ErrorBanner)

**必须**: 所有错误状态必须使用 ErrorBanner

```tsx
{error && (
  <ErrorBanner
    message={error.message}
    onRetry={retryFunction}    // 可选 - 显示重试按钮
    onDismiss={dismissFunction} // 可选 - 显示关闭按钮
  />
)}
```

### 3. 加载状态 (Loading)

**必须**: 所有加载状态必须使用 Loading 组件

```tsx
// Full page loading
if (isLoading && !data) {
  return <Loading text="加载中..." />
}

// Inline loading
{isLoading && <Loading text="保存中..." />}
```

### 4. 按钮 (Button)

**必须**: 所有按钮必须使用 Button 组件，禁止原生 button

```tsx
// Primary action
<Button onClick={handleSave}>保存</Button>

// Secondary action
<Button variant="secondary" onClick={handleCancel}>取消</Button>

// Ghost/tertiary action
<Button variant="ghost" onClick={handleEdit}>编辑</Button>

// Danger action
<Button variant="danger" onClick={handleDelete}>删除</Button>

// Loading state
<Button loading={isSaving}>保存</Button>

// Disabled state
<Button disabled={!isValid}>提交</Button>

// Size variants
<Button size="sm">小按钮</Button>
<Button size="md">中按钮（默认）</Button>
<Button size="lg">大按钮</Button>
```

### 5. 空状态 (Empty)

**建议**: 数据为空时使用 Empty 组件

```tsx
{data.length === 0 && (
  <Empty
    icon="📭"
    title="暂无数据"
    description="开始添加第一条数据吧"
    action={<Button onClick={handleAdd}>添加</Button>}
  />
)}
```

## CSS 规范

### 不要使用

❌ 原生 button 元素
❌ 自定义 loading 动画
❌ 自定义 error banner 样式
❌ 页面级的 header 样式

### 应该使用

✅ Button 组件
✅ Loading 组件
✅ ErrorBanner 组件
✅ PageHeader 组件

## 文件结构

```
page-name/
├── PageName.tsx          # 主组件
├── PageName.css          # 页面特定样式（仅布局）
├── components/           # 页面专属子组件（可选）
│   ├── ComponentA.tsx
│   └── ComponentA.css
└── hooks/                # 页面专属 hooks（可选）
    └── usePageData.ts
```

## 命名规范

- **页面组件**: PascalCase (e.g., `DashboardPage.tsx`)
- **CSS 类名**: kebab-case (e.g., `.dashboard-page`)
- **Hooks**: camelCase with 'use' prefix (e.g., `useDashboardData.ts`)

## 响应式设计

所有页面应该考虑响应式：

```css
/* Mobile first approach */
.page-content {
  padding: 16px;
}

@media (min-width: 768px) {
  .page-content {
    padding: 24px;
  }
}
```

## 最佳实践

### 页面布局

```tsx
<div className="page-container">
  <PageHeader ... />
  {error && <ErrorBanner ... />}
  <div className="page-content">
    {/* Content */}
  </div>
</div>
```

### CSS 文件组织

```css
/* PageName.css */

/* Container */
.page-container {
  padding: 24px;
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* Content area */
.page-content {
  flex: 1;
  overflow-y: auto;
}

/* Page-specific components */
.custom-widget {
  /* Only styles that are unique to this page */
}
```

### 导入顺序

```tsx
// 1. React imports
import React, { useState, useEffect } from 'react'

// 2. Third-party imports
import { useQuery } from '@tanstack/react-query'

// 3. UI components
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'

// 4. Business components
import { DataTable } from '../components/business/DataTable'

// 5. Hooks
import { useAuth } from '../hooks/useAuth'

// 6. Types
import type { DataItem } from '../types/data'

// 7. Styles
import './PageName.css'
```

### 错误处理模式

```tsx
// Good - uses ErrorBanner
{error && (
  <ErrorBanner
    message={error.message}
    onRetry={refetch}
  />
)}

// Bad - inline error
{error && <div className="error">{error.message}</div>}
```

### 加载状态模式

```tsx
// Good - uses Loading component
if (isLoading && !data) {
  return <Loading text="加载中..." />
}

// Good - inline loading
{isLoading && <Loading text="保存中..." />}

// Bad - custom spinner
{isLoading && <div className="spinner">⏳</div>}
```

## 重构检查清单

当重构现有页面时，检查以下项目：

- [ ] 使用 PageHeader 替代自定义 header
- [ ] 使用 ErrorBanner 替代自定义 error 样式
- [ ] 使用 Loading 替代自定义 loading 动画
- [ ] 使用 Button 替代原生 button
- [ ] 删除冗余的 CSS 样式
- [ ] 确保导入顺序一致
- [ ] 添加必要的 TypeScript 类型

## 组件选择指南

| 场景 | 推荐组件 | 示例 |
|------|---------|------|
| 页面标题 | PageHeader | `<PageHeader title="设置" />` |
| 表单提交 | Button (primary) | `<Button type="submit">保存</Button>` |
| 取消操作 | Button (ghost) | `<Button variant="ghost">取消</Button>` |
| 删除操作 | Button (danger) | `<Button variant="danger">删除</Button>` |
| 图标按钮 | Button (ghost, sm) | `<Button variant="ghost" size="sm">🔍</Button>` |
| 页面加载 | Loading | `<Loading text="加载中..." />` |
| 错误提示 | ErrorBanner | `<ErrorBanner message="错误" onRetry={retry} />` |
| 空数据 | Empty | `<Empty title="暂无数据" />` |

## 注意事项

- **保持 CSS 文件最小化** - 大部分样式应该来自组件
- **如果发现自己写复杂的 CSS，考虑创建组件**
- **总是先检查是否已存在合适的组件**
- **遵循 DRY 原则** - 不要重复造轮子
- **保持一致性** - 所有页面应该有相似的视觉和交互模式
