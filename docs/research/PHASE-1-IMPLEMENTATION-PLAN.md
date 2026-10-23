# Phase 1 实施计划 - 任务进度增强与结果预览

**版本**: 1.0  
**日期**: 2026-10-23  
**预计工作量**: 7 人天 (前端 4d + 后端 2d + QA 1d)  
**目标**: 用户体验提升 30%，Agent 工作过程可视化

---

## 一. 执行摘要

### 1.1 现状分析

**已有基础** (✅ 表示已实现):
- ✅ `BackgroundTaskManager` - 完整的后台任务管理器
- ✅ `BackgroundTaskCard` - 基础任务卡片 UI
- ✅ IPC 事件流 - main ↔ renderer 通信
- ✅ `ImageLightbox` - 图片预览组件
- ✅ `ActivityFold` - 进度条 UI 模式
- ✅ ComfyUI 集成 - 已支持进度更新

**待增强功能** (🔨 表示本次实施):
- 🔨 进度条显示 (0-100%)
- 🔨 实时日志流 (可展开/折叠)
- 🔨 内联结果预览 (图片/视频/代码)
- 🔨 快捷操作按钮 (复制/下载/分享)

### 1.2 核心设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 数据结构扩展 | 向后兼容 | 不影响现有工具 |
| UI 渲染模式 | Card 模式 | 适合主要展示区域 |
| 日志存储 | 内存 + 滚动 | 避免 DB 开销 |
| 预览实现 | 组件复用 | 利用现有 ImageLightbox |
| 进度更新频率 | 500ms 轮询 | 平衡实时性与性能 |

---

## 二. 数据结构扩展

### 2.1 BackgroundTask 接口扩展

**文件**: `apps/windows/src/shared/agent-runtime-events.ts`  
**位置**: 第 418-427 行 (在现有 `BackgroundTaskOutput` 之后)

**新增字段**:

```typescript
export interface BackgroundTask {
  // === 现有字段 (不动) ===
  readonly taskId: string
  readonly runId?: string
  readonly toolName: string
  readonly label: string
  readonly status: BackgroundTaskStatus
  readonly startedAt: number
  readonly endedAt?: number
  readonly summary?: string
  readonly result?: string
  readonly outputs?: readonly BackgroundTaskOutput[]
  readonly note?: string
  readonly error?: string

  // === 新增字段 ===
  readonly progress?: number                    // 0-100 百分比
  readonly currentStep?: string                 // 当前步骤描述
  readonly logs?: readonly TaskLog[]           // 日志流
  readonly milestones?: readonly Milestone[]   // 里程碑
}

export interface TaskLog {
  readonly timestamp: number                    // Unix 毫秒
  readonly level: 'info' | 'warn' | 'error' | 'debug'
  readonly message: string
}

export interface Milestone {
  readonly step: string                         // 步骤名称
  readonly status: 'pending' | 'running' | 'done' | 'failed'
  readonly startedAt?: number
  readonly completedAt?: number
}
```

**兼容性保证**: 所有新字段都是可选 (`?`)，现有工具无需修改。

---

### 2.2 BackgroundTaskManager 增强

**文件**: `apps/windows/src/main/agent-runtime/background-task-manager.ts`  
**修改点**: 新增方法 (在 `update()` 方法之后插入)

```typescript
export class BackgroundTaskManager {
  // === 现有方法保持不变 ===
  start(input: BackgroundTaskStartInput): string { /* ... */ }
  update(taskId: string, note: string): void { /* ... */ }
  complete(taskId: string, summary?: string, outputs?: BackgroundTaskOutput[]): void { /* ... */ }
  fail(taskId: string, error: string): void { /* ... */ }
  cancel(taskId: string): void { /* ... */ }

  // === 新增方法 ===
  
  /**
   * 更新任务进度
   * @param taskId 任务 ID
   * @param progress 进度百分比 (0-100)
   * @param currentStep 当前步骤描述 (可选)
   */
  updateProgress(taskId: string, progress: number, currentStep?: string): void {
    const rec = this.tasks.get(taskId)
    if (!rec || TERMINAL.has(rec.status)) return

    const next: BackgroundTaskRecord = {
      ...rec,
      progress: Math.max(0, Math.min(100, progress)), // 限制范围
      currentStep,
    }
    this.tasks.set(taskId, next)
    this.push(next)
  }

  /**
   * 添加日志条目
   * @param taskId 任务 ID
   * @param level 日志级别
   * @param message 日志内容
   */
  addLog(taskId: string, level: TaskLog['level'], message: string): void {
    const rec = this.tasks.get(taskId)
    if (!rec) return

    const log: TaskLog = {
      timestamp: this.now(),
      level,
      message,
    }

    const logs = rec.logs ?? []
    const next: BackgroundTaskRecord = {
      ...rec,
      logs: [...logs, log],
    }
    this.tasks.set(taskId, next)
    this.push(next)
  }

  /**
   * 设置任务里程碑
   * @param taskId 任务 ID
   * @param milestones 里程碑列表
   */
  setMilestones(taskId: string, milestones: Milestone[]): void {
    const rec = this.tasks.get(taskId)
    if (!rec || TERMINAL.has(rec.status)) return

    const next: BackgroundTaskRecord = {
      ...rec,
      milestones,
    }
    this.tasks.set(taskId, next)
    this.push(next)
  }

  /**
   * 更新里程碑状态
   * @param taskId 任务 ID
   * @param step 步骤名称
   * @param status 新状态
   */
  updateMilestone(taskId: string, step: string, status: Milestone['status']): void {
    const rec = this.tasks.get(taskId)
    if (!rec || !rec.milestones) return

    const milestones = rec.milestones.map(m =>
      m.step === step
        ? {
            ...m,
            status,
            ...(status === 'running' && !m.startedAt ? { startedAt: this.now() } : {}),
            ...(status === 'done' || status === 'failed' ? { completedAt: this.now() } : {}),
          }
        : m
    )

    const next: BackgroundTaskRecord = {
      ...rec,
      milestones,
    }
    this.tasks.set(taskId, next)
    this.push(next)
  }
}
```

