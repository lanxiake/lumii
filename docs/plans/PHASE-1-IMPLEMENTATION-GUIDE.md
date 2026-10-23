# Phase 1 开发实施计划 - Lumii Agent UI 优化

**版本**: 1.0  
**完成日期**: 2026-10-23  
**时间周期**: 3 周 (2 周开发 + 1 周测试)  
**工作量**: 7 人天 (前端 4 天 + 后端 2 天 + QA 1 天)  
**优先级**: ⭐⭐⭐⭐⭐ (必做)  

---

## 📋 一、概览

### 问题诊断

当前 Lumii Agent 执行流程对用户来说是"黑盒"：
- ❌ 看不到 Agent 在做什么，要等多久
- ❌ 生成的产出物无法就地预览（图片/视频/文档都要打开新窗口）
- ❌ 多个 Agent 并行时，看不清谁在做什么

### Phase 1 解决方案

两个核心功能，2 周快速赢：

| 功能 | 工作量 | 收益 |
|------|--------|------|
| **任务进度增强** | 3 天 | 实时进度条、日志、里程碑 |
| **结果预览面板** | 4-5 天 | 图片/视频/表格/代码就地预览 |

**预期收益**: 用户体验 +30%

---

## 🏗️ 二、数据结构扩展

### 2.1 BackgroundTask 接口扩展

**文件**: `apps/windows/src/renderer/hooks/business/useAgentRuntime/agent-runtime-store.ts`

**现有接口** (lines 266-283):
```typescript
interface BackgroundTask {
  id: string
  agentName: string
  title: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  startTime: number
  endTime?: number
  output?: BackgroundTaskOutput
}
```

**扩展后** (backward compatible):
```typescript
interface BackgroundTask {
  id: string
  agentName: string
  title: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  startTime: number
  endTime?: number
  output?: BackgroundTaskOutput
  
  // === Phase 1 新增字段 ===
  progress?: number                    // 0-100
  currentStep?: string                 // 当前处理步骤描述
  logs?: TaskLog[]                    // 实时日志流
  milestones?: Milestone[]            // 任务里程碑
}
```

### 2.2 TaskLog 接口

```typescript
interface TaskLog {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  timestamp: Date
  // 可选扩展
  context?: Record<string, unknown>   // 上下文信息
}
```

**日志示例**:
```json
{
  "level": "info",
  "message": "正在加载 ComfyUI 模型 (sdxl-turbo)",
  "timestamp": "2026-10-23T14:23:45Z",
  "context": { "model": "sdxl-turbo", "device": "cuda:0" }
}
```

### 2.3 Milestone 接口

```typescript
interface Milestone {
  step: string                        // 步骤名称
  status: 'pending' | 'in-progress' | 'completed' | 'failed'
  startTime?: number                 // Unix 时间戳
  duration?: number                  // 毫秒
  error?: string                     // 失败原因
}
```

**里程碑示例**:
```json
{
  "step": "准备模型",
  "status": "completed",
  "startTime": 1698063825000,
  "duration": 2340
}
```

### 2.4 BackgroundTaskManager 方法扩展

**文件**: `apps/windows/src/main/agent-runtime/background-task-manager.ts`

添加 4 个新方法:

```typescript
class BackgroundTaskManager {
  // 现有方法: start(), update(), complete(), fail(), cancel()
  
  // === Phase 1 新增方法 ===
  
  /**
   * 更新任务进度
   * @param taskId 任务 ID
   * @param progress 进度百分比 (0-100)
   * @param currentStep 当前处理步骤 (可选)
   */
  updateProgress(taskId: string, progress: number, currentStep?: string): void {
    const task = this.store.getState().backgroundTasks[taskId]
    if (!task) return
    
    this.update(taskId, {
      progress: Math.min(100, Math.max(0, progress)),
      currentStep: currentStep || task.currentStep
    })
  }
  
  /**
   * 添加日志条目
   * @param taskId 任务 ID
   * @param level 日志级别
   * @param message 日志消息
   * @param context 上下文信息 (可选)
   */
  addLog(
    taskId: string,
    level: TaskLog['level'],
    message: string,
    context?: Record<string, unknown>
  ): void {
    const task = this.store.getState().backgroundTasks[taskId]
    if (!task) return
    
    const newLog: TaskLog = {
      level,
      message,
      timestamp: new Date(),
      context
    }
    
    const logs = [...(task.logs || []), newLog]
    // 限制日志保留最后 1000 条
    if (logs.length > 1000) {
      logs.shift()
    }
    
    this.update(taskId, { logs })
  }
  
  /**
   * 设置里程碑列表
   * @param taskId 任务 ID
   * @param milestones 里程碑数组
   */
  setMilestones(taskId: string, milestones: Milestone[]): void {
    this.update(taskId, { milestones })
  }
  
  /**
   * 更新单个里程碑状态
   * @param taskId 任务 ID
   * @param step 步骤名称
   * @param status 新状态
   * @param duration 耗时 (毫秒)
   */
  updateMilestone(
    taskId: string,
    step: string,
    status: Milestone['status'],
    duration?: number
  ): void {
    const task = this.store.getState().backgroundTasks[taskId]
    if (!task || !task.milestones) return
    
    const milestones = task.milestones.map(m =>
      m.step === step
        ? { ...m, status, duration }
        : m
    )
    
    this.update(taskId, { milestones })
  }
}
```

