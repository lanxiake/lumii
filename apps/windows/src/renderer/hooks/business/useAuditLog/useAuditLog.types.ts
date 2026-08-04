/**
 * useAuditLog.types.ts - 审计日志类型定义
 */

/** 审计事件类型 */
export type AuditEventType =
  | 'session.start'
  | 'session.end'
  | 'session.connect'
  | 'session.disconnect'
  | 'chat.message.sent'
  | 'chat.message.received'
  | 'chat.abort'
  | 'skill.execute.start'
  | 'skill.execute.success'
  | 'skill.execute.error'
  | 'skill.install'
  | 'skill.uninstall'
  | 'skill.enable'
  | 'skill.disable'
  | 'file.read'
  | 'file.write'
  | 'file.delete'
  | 'file.move'
  | 'file.copy'
  | 'system.process.list'
  | 'system.process.kill'
  | 'system.app.launch'
  | 'system.command.execute'
  | 'confirm.request'
  | 'confirm.approve'
  | 'confirm.reject'
  | 'confirm.timeout'
  | 'settings.change'
  | 'auth.pair.request'
  | 'auth.pair.success'
  | 'auth.pair.reject'
  | 'auth.token.refresh'

/** 审计事件严重级别 */
export type AuditSeverity = 'info' | 'warn' | 'critical'

/** 审计事件来源 */
export interface AuditSource {
  type: 'user' | 'system' | 'ai' | 'skill' | 'schedule'
  name: string
  ip?: string
}

/** 审计日志条目 */
export interface AuditLogEntry {
  id: string
  timestamp: string
  eventType: AuditEventType
  severity: AuditSeverity
  title: string
  detail: string
  source: AuditSource
  result: 'success' | 'failure' | 'pending'
  metadata?: Record<string, unknown>
  sessionId?: string
  userId?: string
  deviceId?: string
}

/** 审计日志过滤条件 */
export interface AuditLogFilters {
  startTime?: string
  endTime?: string
  eventTypes?: AuditEventType[]
  severities?: AuditSeverity[]
  results?: Array<'success' | 'failure' | 'pending'>
  sourceTypes?: Array<'user' | 'system' | 'ai' | 'skill' | 'schedule'>
  search?: string
  sessionId?: string
  offset?: number
  limit?: number
  sortOrder?: 'asc' | 'desc'
}

/** 审计日志查询结果 */
export interface AuditLogQueryResult {
  entries: AuditLogEntry[]
  total: number
  offset: number
  limit: number
}

/** 审计日志统计 */
export interface AuditLogStats {
  totalEntries: number
  byEventType: Record<string, number>
  bySeverity: Record<AuditSeverity, number>
  byResult: Record<string, number>
  bySourceType: Record<string, number>
  timeRange: {
    earliest: string | null
    latest: string | null
  }
  todayCount: number
  weekCount: number
}

/** 审计日志配置 */
export interface AuditLogConfig {
  enabled: boolean
  retentionDays: number
  maxEntries: number
  logChatContent: boolean
  logFilePaths: boolean
  eventTypes: AuditEventType[]
  minSeverity: AuditSeverity
}

/** 事件类型标签 */
export const EVENT_TYPE_LABELS: Record<AuditEventType, string> = {
  'session.start': '会话开始',
  'session.end': '会话结束',
  'session.connect': '连接建立',
  'session.disconnect': '连接断开',
  'chat.message.sent': '发送消息',
  'chat.message.received': '接收消息',
  'chat.abort': '中止对话',
  'skill.execute.start': '技能执行开始',
  'skill.execute.success': '技能执行成功',
  'skill.execute.error': '技能执行失败',
  'skill.install': '安装技能',
  'skill.uninstall': '卸载技能',
  'skill.enable': '启用技能',
  'skill.disable': '禁用技能',
  'file.read': '读取文件',
  'file.write': '写入文件',
  'file.delete': '删除文件',
  'file.move': '移动文件',
  'file.copy': '复制文件',
  'system.process.list': '列出进程',
  'system.process.kill': '结束进程',
  'system.app.launch': '启动应用',
  'system.command.execute': '执行命令',
  'confirm.request': '请求确认',
  'confirm.approve': '批准操作',
  'confirm.reject': '拒绝操作',
  'confirm.timeout': '确认超时',
  'settings.change': '设置变更',
  'auth.pair.request': '配对请求',
  'auth.pair.success': '配对成功',
  'auth.pair.reject': '配对拒绝',
  'auth.token.refresh': '令牌刷新',
}

/** 严重级别标签 */
export const SEVERITY_LABELS: Record<AuditSeverity, string> = {
  info: '信息',
  warn: '警告',
  critical: '严重',
}

/** 来源类型标签 */
export const SOURCE_TYPE_LABELS: Record<AuditSource['type'], string> = {
  user: '用户',
  system: '系统',
  ai: 'AI',
  skill: '技能',
  schedule: '定时任务',
}