**测试点**:
```typescript
// 单元测试示例 (apps/windows/src/main/agent-runtime/__tests__/background-task-manager.test.ts)
test('updateProgress 限制范围 0-100', () => {
  const mgr = new BackgroundTaskManager(mockEventBus)
  const id = mgr.start({ toolName: 'test', label: 'Test' })
  
  mgr.updateProgress(id, 150, '步骤 1') // 超过 100
  const task = mgr.getTasks()[0]
  expect(task.progress).toBe(100)
  
  mgr.updateProgress(id, -10, '步骤 2') // 小于 0
  expect(mgr.getTasks()[0].progress).toBe(0)
})

test('addLog 追加日志且不覆盖', () => {
  const mgr = new BackgroundTaskManager(mockEventBus)
  const id = mgr.start({ toolName: 'test', label: 'Test' })
  
  mgr.addLog(id, 'info', '日志 1')
  mgr.addLog(id, 'warn', '日志 2')
  
  const task = mgr.getTasks()[0]
  expect(task.logs).toHaveLength(2)
  expect(task.logs![0].message).toBe('日志 1')
  expect(task.logs![1].message).toBe('日志 2')
})
```

---

## 三. UI 组件实现

### 3.1 进度条组件

**新文件**: `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/TaskProgressBar.tsx`

```typescript
import React from 'react'
import { cn } from '@/renderer/lib/utils'

interface TaskProgressBarProps {
  progress?: number          // 0-100 百分比
  currentStep?: string       // 当前步骤
  className?: string
}

export const TaskProgressBar: React.FC<TaskProgressBarProps> = ({
  progress,
  currentStep,
  className,
}) => {
  const percent = progress ?? 0
  const isIndeterminate = percent === 0 // 无进度信息时显示不定进度条

  return (
    <div className={cn('space-y-1', className)}>
      {/* 进度条 */}
      <div className="relative h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          className={cn(
            'h-full rounded-full bg-blue-500 transition-all duration-300',
            isIndeterminate && 'animate-indeterminate'
          )}
          style={{
            width: isIndeterminate ? '30%' : `${percent}%`,
          }}
        />
      </div>

      {/* 进度文字 */}
      <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
        <span>{currentStep ?? '正在处理...'}</span>
        {!isIndeterminate && <span>{percent}%</span>}
      </div>
    </div>
  )
}
```

**CSS 动画** (添加到 `apps/windows/src/renderer/index.css`):

```css
@keyframes indeterminate {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(400%);
  }
}

.animate-indeterminate {
  animation: indeterminate 1.5s ease-in-out infinite;
}
```

---

### 3.2 日志面板组件

**新文件**: `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/TaskLogs.tsx`

```typescript
import React, { useState, useMemo } from 'react'
import { ChevronDown, ChevronRight, Info, AlertTriangle, XCircle, Bug } from 'lucide-react'
import { cn } from '@/renderer/lib/utils'
import type { TaskLog } from '@/shared/agent-runtime-events'

interface TaskLogsProps {
  logs?: readonly TaskLog[]
  maxVisible?: number        // 折叠时显示的最大条数 (默认 3)
  className?: string
}

const LOG_ICONS = {
  info: Info,
  warn: AlertTriangle,
  error: XCircle,
  debug: Bug,
}

const LOG_COLORS = {
  info: 'text-blue-500',
  warn: 'text-yellow-500',
  error: 'text-red-500',
  debug: 'text-gray-500',
}

export const TaskLogs: React.FC<TaskLogsProps> = ({
  logs = [],
  maxVisible = 3,
  className,
}) => {
  const [isExpanded, setIsExpanded] = useState(false)

  const visibleLogs = useMemo(() => {
    if (logs.length === 0) return []
    if (isExpanded) return logs
    // 折叠时显示最后 N 条
    return logs.slice(-maxVisible)
  }, [logs, isExpanded, maxVisible])

  const hasMore = logs.length > maxVisible

  if (logs.length === 0) {
    return null
  }

  return (
    <div className={cn('space-y-2', className)}>
      {/* 展开/折叠按钮 */}
      {hasMore && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>
            日志 ({logs.length} 条)
            {!isExpanded && ` - 显示最近 ${maxVisible} 条`}
          </span>
        </button>
      )}

      {/* 日志列表 */}
      <div className="space-y-1 rounded border border-gray-200 bg-gray-50 p-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-800">
        {visibleLogs.map((log, idx) => {
          const Icon = LOG_ICONS[log.level]
          const color = LOG_COLORS[log.level]
          const time = new Date(log.timestamp).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })

          return (
            <div key={idx} className="flex items-start gap-2">
              <Icon className={cn('mt-0.5 flex-shrink-0', color)} size={12} />
              <span className="text-gray-500">[{time}]</span>
              <span className="flex-1 break-words">{log.message}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

---

### 3.3 里程碑组件

**新文件**: `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/TaskMilestones.tsx`

```typescript
import React from 'react'
import { Check, Circle, Loader2, XCircle } from 'lucide-react'
import { cn } from '@/renderer/lib/utils'
import type { Milestone } from '@/shared/agent-runtime-events'