---

## 🎨 三、UI 组件实现

### 3.1 TaskProgressBar.tsx

**位置**: `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/TaskProgressBar.tsx`

```typescript
import React, { useMemo } from 'react'
import './TaskProgressBar.css'

interface TaskProgressBarProps {
  progress?: number                    // 0-100
  currentStep?: string
  startTime: number
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
}

export const TaskProgressBar: React.FC<TaskProgressBarProps> = ({
  progress = 0,
  currentStep,
  startTime,
  status
}) => {
  const isRunning = status === 'running'
  const displayProgress = Math.min(100, Math.max(0, progress || 0))
  
  // 计算剩余时间估计 (粗略)
  const elapsed = (Date.now() - startTime) / 1000
  const estimatedTotal = elapsed / ((displayProgress || 1) / 100)
  const remaining = Math.max(0, estimatedTotal - elapsed)
  
  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${Math.round(seconds)}秒`
    const minutes = Math.round(seconds / 60)
    return `${minutes}分钟`
  }
  
  return (
    <div className="task-progress-container">
      <div className="progress-header">
        <span className="progress-text">
          進行中 ({displayProgress}%)
        </span>
        {isRunning && remaining > 5 && (
          <span className="remaining-time">
            预计 {formatTime(remaining)}
          </span>
        )}
      </div>
      
      <div className="progress-bar-wrapper">
        <progress
          className={`progress-bar ${isRunning ? 'indeterminate' : ''}`}
          value={displayProgress}
          max={100}
          aria-label="任务进度"
        />
      </div>
      
      {currentStep && (
        <div className="current-step">
          {currentStep}
        </div>
      )}
    </div>
  )
}
```

**TaskProgressBar.css**:
```css
.task-progress-container {
  padding: 12px;
  background: #f5f5f5;
  border-radius: 6px;
}

.progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 13px;
}

.progress-text {
  font-weight: 500;
  color: #333;
}

.remaining-time {
  color: #999;
  font-size: 12px;
}

.progress-bar-wrapper {
  margin-bottom: 8px;
}

.progress-bar {
  width: 100%;
  height: 6px;
  border: none;
  border-radius: 3px;
  background: #e0e0e0;
  overflow: hidden;
}

.progress-bar::-webkit-progress-bar {
  background: #e0e0e0;
}