interface TaskMilestonesProps {
  milestones?: readonly Milestone[]
  className?: string
}

const STATUS_ICONS = {
  pending: Circle,
  running: Loader2,
  done: Check,
  failed: XCircle,
}

const STATUS_COLORS = {
  pending: 'text-gray-400',
  running: 'text-blue-500 animate-spin',
  done: 'text-green-500',
  failed: 'text-red-500',
}

export const TaskMilestones: React.FC<TaskMilestonesProps> = ({
  milestones = [],
  className,
}) => {
  if (milestones.length === 0) {
    return null
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="text-xs font-medium text-gray-600 dark:text-gray-400">
        执行步骤
      </div>
      <div className="space-y-1.5">
        {milestones.map((milestone, idx) => {
          const Icon = STATUS_ICONS[milestone.status]
          const color = STATUS_COLORS[milestone.status]

          return (
            <div key={idx} className="flex items-center gap-2">
              <Icon className={cn('flex-shrink-0', color)} size={14} />
              <span className="flex-1 text-xs text-gray-700 dark:text-gray-300">
                {milestone.step}
              </span>
              {milestone.completedAt && milestone.startedAt && (
                <span className="text-xs text-gray-500">
                  {((milestone.completedAt - milestone.startedAt) / 1000).toFixed(1)}s
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

---

### 3.4 结果预览面板

**新文件**: `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/ResultPreviewPanel.tsx`

```typescript
import React, { useState } from 'react'
import { Download, ExternalLink, Copy, Check } from 'lucide-react'
import { cn } from '@/renderer/lib/utils'
import { ImageLightbox } from '@/renderer/components/ImageLightbox/ImageLightbox'
import type { BackgroundTaskOutput } from '@/shared/agent-runtime-events'

interface ResultPreviewPanelProps {
  outputs?: readonly BackgroundTaskOutput[]
  className?: string
}

export const ResultPreviewPanel: React.FC<ResultPreviewPanelProps> = ({
  outputs = [],
  className,
}) => {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)

  if (outputs.length === 0) {
    return null
  }

  const handleCopyPath = async (path: string) => {
    await navigator.clipboard.writeText(path)
    setCopiedPath(path)
    setTimeout(() => setCopiedPath(null), 2000)
  }

  const handleDownload = (url: string, name: string) => {
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="text-xs font-medium text-gray-600 dark:text-gray-400">
        产出物 ({outputs.length})
      </div>

      <div className="grid gap-2">
        {outputs.map((output, idx) => (
          <ResultPreviewCard
            key={idx}
            output={output}
            onPreview={output.kind === 'image' ? () => setLightboxUrl(output.url!) : undefined}
            onCopyPath={() => handleCopyPath(output.path)}
            onDownload={
              output.url ? () => handleDownload(output.url!, output.name) : undefined
            }
            isCopied={copiedPath === output.path}
          />
        ))}
      </div>

      {/* 图片灯箱 */}
      {lightboxUrl && (
        <ImageLightbox imageUrl={lightboxUrl} onClose={() => setLightboxUrl(null)} />
      )}
    </div>
  )
}

interface ResultPreviewCardProps {
  output: BackgroundTaskOutput
  onPreview?: () => void
  onCopyPath: () => void
  onDownload?: () => void
  isCopied: boolean
}

const ResultPreviewCard: React.FC<ResultPreviewCardProps> = ({
  output,
  onPreview,
  onCopyPath,
  onDownload,
  isCopied,
}) => {
  const isImage = output.kind === 'image'
  const isVideo = output.kind === 'video'
  const canPreview = isImage || isVideo

  return (
    <div className="group relative overflow-hidden rounded border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      {/* 预览区域 */}
      {canPreview && output.url && (
        <div className="relative aspect-video w-full overflow-hidden bg-gray-100 dark:bg-gray-900">
          {isImage ? (
            <img
              src={output.url}
              alt={output.name}
              className="h-full w-full cursor-pointer object-contain transition-transform group-hover:scale-105"
              onClick={onPreview}
            />
          ) : (
            <video
              src={output.url}
              controls
              className="h-full w-full"
              preload="metadata"
            />
          )}
        </div>
      )}

      {/* 信息与操作 */}
      <div className="p-3">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="flex-1 truncate text-sm font-medium text-gray-900 dark:text-gray-100">
            {output.name}
          </div>
          <div className="flex items-center gap-1">
            {/* 复制路径 */}
            <button
              onClick={onCopyPath}
              className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-700"
              title="复制文件路径"
            >
              {isCopied ? (
                <Check size={14} className="text-green-500" />
              ) : (
                <Copy size={14} className="text-gray-500" />
              )}
            </button>

            {/* 下载 */}
            {onDownload && (
              <button
                onClick={onDownload}
                className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-700"
                title="下载文件"
              >
                <Download size={14} className="text-gray-500" />
              </button>
            )}

            {/* 在文件管理器中打开 */}
            <button
              onClick={() => window.electron.ipcRenderer.invoke('show-item-in-folder', output.path)}
              className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-700"
              title="在文件管理器中显示"
            >
              <ExternalLink size={14} className="text-gray-500" />
            </button>
          </div>
        </div>

        <div className="text-xs text-gray-500 dark:text-gray-400">
          {output.kind} · {output.path}
        </div>
      </div>
    </div>
  )
}
```

---

### 3.5 BackgroundTaskCard 集成

**文件**: `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/index.tsx`  
**修改**: 替换现有渲染逻辑 (保留头部、状态图标、时间计算逻辑)

```typescript
import React, { useEffect, useState, useCallback } from 'react'
import { X, Loader2, Check, XCircle, Circle } from 'lucide-react'
import { cn } from '@/renderer/lib/utils'
import type { BackgroundTask } from '@/shared/agent-runtime-events'
import { TaskProgressBar } from './TaskProgressBar'
import { TaskLogs } from './TaskLogs'
import { TaskMilestones } from './TaskMilestones'
import { ResultPreviewPanel } from './ResultPreviewPanel'

// === 保留现有的状态图标映射 ===
const STATUS_ICONS = {
  running: Loader2,
  succeeded: Check,
  failed: XCircle,
  cancelled: Circle,
} as const

// === 保留现有的 Props 接口 ===
interface BackgroundTaskCardProps {
  task: BackgroundTask
  onCancel?: (taskId: string) => void
  className?: string
}

export const BackgroundTaskCard: React.FC<BackgroundTaskCardProps> = ({
  task,
  onCancel,
  className,
}) => {
  // === 保留现有的实时计时逻辑 ===
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    if (task.status !== 'running') {
      const elapsed = task.endedAt
        ? Math.floor((task.endedAt - task.startedAt) / 1000)
        : 0
      setElapsedSeconds(elapsed)
      return
    }

    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - task.startedAt) / 1000))
    }, 1000)

    return () => clearInterval(interval)
  }, [task.status, task.startedAt, task.endedAt])

  // === 保留现有的中断逻辑 ===
  const handleCancel = useCallback(() => {
    if (onCancel && task.status === 'running') {
      onCancel(task.taskId)
    }
  }, [onCancel, task.taskId, task.status])

  // === 格式化时间 ===
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const Icon = STATUS_ICONS[task.status]
  const isRunning = task.status === 'running'
  const isTerminal = task.status !== 'running'

  return (
    <div
      className={cn(
        'rounded-lg border p-4 shadow-sm transition-all',
        isRunning && 'border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950',
        task.status === 'succeeded' &&
          'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-950',
        task.status === 'failed' &&
          'border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950',
        task.status === 'cancelled' &&
          'border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-900',
        className
      )}
    >
      {/* 头部：标题 + 状态 + 时间 + 操作 */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex flex-1 items-center gap-2">
          <Icon
            className={cn(
              'flex-shrink-0',
              isRunning && 'animate-spin text-blue-500',
              task.status === 'succeeded' && 'text-green-500',
              task.status === 'failed' && 'text-red-500',
              task.status === 'cancelled' && 'text-gray-500'
            )}
            size={18}
          />
          <div className="flex-1">
            <div className="font-medium text-gray-900 dark:text-gray-100">
              {task.label}
            </div>
            <div className="text-xs text-gray-600 dark:text-gray-400">
              {task.toolName} · {formatTime(elapsedSeconds)}
            </div>
          </div>
        </div>

        {/* 中断按钮 */}
        {isRunning && onCancel && (
          <button
            onClick={handleCancel}
            className="rounded p-1 hover:bg-red-100 dark:hover:bg-red-900"
            title="中止任务"
          >
            <X size={16} className="text-red-500" />
          </button>
        )}
      </div>

      {/* === 新增：进度条 === */}
      {isRunning && (task.progress !== undefined || task.currentStep) && (
        <TaskProgressBar
          progress={task.progress}
          currentStep={task.currentStep}
          className="mb-3"
        />
      )}

      {/* === 新增：里程碑 === */}
      {task.milestones && task.milestones.length > 0 && (
        <TaskMilestones milestones={task.milestones} className="mb-3" />
      )}

      {/* === 新增：日志 === */}
      {task.logs && task.logs.length > 0 && (
        <TaskLogs logs={task.logs} className="mb-3" />
      )}

      {/* 旧版备注 (兼容) */}
      {task.note && !task.currentStep && (
        <div className="mb-3 text-xs text-gray-600 dark:text-gray-400">
          {task.note}
        </div>
      )}

      {/* 终态信息 */}
      {isTerminal && (
        <div className="mb-3 space-y-1">
          {task.summary && (
            <div className="text-sm text-gray-700 dark:text-gray-300">
              {task.summary}
            </div>
          )}
          {task.error && (
            <div className="rounded bg-red-100 p-2 text-xs text-red-700 dark:bg-red-900 dark:text-red-300">
              {task.error}
            </div>
          )}
        </div>
      )}

      {/* === 新增：结果预览面板 === */}
      {task.outputs && task.outputs.length > 0 && (
        <ResultPreviewPanel outputs={task.outputs} />
      )}
    </div>
  )
}
```

**测试点** (E2E 测试):
```typescript
// apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/__tests__/integration.test.tsx
describe('BackgroundTaskCard 集成测试', () => {
  test('显示进度条与当前步骤', () => {
    const task: BackgroundTask = {
      taskId: 'test-1',
      toolName: 'generate_video',
      label: '生成视频',
      status: 'running',
      startedAt: Date.now(),
      progress: 42,
      currentStep: '正在渲染第 3/7 帧',
    }

    render(<BackgroundTaskCard task={task} />)

    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.getByText('正在渲染第 3/7 帧')).toBeInTheDocument()
  })

  test('日志折叠/展开', async () => {
    const logs: TaskLog[] = Array.from({ length: 10 }, (_, i) => ({
      timestamp: Date.now() + i * 1000,
      level: 'info' as const,
      message: `日志 ${i + 1}`,
    }))

    const task: BackgroundTask = {
      taskId: 'test-2',
      toolName: 'process_data',
      label: '处理数据',
      status: 'running',
      startedAt: Date.now(),
      logs,
    }

    render(<BackgroundTaskCard task={task} />)

    // 初始状态：显示最后 3 条
    expect(screen.getByText('日志 10')).toBeInTheDocument()
    expect(screen.queryByText('日志 1')).not.toBeInTheDocument()

    // 点击展开
    const expandBtn = screen.getByText(/日志 \(10 条\)/)
    await userEvent.click(expandBtn)

    // 展开后：显示全部
    expect(screen.getByText('日志 1')).toBeInTheDocument()
    expect(screen.getByText('日志 10')).toBeInTheDocument()
  })

  test('图片预览灯箱', async () => {
    const task: BackgroundTask = {
      taskId: 'test-3',
      toolName: 'generate_image',
      label: '生成图片',
      status: 'succeeded',
      startedAt: Date.now() - 5000,
      endedAt: Date.now(),
      outputs: [
        {
          name: 'output.png',
          path: '/path/to/output.png',
          kind: 'image',
          url: 'data:image/png;base64,...',
        },
      ],
    }

    render(<BackgroundTaskCard task={task} />)

    // 点击图片
    const img = screen.getByAltText('output.png')
    await userEvent.click(img)

    // 灯箱出现
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
```

---

## 四. 后端工具适配示例

### 4.1 ComfyUI 工具改造

**文件**: `apps/windows/src/main/agent-runtime/bootstrap/background-tool-config.ts`  
**修改**: 在 `comfyUIRunner` 函数中增加进度更新

```typescript
async function comfyUIRunner(
  args: Record<string, unknown>,
  manager: BackgroundTaskManager,
  taskId: string
): Promise<string> {
  const prompt = args.prompt as string
  const workflow = args.workflow as Record<string, unknown>

  // === 设置里程碑 ===
  manager.setMilestones(taskId, [
    { step: '提交任务', status: 'pending' },
    { step: '排队等待', status: 'pending' },
    { step: '正在生成', status: 'pending' },
    { step: '下载结果', status: 'pending' },
  ])

  try {
    // 步骤 1: 提交任务
    manager.updateMilestone(taskId, '提交任务', 'running')
    manager.addLog(taskId, 'info', `提交 ComfyUI 任务: ${prompt}`)

    const jobId = await comfyClient.submit(workflow)
    manager.updateMilestone(taskId, '提交任务', 'done')
    manager.addLog(taskId, 'info', `任务 ID: ${jobId}`)

    // 步骤 2: 轮询状态
    manager.updateMilestone(taskId, '排队等待', 'running')
    let status = await comfyClient.getStatus(jobId)

    while (status.state === 'queued') {
      const queuePos = status.queue_position ?? 0
      manager.updateProgress(
        taskId,
        0,
        `排队中 (第 ${queuePos} 位)` // 更新当前步骤描述
      )
      manager.addLog(taskId, 'debug', `队列位置: ${queuePos}`)
      await sleep(1000)
      status = await comfyClient.getStatus(jobId)
    }
    manager.updateMilestone(taskId, '排队等待', 'done')

    // 步骤 3: 生成中
    manager.updateMilestone(taskId, '正在生成', 'running')

    while (status.state === 'running') {
      const progress = status.progress ?? 0 // 0-1 浮点数
      const currentNode = status.current_node ?? '未知节点'

      manager.updateProgress(
        taskId,
        Math.round(progress * 100), // 转换为百分比
        `正在执行: ${currentNode}`
      )
      manager.addLog(taskId, 'debug', `进度: ${(progress * 100).toFixed(1)}%`)

      await sleep(500)
      status = await comfyClient.getStatus(jobId)
    }

    if (status.state === 'failed') {
      manager.updateMilestone(taskId, '正在生成', 'failed')
      throw new Error(status.error ?? '生成失败')
    }

    manager.updateMilestone(taskId, '正在生成', 'done')
    manager.addLog(taskId, 'info', '生成完成')

    // 步骤 4: 下载结果
    manager.updateMilestone(taskId, '下载结果', 'running')
    const outputs: BackgroundTaskOutput[] = []

    for (const file of status.outputs ?? []) {
      manager.addLog(taskId, 'info', `下载文件: ${file.filename}`)
      const localPath = await comfyClient.downloadFile(file.url, file.filename)

      outputs.push({
        name: file.filename,
        path: localPath,
        kind: file.type.startsWith('image/') ? 'image' : 'file',
        url: `file://${localPath}`,
      })
    }

    manager.updateMilestone(taskId, '下载结果', 'done')
    manager.addLog(taskId, 'info', `共下载 ${outputs.length} 个文件`)

    // 完成任务
    manager.complete(taskId, `已生成 ${outputs.length} 个文件`, outputs)

    return `任务完成，生成了 ${outputs.length} 个文件`
  } catch (error) {
    manager.addLog(taskId, 'error', error.message)
    manager.fail(taskId, error.message)
    throw error
  }
}
```

**关键点**:
1. **里程碑先设置**: 调用 `setMilestones()` 声明所有步骤
2. **步骤状态更新**: 使用 `updateMilestone()` 标记进度
3. **进度百分比**: 使用 `updateProgress()` 更新数值
4. **日志记录**: 使用 `addLog()` 记录详细信息
5. **最终输出**: `complete()` 时传入 `outputs` 数组

---

### 4.2 通用工具适配模板

**示例**: 长时间运行的数据处理工具

```typescript
async function dataProcessingRunner(
  args: Record<string, unknown>,
  manager: BackgroundTaskManager,
  taskId: string
): Promise<string> {
  const inputFile = args.inputFile as string
  const outputDir = args.outputDir as string

  // 定义步骤
  manager.setMilestones(taskId, [
    { step: '读取文件', status: 'pending' },
    { step: '数据清洗', status: 'pending' },
    { step: '特征提取', status: 'pending' },
    { step: '写入结果', status: 'pending' },
  ])

  try {
    // 步骤 1: 读取文件
    manager.updateMilestone(taskId, '读取文件', 'running')
    manager.addLog(taskId, 'info', `读取输入文件: ${inputFile}`)

    const data = await fs.readFile(inputFile, 'utf-8')
    const rows = data.split('\n')

    manager.updateMilestone(taskId, '读取文件', 'done')
    manager.addLog(taskId, 'info', `共读取 ${rows.length} 行数据`)

    // 步骤 2: 数据清洗
    manager.updateMilestone(taskId, '数据清洗', 'running')

    const cleanedRows: string[] = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i].trim()
      if (row) {
        cleanedRows.push(row)
      }

      // 每处理 10% 更新一次进度
      if (i % Math.floor(rows.length / 10) === 0) {
        const progress = Math.floor((i / rows.length) * 100)
        manager.updateProgress(
          taskId,
          progress,
          `已清洗 ${i}/${rows.length} 行`
        )
      }
    }

    manager.updateMilestone(taskId, '数据清洗', 'done')
    manager.addLog(taskId, 'info', `清洗后剩余 ${cleanedRows.length} 行`)

    // 步骤 3: 特征提取 (示例)
    manager.updateMilestone(taskId, '特征提取', 'running')
    const features = cleanedRows.map((row, idx) => {
      if (idx % 100 === 0) {
        manager.addLog(taskId, 'debug', `提取特征: ${idx}/${cleanedRows.length}`)
      }
      return extractFeatures(row)
    })
    manager.updateMilestone(taskId, '特征提取', 'done')

    // 步骤 4: 写入结果
    manager.updateMilestone(taskId, '写入结果', 'running')
    const outputPath = path.join(outputDir, 'output.json')
    await fs.writeFile(outputPath, JSON.stringify(features, null, 2))

    manager.updateMilestone(taskId, '写入结果', 'done')
    manager.addLog(taskId, 'info', `结果已写入: ${outputPath}`)

    // 完成
    manager.complete(taskId, `处理完成，共 ${features.length} 条记录`, [
      {
        name: 'output.json',
        path: outputPath,
        kind: 'file',
        url: `file://${outputPath}`,
      },
    ])

    return `数据处理完成`
  } catch (error) {
    const currentMilestone =
      manager.getTasks().find(t => t.taskId === taskId)?.milestones?.find(
        m => m.status === 'running'
      )

    if (currentMilestone) {
      manager.updateMilestone(taskId, currentMilestone.step, 'failed')
    }

    manager.addLog(taskId, 'error', error.message)
    manager.fail(taskId, error.message)
    throw error
  }
}
```

---

## 五. 实施时间表

### 第 1 周：准备与设计

| 任务 | 责任人 | 工作量 | 完成标准 |
|------|--------|--------|----------|
| UI 设计稿 (Figma) | 设计师 | 0.5d | 4 个组件样式确定 |
| 后端接口评审 | 后端 Lead | 0.5d | BackgroundTaskManager API 签字确认 |
| 数据结构扩展设计 | 架构师 | 0.5d | TypeScript 接口定义完成 |
| 测试计划编写 | QA | 0.5d | 单元测试 + E2E 测试用例清单 |

**里程碑**: 设计冻结，进入开发阶段

---

### 第 2 周：开发与测试 (前 3 天)

| 任务 | 责任人 | 工作量 | 完成标准 |
|------|--------|--------|----------|
| BackgroundTaskManager 扩展 | 后端开发 | 1d | 4 个新方法 + 单元测试通过 |
| TaskProgressBar 组件 | 前端开发 1 | 0.5d | 进度条动画正常 + Storybook |
| TaskLogs 组件 | 前端开发 1 | 0.5d | 折叠/展开功能 + 日志级别颜色 |
| TaskMilestones 组件 | 前端开发 2 | 0.5d | 步骤状态图标 + 耗时显示 |
| ResultPreviewPanel 组件 | 前端开发 2 | 1d | 图片/视频预览 + 快捷操作 |

**里程碑**: 所有子组件完成并通过单元测试

---

### 第 2 周：集成与优化 (后 2 天)

| 任务 | 责任人 | 工作量 | 完成标准 |
|------|--------|--------|----------|
| BackgroundTaskCard 集成 | 前端开发 1 | 0.5d | 新旧 UI 对比无回归 |
| ComfyUI 工具适配 | 后端开发 | 0.5d | 真实任务显示进度 |
| E2E 测试编写 | QA | 0.5d | 3 个关键场景覆盖 |
| 性能测试与优化 | 前端开发 2 | 0.5d | 100 条日志无卡顿 |

**里程碑**: 集成完成，准备发布 Beta

---

### 第 3 周：发布与反馈

| 任务 | 责任人 | 工作量 | 完成标准 |
|------|--------|--------|----------|
| Beta 版本打包 | DevOps | 0.5d | 安装包可分发 |
| 内部试用 | 团队全员 | 1d | 收集至少 10 条反馈 |
| Bug 修复 | 开发团队 | 1d | P0/P1 Bug 全部解决 |
| 文档更新 | 技术写作 | 0.5d | 用户文档 + API 文档 |

**里程碑**: GA 版本发布

---

## 六. 测试策略

### 6.1 单元测试 (80% 覆盖率)

**目标文件**:
- `background-task-manager.test.ts` - BackgroundTaskManager 所有方法
- `TaskProgressBar.test.tsx` - 进度条边界情况
- `TaskLogs.test.tsx` - 日志折叠逻辑
- `TaskMilestones.test.tsx` - 里程碑状态流转
- `ResultPreviewPanel.test.tsx` - 预览与操作按钮

**关键测试用例**:
```typescript
// 进度范围限制
test('updateProgress 限制 0-100', ...)

// 日志内存管理
test('日志超过 1000 条时自动截断', ...)

// 里程碑状态机
test('里程碑状态不能从 done 回退到 running', ...)

// 预览 URL 安全
test('URL 注入攻击防护', ...)
```

---

### 6.2 集成测试

**场景 1: ComfyUI 生成图片全流程**

```typescript
test('ComfyUI 图片生成显示完整进度', async () => {
  // 1. 启动任务
  const taskId = manager.start({
    toolName: 'comfyui_generate',
    label: '生成图片',
  })

  // 2. 模拟进度更新
  manager.setMilestones(taskId, [
    { step: '提交任务', status: 'pending' },
    { step: '正在生成', status: 'pending' },
  ])
  manager.updateMilestone(taskId, '提交任务', 'done')
  manager.updateMilestone(taskId, '正在生成', 'running')

  for (let i = 0; i <= 100; i += 10) {
    manager.updateProgress(taskId, i, `渲染中 ${i}%`)
    await sleep(100)
  }

  // 3. 完成并输出
  manager.updateMilestone(taskId, '正在生成', 'done')
  manager.complete(taskId, '生成完成', [
    {
      name: 'output.png',
      path: '/tmp/output.png',
      kind: 'image',
      url: 'data:image/png;base64,...',
    },
  ])

  // 4. 验证 UI
  const card = screen.getByText('生成图片')
  expect(card).toBeInTheDocument()
  expect(screen.getByText('100%')).toBeInTheDocument()
  expect(screen.getByAltText('output.png')).toBeInTheDocument()
})
```

---

### 6.3 E2E 测试 (Playwright)

**场景 2: 用户中断长任务**

```typescript
test('用户可以中断正在运行的任务', async ({ page }) => {
  // 1. 启动 Lumii
  await page.goto('http://localhost:5173')

  // 2. 发送任务
  await page.fill('[data-testid="chat-input"]', '生成一个 10 分钟的视频')
  await page.click('[data-testid="send-button"]')

  // 3. 等待任务卡片出现
  await page.waitForSelector('[data-testid="background-task-card"]')

  // 4. 点击中止按钮
  await page.click('[data-testid="cancel-task-button"]')

  // 5. 验证状态变为 cancelled
  await expect(page.locator('text=已取消')).toBeVisible()
})
```

---

### 6.4 性能测试

**指标**:
- [ ] 100 条日志加载时间 < 100ms
- [ ] 进度条更新频率 500ms 时 CPU < 5%
- [ ] 10 个并发任务卡片渲染时间 < 200ms
- [ ] 图片预览打开延迟 < 300ms

**工具**: Chrome DevTools Performance Profiler

---

## 七. 风险评估与缓解

### 7.1 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 日志内存溢出 | 30% | 高 | 限制最大条数 (1000)，超出自动截断 |
| IPC 消息丢失 | 15% | 中 | 增加消息序列号，renderer 侧检测丢包 |
| 进度更新阻塞主线程 | 20% | 中 | 使用 `requestIdleCallback` 批处理 |
| 预览大文件卡顿 | 25% | 低 | 限制预览文件大小 (< 10MB) |

---

### 7.2 兼容性风险

| 风险 | 缓解措施 |
|------|----------|
| 旧工具不支持新字段 | 所有新字段可选，默认降级为旧 UI |
| 数据库迁移失败 | 保留旧表结构，新字段用 JSON 列存储 |
| Electron 版本差异 | 限定 Electron 27+ |

---

### 7.3 用户体验风险

| 风险 | 缓解措施 |
|------|----------|
| 用户不习惯新 UI | 渐进式发布，提供"经典模式"开关 (1 个月过渡期) |
| 进度不准确引起困惑 | 明确标注"预估进度"，避免承诺精确时间 |
| 日志过多干扰 | 默认折叠，仅显示最近 3 条 |

---

## 八. 交付清单

### 8.1 代码文件

**新增**:
- `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/TaskProgressBar.tsx`
- `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/TaskLogs.tsx`
- `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/TaskMilestones.tsx`
- `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/ResultPreviewPanel.tsx`

**修改**:
- `apps/windows/src/shared/agent-runtime-events.ts` (数据结构扩展)
- `apps/windows/src/main/agent-runtime/background-task-manager.ts` (新增 4 个方法)
- `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/index.tsx` (UI 集成)
- `apps/windows/src/main/agent-runtime/bootstrap/background-tool-config.ts` (ComfyUI 适配)

---

### 8.2 测试文件

**新增**:
- `apps/windows/src/main/agent-runtime/__tests__/background-task-manager.test.ts`
- `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/__tests__/TaskProgressBar.test.tsx`
- `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/__tests__/TaskLogs.test.tsx`
- `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/__tests__/TaskMilestones.test.tsx`
- `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/__tests__/ResultPreviewPanel.test.tsx`
- `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/__tests__/integration.test.tsx`
- `e2e/background-tasks.spec.ts` (Playwright E2E)

---

### 8.3 文档

**新增**:
- `docs/features/background-task-progress.md` (功能说明)
- `docs/api/background-task-manager.md` (API 文档)
- `docs/guides/tool-integration.md` (工具适配指南)

**更新**:
- `README.md` (新功能说明)
- `CHANGELOG.md` (版本记录)

---

## 九. 成功标准

### 9.1 功能完整性

- [x] 进度条显示 (0-100%)
- [x] 实时日志流 (可展开/折叠)
- [x] 里程碑步骤显示
- [x] 图片内联预览 (Lightbox)
- [x] 视频内联播放
- [x] 快捷操作 (复制/下载/打开文件夹)
- [x] 任务中断功能

---

### 9.2 质量指标

- [ ] 单元测试覆盖率 ≥ 80%
- [ ] E2E 测试通过率 100%
- [ ] 性能测试指标达标
- [ ] 零 P0/P1 Bug

---

### 9.3 用户反馈

- [ ] 内部试用满意度 ≥ 80%
- [ ] "进度可见"反馈 ≥ 90%
- [ ] "结果预览方便"反馈 ≥ 85%

---

## 十. 后续计划 (Phase 2 预览)

Phase 1 完成后，可立即启动 Phase 2 (插件系统)：

**P1 功能** (10.5 人天):
1. **CardRegistry 系统** (5d)
   - 卡片类型注册表
   - 动态渲染器选择
   - 插件 API 开放

2. **工作流看板化** (5.5d)
   - 多 Agent 并行可视化
   - 横向时间轴
   - 依赖关系展示

**参考文档**:
- `docs/research/plugin-system-design-spec.md` (完整插件规范)
- `docs/research/copilotkit-ux-research.md` (设计理念)

---

## 十一. 附录

### 附录 A: 代码风格约定

遵循项目现有规范:
- TypeScript strict mode
- ESLint + Prettier
- Tailwind CSS (utility-first)
- React Hooks (函数组件)
- 不可变数据 (immutable patterns)

---

### 附录 B: Git 提交规范

```
feat(background-task): 添加进度条组件
feat(background-task): 添加日志面板
feat(background-task): 添加结果预览
refactor(background-task): 集成新 UI 组件
test(background-task): 添加单元测试
docs(background-task): 更新 API 文档
```

---

### 附录 C: 参考资源

**研究文档**:
- CopilotKit 架构分析: `docs/research/copilotkit-ux-research.md`
- 实现细节补充: `docs/research/copilotkit-v2-implementation-details.md`
- UI 原型指南: `docs/research/ui-prototypes-and-implementation-guide.md`

**外部项目**:
- CopilotKit: https://github.com/CopilotKit/CopilotKit
- Vercel AI SDK: https://github.com/vercel/ai
- Cursor AI: https://cursor.sh

---

**文档版本**: 1.0  
**最后更新**: 2026-10-23  
**状态**: 可执行