.progress-bar::-webkit-progress-value {
  background: linear-gradient(90deg, #4CAF50, #45a049);
  transition: width 0.3s ease;
}

.progress-bar.indeterminate::-webkit-progress-value {
  animation: progress-animation 1.5s infinite;
}

@keyframes progress-animation {
  0% { background-position: 0 0; }
  100% { background-position: 40px 0; }
}

.current-step {
  font-size: 12px;
  color: #666;
  margin-top: 6px;
  padding: 4px 8px;
  background: white;
  border-radius: 4px;
  border-left: 3px solid #4CAF50;
}
```

### 3.2 TaskMilestones.tsx

**位置**: `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/TaskMilestones.tsx`

```typescript
import React from 'react'
import { Milestone } from '@/types/agent-runtime'
import './TaskMilestones.css'

interface TaskMilestonesProps {
  milestones?: Milestone[]
}

const STATUS_ICONS: Record<Milestone['status'], string> = {
  pending: '⏳',
  'in-progress': '🔄',
  completed: '✓',
  failed: '❌'
}

export const TaskMilestones: React.FC<TaskMilestonesProps> = ({ milestones = [] }) => {
  if (!milestones || milestones.length === 0) return null
  
  const completedCount = milestones.filter(m => m.status === 'completed').length
  
  return (
    <div className="task-milestones">
      <div className="milestones-header">
        里程碑 ({completedCount}/{milestones.length})
      </div>
      
      <div className="milestones-list">
        {milestones.map((milestone, index) => (
          <div
            key={`${milestone.step}-${index}`}
            className={`milestone-item milestone-${milestone.status}`}
          >
            <span className="milestone-icon">
              {STATUS_ICONS[milestone.status]}
            </span>
            
            <span className="milestone-step">
              {milestone.step}
            </span>
            
            {milestone.duration && (
              <span className="milestone-duration">
                {(milestone.duration / 1000).toFixed(1)}s
              </span>
            )}
            
            {milestone.error && (
              <span className="milestone-error" title={milestone.error}>
                {milestone.error}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

**TaskMilestones.css**:
```css
.task-milestones {
  padding: 12px;
  background: #f9f9f9;
  border-radius: 6px;
  margin-top: 8px;
}

.milestones-header {
  font-size: 12px;
  font-weight: 500;
  color: #666;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.milestones-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.milestone-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
  transition: background-color 0.2s;
}

.milestone-icon {
  min-width: 16px;
  text-align: center;
  font-size: 13px;
}

.milestone-step {
  flex: 1;
  color: #333;
}

.milestone-duration {
  color: #999;
  font-size: 11px;
  min-width: 40px;
  text-align: right;
}

.milestone-error {
  color: #d32f2f;
  font-size: 11px;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.milestone-completed {
  background: #e8f5e9;
}

.milestone-in-progress {
  background: #e3f2fd;
}

.milestone-pending {
  background: #fff3e0;
}

.milestone-failed {
  background: #ffebee;
}
```

### 3.3 TaskLogs.tsx

**位置**: `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/TaskLogs.tsx`

```typescript
import React, { useState, useRef, useEffect, useMemo } from 'react'
import { TaskLog } from '@/types/agent-runtime'
import './TaskLogs.css'

interface TaskLogsProps {
  logs?: TaskLog[]
  maxHeight?: number
}

const LOG_LEVEL_COLORS: Record<TaskLog['level'], string> = {
  debug: '#90a4ae',
  info: '#1976d2',
  warn: '#f57c00',
  error: '#d32f2f'
}

const LOG_LEVEL_ICONS: Record<TaskLog['level'], string> = {
  debug: '🔧',
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌'
}

export const TaskLogs: React.FC<TaskLogsProps> = ({ logs = [], maxHeight = 200 }) => {
  const [expanded, setExpanded] = useState(false)
  const [filterLevel, setFilterLevel] = useState<TaskLog['level'] | 'all'>('all')
  const logsContainerRef = useRef<HTMLDivElement>(null)
  
  useEffect(() => {
    if (expanded && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight
    }
  }, [expanded, logs])
  
  const filteredLogs = useMemo(() => {
    if (filterLevel === 'all') return logs
    return logs.filter(log => log.level === filterLevel)
  }, [logs, filterLevel])
  
  const levelCounts = useMemo(() => {
    return {
      debug: logs.filter(l => l.level === 'debug').length,
      info: logs.filter(l => l.level === 'info').length,
      warn: logs.filter(l => l.level === 'warn').length,
      error: logs.filter(l => l.level === 'error').length
    }
  }, [logs])
  
  const handleCopy = () => {
    const text = filteredLogs
      .map(log => `[${log.timestamp.toISOString()}] ${log.level.toUpperCase()}: ${log.message}`)
      .join('\n')
    navigator.clipboard.writeText(text)
  }
  
  return (
    <div className="task-logs">
      <div
        className="logs-header"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
      >
        <span className="logs-title">
          📋 日志 ({logs.length} 条)
        </span>
        <span className="logs-toggle">
          {expanded ? '▼' : '▶'}
        </span>
      </div>
      
      {expanded && (
        <div className="logs-content">
          <div className="logs-filter">
            {(['all', 'debug', 'info', 'warn', 'error'] as const).map(level => (
              <button
                key={level}
                className={`filter-btn ${filterLevel === level ? 'active' : ''}`}
                onClick={() => setFilterLevel(level)}
                style={{
                  color: level === 'all' ? '#666' : LOG_LEVEL_COLORS[level]
                }}
              >
                {level === 'all' ? '全部' : `${level} (${levelCounts[level]})`}
              </button>
            ))}
            <button className="copy-btn" onClick={handleCopy} title="复制日志">
              📋 复制
            </button>
          </div>
          
          <div
            className="logs-container"
            ref={logsContainerRef}
            style={{ maxHeight }}
          >
            {filteredLogs.length === 0 ? (
              <div className="logs-empty">无日志</div>
            ) : (
              filteredLogs.map((log, index) => (
                <div
                  key={index}
                  className={`log-entry log-${log.level}`}
                  title={log.message}
                >
                  <span className="log-icon">
                    {LOG_LEVEL_ICONS[log.level]}
                  </span>
                  <span className="log-time">
                    {log.timestamp.toLocaleTimeString('zh-CN')}
                  </span>
                  <span className="log-message">
                    {log.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
```

**TaskLogs.css**:
```css
.task-logs {
  margin-top: 8px;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  overflow: hidden;
}

.logs-header {
  padding: 10px 12px;
  background: #f5f5f5;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  user-select: none;
}

.logs-title {
  font-size: 12px;
  font-weight: 500;
  color: #333;
}

.logs-toggle {
  color: #999;
  font-size: 11px;
  transition: transform 0.2s;
}

.logs-content {
  background: white;
  border-top: 1px solid #e0e0e0;
}

.logs-filter {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  background: #fafafa;
  border-bottom: 1px solid #e0e0e0;
  overflow-x: auto;
  font-size: 11px;
}

.filter-btn {
  padding: 4px 8px;
  border: 1px solid #ddd;
  border-radius: 3px;
  background: white;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
}

.filter-btn:hover {
  border-color: #999;
}

.filter-btn.active {
  background: #e3f2fd;
  border-color: #1976d2;
  font-weight: 500;
}

.copy-btn {
  margin-left: auto;
  padding: 4px 8px;
  background: #e8f5e9;
  border: 1px solid #4caf50;
  color: #4caf50;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
}

.copy-btn:hover {
  background: #4caf50;
  color: white;
}

.logs-container {
  overflow-y: auto;
  font-family: 'Courier New', monospace;
  font-size: 11px;
  background: #f9f9f9;
}

.log-entry {
  padding: 4px 12px;
  display: flex;
  gap: 8px;
  align-items: flex-start;
  line-height: 1.4;
  border-bottom: 1px solid #f0f0f0;
}

.log-entry:last-child {
  border-bottom: none;
}

.log-icon {
  min-width: 14px;
  text-align: center;
}

.log-time {
  color: #999;
  min-width: 70px;
  font-size: 10px;
}

.log-message {
  flex: 1;
  color: #333;
  word-break: break-word;
}

.log-debug { color: #90a4ae; }
.log-info { color: #1976d2; }
.log-warn { color: #f57c00; }
.log-error { color: #d32f2f; }

.logs-empty {
  padding: 20px;
  text-align: center;
  color: #999;
  font-size: 12px;
}
```

### 3.4 ResultPreviewPanel.tsx

**位置**: `apps/windows/src/renderer/pages/ChatPage/components/BackgroundTaskCard/ResultPreviewPanel.tsx`

```typescript
import React, { useMemo } from 'react'
import { BackgroundTaskOutput } from '@/types/agent-runtime'
import { ImageLightbox } from '@/renderer/components/ImageLightbox'
import Prism from 'prismjs'
import 'prismjs/themes/prism-tomorrow.css'
import './ResultPreviewPanel.css'

interface ResultPreviewPanelProps {
  output?: BackgroundTaskOutput
}

type PreviewType = 'image' | 'video' | 'code' | 'json' | 'markdown' | 'document' | 'unknown'

export const ResultPreviewPanel: React.FC<ResultPreviewPanelProps> = ({ output }) => {
  if (!output) return null
  
  const previewType = useMemo((): PreviewType => {
    if (typeof output !== 'object') return 'unknown'
    
    // 图片
    if ('url' in output && typeof output.url === 'string') {
      if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(output.url)) {
        return 'image'
      }
    }
    
    // 视频
    if ('videoUrl' in output || 'video_url' in output) {
      return 'video'
    }
    
    // 代码
    if ('code' in output && 'language' in output) {
      return 'code'
    }
    
    // JSON
    if ('json' in output || (typeof output === 'object' && Object.keys(output).length > 0)) {
      try {
        JSON.stringify(output)
        return 'json'
      } catch {
        return 'unknown'
      }
    }
    
    return 'unknown'
  }, [output])
  
  return (
    <div className="result-preview-panel">
      {previewType === 'image' && 'url' in output && (
        <ImagePreview url={output.url as string} />
      )}
      
      {previewType === 'video' && (
        <VideoPreview output={output} />
      )}
      
      {previewType === 'code' && 'code' in output && (
        <CodePreview code={output.code as string} language={(output as any).language || 'javascript'} />
      )}
      
      {previewType === 'json' && (
        <JsonPreview data={output} />
      )}
      
      {previewType === 'unknown' && (
        <UnknownPreview output={output} />
      )}
    </div>
  )
}

// 图片预览
const ImagePreview: React.FC<{ url: string }> = ({ url }) => {
  const [showLightbox, setShowLightbox] = React.useState(false)
  
  return (
    <div className="preview-section">
      <div className="preview-header">🖼️ 图片预览</div>
      <div className="preview-content">
        <img
          src={url}
          alt="预览"
          className="preview-image"
          onClick={() => setShowLightbox(true)}
        />
        <div className="preview-actions">
          <button onClick={() => downloadFile(url, 'image')}>下载</button>
          <button onClick={() => setShowLightbox(true)}>放大</button>
        </div>
      </div>
      {showLightbox && (
        <ImageLightbox src={url} onClose={() => setShowLightbox(false)} />
      )}
    </div>
  )
}

// 视频预览
const VideoPreview: React.FC<{ output: any }> = ({ output }) => {
  const videoUrl = output.videoUrl || output.video_url || output.url
  
  return (
    <div className="preview-section">
      <div className="preview-header">🎬 视频预览</div>
      <div className="preview-content">
        <video
          controls
          width="100%"
          className="preview-video"
        >
          <source src={videoUrl} type="video/mp4" />
          您的浏览器不支持视频播放
        </video>
        <div className="preview-actions">
          <button onClick={() => downloadFile(videoUrl, 'video')}>下载</button>
          <button onClick={() => window.open(videoUrl)}>在新窗口打开</button>
        </div>
      </div>
    </div>
  )
}

// 代码预览
const CodePreview: React.FC<{ code: string; language: string }> = ({ code, language }) => {
  const highlighted = useMemo(() => {
    try {
      return Prism.highlight(code, Prism.languages[language] || Prism.languages.javascript, language)
    } catch {
      return code
    }
  }, [code, language])
  
  return (
    <div className="preview-section">
      <div className="preview-header">
        💻 代码 ({language})
      </div>
      <div className="preview-content">
        <pre className="code-preview">
          <code
            className={`language-${language}`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>
        <div className="preview-actions">
          <button onClick={() => copyToClipboard(code)}>复制代码</button>
          <button onClick={() => downloadFile(code, 'code', `code.${language}`)}>
            下载
          </button>
        </div>
      </div>
    </div>
  )
}

// JSON 预览
const JsonPreview: React.FC<{ data: any }> = ({ data }) => {
  const [expanded, setExpanded] = React.useState(false)
  const jsonString = JSON.stringify(data, null, 2)
  
  return (
    <div className="preview-section">
      <div className="preview-header">
        📊 JSON 数据
      </div>
      <div className="preview-content">
        <details open={expanded}>
          <summary onClick={() => setExpanded(!expanded)}>
            {expanded ? '▼ 收起' : '▶ 展开'} ({Object.keys(data).length} 字段)
          </summary>
          <pre className="json-preview">
            <code>{jsonString}</code>
          </pre>
        </details>
        <div className="preview-actions">
          <button onClick={() => copyToClipboard(jsonString)}>复制 JSON</button>
        </div>
      </div>
    </div>
  )
}

// 未知类型预览
const UnknownPreview: React.FC<{ output: any }> = ({ output }) => {
  return (
    <div className="preview-section">
      <div className="preview-header">📦 产出数据</div>
      <div className="preview-content">
        <pre className="unknown-preview">
          <code>
            {JSON.stringify(output, null, 2)}
          </code>
        </pre>
      </div>
    </div>
  )
}

// 辅助函数
function downloadFile(url: string, type: string, filename?: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = filename || `download_${Date.now()}.${type}`
  link.click()
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text)
}
```

**ResultPreviewPanel.css**:
```css
.result-preview-panel {
  margin-top: 12px;
  padding: 12px;
  background: white;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
}

.preview-section {
  margin-bottom: 12px;
}

.preview-section:last-child {
  margin-bottom: 0;
}

.preview-header {
  font-size: 12px;
  font-weight: 500;
  color: #333;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid #e0e0e0;
}

.preview-content {
  position: relative;
}

.preview-image {
  max-width: 100%;
  max-height: 300px;
  border-radius: 4px;
  cursor: pointer;
  background: #f5f5f5;
  display: block;
}

.preview-video {
  background: #000;
  border-radius: 4px;
  display: block;
}

.code-preview,
.json-preview,
.unknown-preview {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 11px;
  line-height: 1.5;
  margin: 0;
}

.code-preview code,
.json-preview code,
.unknown-preview code {
  font-family: 'Courier New', monospace;
}

.preview-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.preview-actions button {
  padding: 6px 12px;
  font-size: 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: white;
  cursor: pointer;
  transition: all 0.2s;
}

.preview-actions button:hover {
  background: #f5f5f5;
  border-color: #999;
}

details {
  margin-bottom: 8px;
}

summary {
  cursor: pointer;
  padding: 8px;
  background: #f9f9f9;
  border-radius: 4px;
  font-size: 12px;
  user-select: none;
}

summary:hover {
  background: #f0f0f0;
}
```

---

## 🔧 四、后端工具适配

### 4.1 BackgroundTaskManager 集成

**文件**: `apps/windows/src/main/agent-runtime/background-tool-runner.ts` (新增或扩展)

在工具执行时调用进度更新方法:

```typescript
async runTool(toolName: string, params: unknown): Promise<unknown> {
  const taskId = this.getCurrentTaskId()
  if (!taskId) return
  
  const taskManager = BackgroundTaskManager.getInstance()
  
  try {
    taskManager.addLog(taskId, 'info', `开始执行工具: ${toolName}`)
    
    // 为不同的工具类型使用不同的处理策略
    if (toolName === 'comfyui') {
      return await this.runComfyUITool(taskId, params)
    } else if (toolName === 'mcp') {
      return await this.runMCPTool(taskId, params)
    }
    
    taskManager.addLog(taskId, 'info', `工具执行完成: ${toolName}`)
  } catch (error) {
    taskManager.addLog(taskId, 'error', `工具执行失败: ${error.message}`)
    throw error
  }
}
```

### 4.2 ComfyUI 工具集成示例

```typescript
async runComfyUITool(taskId: string, params: any) {
  const taskManager = BackgroundTaskManager.getInstance()
  
  // 初始化里程碑
  const milestones = [
    { step: '准备模型', status: 'pending' as const },
    { step: '生成图像', status: 'pending' as const },
    { step: '处理后期', status: 'pending' as const },
    { step: '保存结果', status: 'pending' as const }
  ]
  taskManager.setMilestones(taskId, milestones)
  
  try {
    // 阶段 1: 准备模型
    taskManager.updateMilestone(taskId, '准备模型', 'in-progress')
    taskManager.updateProgress(taskId, 10, '正在加载 ComfyUI 模型...')
    
    await this.loadModels(params.model)
    
    taskManager.updateMilestone(taskId, '准备模型', 'completed', 3200)
    taskManager.updateProgress(taskId, 25)
    
    // 阶段 2: 生成图像
    taskManager.updateMilestone(taskId, '生成图像', 'in-progress')
    taskManager.updateProgress(taskId, 30, '正在生成图像 (1/3)...')
    
    const images = await this.generateImages(params)
    
    taskManager.addLog(taskId, 'info', `已生成 ${images.length} 张图像`)
    taskManager.updateMilestone(taskId, '生成图像', 'completed', 8500)
    taskManager.updateProgress(taskId, 60)
    
    // 阶段 3: 处理后期
    taskManager.updateMilestone(taskId, '处理后期', 'in-progress')
    taskManager.updateProgress(taskId, 65, '应用后期处理...')
    
    const processed = await this.postProcess(images)
    
    taskManager.updateMilestone(taskId, '处理后期', 'completed', 4200)
    taskManager.updateProgress(taskId, 85)
    
    // 阶段 4: 保存结果
    taskManager.updateMilestone(taskId, '保存结果', 'in-progress')
    taskManager.updateProgress(taskId, 90, '保存最终结果...')
    
    const output = await this.saveResults(processed)
    
    taskManager.updateMilestone(taskId, '保存结果', 'completed', 1800)
    taskManager.updateProgress(taskId, 100, '完成')
    
    return output
    
  } catch (error) {
    taskManager.addLog(taskId, 'error', `处理失败: ${error.message}`)
    const failedStep = milestones.find(m => m.status === 'in-progress')
    if (failedStep) {
      taskManager.updateMilestone(taskId, failedStep.step, 'failed')
    }
    throw error
  }
}
```

---

## 📅 五、实施时间表

### Week 1: 设计评审与规划 (1 天)

| 日期 | 任务 | Owner | 时间 |
|------|------|-------|------|
| 周一 | 设计评审 | PM/TL | 2h |
| 周一 | 技术评审 | Lead Engineer | 1h |
| 周二-周三 | Sprint 规划 | Team | 3h |
| 周三 | 环境搭建 | Dev | 2h |

**产出**: 
- 详细的需求文档
- 设计稿 (Figma)
- Sprint 任务分解

### Week 2: 开发阶段 (5 天)

#### 前端部分 (2.5 天)

| 日期 | 任务 | Component | Owner |
|------|------|-----------|-------|
| 周一 | TaskProgressBar 实现 | TaskProgressBar | FE-1 |
| 周一 | TaskMilestones 实现 | TaskMilestones | FE-2 |
| 周二 | TaskLogs 实现 | TaskLogs | FE-1 |
| 周二 | ResultPreviewPanel - 图片/视频 | ResultPreviewPanel | FE-2 |
| 周三 | ResultPreviewPanel - 代码/JSON | ResultPreviewPanel | FE-1 |

#### 后端部分 (2 天)

| 日期 | 任务 | Component | Owner |
|------|------|-----------|-------|
| 周一-周二 | BackgroundTaskManager 扩展 | BackgroundTaskManager | BE-1 |
| 周三 | ComfyUI 工具集成 | Tool Runner | BE-2 |

#### 集成测试 (0.5 天)

| 日期 | 任务 | Owner |
|------|------|-------|
| 周四 | 端到端测试 | QA |
| 周五 | 缺陷修复 | Team |

### Week 3: 测试与发布 (2 天)

| 日期 | 任务 | Owner |
|------|------|-------|
| 周一-周二 | 性能优化 & 缺陷修复 | Team |
| 周三 | Beta 版本准备 | Release |
| 周四 | 发布 Beta | DevOps |
| 周五 | 收集用户反馈 | PM |

**总工作量**: 7 人天
- 前端: 4 天 (2 名工程师)
- 后端: 2 天 (1 名工程师)
- QA: 1 天 (1 名工程师)

---

## ✅ 六、测试策略

### 目标: 80% 代码覆盖率

### 单元测试 (~500 行代码)

```typescript
// tests/TaskProgressBar.test.tsx
describe('TaskProgressBar', () => {
  it('should display progress percentage', () => {
    const { getByText } = render(
      <TaskProgressBar
        progress={42}
        status="running"
        startTime={Date.now()}
      />
    )
    expect(getByText(/進行中 \(42%\)/)).toBeInTheDocument()
  })
  
  it('should show remaining time estimate', () => {
    const startTime = Date.now() - 10000
    const { getByText } = render(
      <TaskProgressBar
        progress={20}
        status="running"
        startTime={startTime}
      />
    )
    // 应显示剩余时间估计
    expect(getByText(/预计/)).toBeInTheDocument()
  })
})

// tests/TaskLogs.test.tsx
describe('TaskLogs', () => {
  it('should filter logs by level', () => {
    const logs: TaskLog[] = [
      { level: 'info', message: 'Info message', timestamp: new Date() },
      { level: 'error', message: 'Error message', timestamp: new Date() }
    ]
    
    const { getByText, getByRole } = render(<TaskLogs logs={logs} />)
    
    // 点击展开
    fireEvent.click(getByText(/📋 日志/))
    
    // 过滤为错误
    fireEvent.click(getByRole('button', { name: /error/ }))
    
    // 应只显示 1 条
    expect(getByText('Error message')).toBeInTheDocument()
  })
})

// tests/ResultPreviewPanel.test.tsx
describe('ResultPreviewPanel', () => {
  it('should render image preview', () => {
    const output = { url: 'https://example.com/image.jpg' }
    const { getByAltText } = render(<ResultPreviewPanel output={output} />)
    expect(getByAltText(/预览/)).toHaveAttribute('src', output.url)
  })
})
```

### 集成测试 (~300 行代码)

```typescript
// tests/integration/background-task-manager.test.ts
describe('BackgroundTaskManager Integration', () => {
  it('should update progress and logs correctly', async () => {
    const taskId = 'test-task-123'
    const manager = BackgroundTaskManager.getInstance()
    
    // 启动任务
    manager.start(taskId, 'TestAgent', 'Test Task')
    
    // 添加日志和更新进度
    manager.addLog(taskId, 'info', '开始处理...')
    manager.updateProgress(taskId, 25, '处理中...')
    
    // 验证状态
    const state = manager.getTaskState(taskId)
    expect(state.progress).toBe(25)
    expect(state.logs).toHaveLength(1)
    expect(state.logs[0].message).toBe('开始处理...')
  })
})

// tests/integration/comfyui-tool.test.ts
describe('ComfyUI Tool Integration', () => {
  it('should track milestones during execution', async () => {
    const runner = new ComfyUIToolRunner()
    const taskId = 'comfyui-task'
    
    const result = await runner.run(taskId, {
      prompt: 'generate image'
    })
    
    const state = manager.getTaskState(taskId)
    expect(state.milestones).toHaveLength(4)
    expect(state.milestones.every(m => m.status === 'completed')).toBe(true)
  })
})
```

### E2E 测试 (~200 行代码)

```typescript
// tests/e2e/video-generation.spec.ts
import { test, expect } from '@playwright/test'

test('should generate video with progress tracking', async ({ page }) => {
  await page.goto('/')
  
  // 发送生成视频的请求
  await page.fill('textarea', '生成一个 5 秒的动画视频')
  await page.click('button:has-text("发送")')
  
  // 验证进度条出现
  const progressBar = page.locator('progress')
  await expect(progressBar).toBeVisible()
  
  // 验证日志可展开
  const logsHeader = page.locator('text=📋 日志')
  await logsHeader.click()
  
  // 验证日志内容
  await expect(page.locator('text=正在加载模型')).toBeVisible()
  
  // 等待完成
  await expect(progressBar).toHaveValue('100', { timeout: 60000 })
  
  // 验证视频预览
  const video = page.locator('video')
  await expect(video).toBeVisible()
})
```

---

## 🚨 七、风险评估与缓解

| 风险 | 概率 | 影响 | 缓解策略 |
|------|------|------|---------|
| **后端日志推送延迟** | 20% | 中 | 实现轮询降级机制 |
| **性能瓶颈 (100+ 日志)** | 25% | 中 | 虚拟滚动 + 日志限制 1000 条 |
| **状态同步不一致** | 15% | 高 | 单一数据源 (BackgroundTaskManager) |
| **现有工具兼容性** | 10% | 中 | 所有字段可选，向后兼容 |
| **用户学习成本** | 30% | 低 | 渐进式发布 + 文档 |

**高风险项处置**:
- **状态同步**: 使用 useSyncExternalStore 确保单向数据流
- **兼容性**: 在 BackgroundTask 中添加所有新字段为可选
- **性能**: 日志自动限制，虚拟滚动延迟加载

---

## 📋 八、交付清单

- [ ] 代码实现
  - [ ] TaskProgressBar 完成并通过审查
  - [ ] TaskLogs 完成并通过审查
  - [ ] TaskMilestones 完成并通过审查
  - [ ] ResultPreviewPanel 完成并通过审查
  - [ ] BackgroundTaskManager 扩展完成

- [ ] 测试
  - [ ] 单元测试覆盖率 ≥ 80%
  - [ ] 集成测试全部通过
  - [ ] E2E 测试通过 (3 个主要场景)

- [ ] 文档
  - [ ] API 文档更新
  - [ ] 工具集成指南
  - [ ] 组件使用示例

- [ ] 验收
  - [ ] Code Review 通过
  - [ ] 性能基线测试通过
  - [ ] 浏览器兼容性验证 (Chrome/Firefox/Safari)

---

## 🎯 九、成功指标

### Phase 1 (2 周后)

- ✅ 进度条准确度 ±5%
- ✅ 日志预览加载 < 500ms
- ✅ 视频预览播放流畅 (无卡顿)
- ✅ 用户满意度 > 70% ("很好用" 比例)

### 数据指标

- 进度条准确性: 测量 `estimatedRemaining vs actualRemaining` 偏差
- 性能: 日志列表滚动帧率 ≥ 60fps
- 可靠性: 7 天无崩溃

---

## 📖 十、Phase 2 预览

### 工作流看板化 (4-5 天)

```
看板示例:
  时间 →
  ┌──────────────────────────┐
  │ [Agent-1] 数据处理       │
  │  ├─ 📥 导入 ✓ (8s)      │
  │  ├─ 🔄 清洗 🔄 (...)    │
  │  └─ 📤 导出 ⏳ (待定)   │
  └──────────────────────────┘
        ↓ 依赖
  ┌──────────────────────────┐
  │ [Agent-2] 报告生成       │
  │  ├─ 📝 结构 ✓ (5s)      │
  │  ├─ ✍️ 编写 🔄 (...)    │
  │  └─ 📄 输出 ⏳ (待定)   │
  └──────────────────────────┘
```

**工作量**: 10.5 人天  
**时间**: 4 周  
**优先级**: ⭐⭐⭐⭐

### CardRegistry 系统 (3-4 天)

允许插件自定义结果渲染方式。

**工作量**: 5 人天  
**时间**: 2 周  
**优先级**: ⭐⭐⭐⭐

---

## 附录 A: 集成模式模板

### MCP 工具集成模板

```typescript
async runMCPTool(taskId: string, params: any) {
  const taskManager = BackgroundTaskManager.getInstance()
  
  taskManager.addLog(taskId, 'info', `执行 MCP 工具: ${params.tool}`)
  taskManager.updateProgress(taskId, 20, 'MCP 工具执行中...')
  
  try {
    const result = await this.mcp.call(params.tool, params.input)
    taskManager.updateProgress(taskId, 100, '完成')
    return result
  } catch (error) {
    taskManager.addLog(taskId, 'error', `MCP 失败: ${error.message}`)
    throw error
  }
}
```

### REST API 工具集成模板

```typescript
async runRESTTool(taskId: string, params: any) {
  const taskManager = BackgroundTaskManager.getInstance()
  
  taskManager.addLog(taskId, 'info', `调用 API: ${params.endpoint}`)
  
  try {
    const response = await fetch(params.endpoint, {
      method: params.method,
      body: JSON.stringify(params.body)
    })
    
    taskManager.updateProgress(taskId, 50, '处理响应...')
    const data = await response.json()
    
    taskManager.updateProgress(taskId, 100)
    return data
  } catch (error) {
    taskManager.addLog(taskId, 'error', `API 调用失败: ${error.message}`)
    throw error
  }
}
```

---

## 附录 B: CSS 重置 (如需要)

```css
/* 确保所有 Phase 1 组件使用一致的样式 */
.task-progress-container,
.task-milestones,
.task-logs,
.result-preview-panel {
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.task-progress-container *,
.task-milestones *,
.task-logs *,
.result-preview-panel * {
  box-sizing: border-box;
}
```

---

## 版本历史

| 版本 | 日期 | 更新内容 |
|------|------|---------|
| 1.0 | 2026-10-23 | 初稿，4 个新组件 + 3 个后端方法 + 完整时间表 |

---

**文档完成**: 2026-10-23  
**下次审查**: Phase 1 开发启动后第 1 周  
**状态**: 待批准与启动
