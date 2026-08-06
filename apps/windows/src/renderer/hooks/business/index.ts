/**
 * Business Hooks Index - 业务 Hooks 统一导出
 * 
 * 重构后的业务 Hooks，基于原代码 hooks/ 目录
 * 使用通用 Hooks（useAsync、useQuery、useMutation）
 */

// 技能管理
export { useSkills } from './useSkills'
export type { UseSkillsReturn, InstalledSkillInfo, SkillStats as InstalledSkillStats, SkillExecutionResult } from './useSkills'

// 技能商店
export { useSkillStore } from './useSkillStore'
export type { StoreSkillInfo, SkillCategory, StoreFilters, StoreStats, SkillUploadData } from './useSkillStore'

// 文件管理
export { useFiles, formatFileSize } from './useFiles'
export type { UseFilesReturn, FileItem, UserPaths, FileSortBy, SortOrder } from './useFiles'

// 对话管理（useChat hook 已移除，仅保留类型）
export type { ChatMessage, ChatSession, StreamingMessage, MessageAttachment, ToolCall } from './useChat'

// 系统监控
export { useSystem, formatBytes, formatUptime } from './useSystem'
export type { UseSystemReturn, SystemInfo, DiskInfo, ProcessInfo, ProcessSortBy } from './useSystem'

// 仪表盘数据
export { useDashboard } from './useDashboard'
export type { UseDashboardReturn, RuntimeGauges, SkillStats, UsageRange, UsageView } from './useDashboard'

// 设置管理
export { useSettings } from './useSettings'
export type { UseSettingsReturn, AppSettings, GatewayConfig, ThemeConfig, NotificationConfig, PrivacyConfig, WorkspaceConfig } from './useSettings'

// 用户记忆管理（新）
export { useUserMemory } from './useUserMemory'
export type { UseUserMemoryReturn } from './useUserMemory'

// 审计日志
export { useAuditLog } from './useAuditLog'
export type { UseAuditLogReturn, AuditLogEntry, AuditLogFilters, AuditLogStats, AuditLogConfig, AuditEventType, AuditSeverity } from './useAuditLog'

// ACP 项目管理
export { useCodingDevProjects, useCodingDevProjectModals, getRemoveProjectHint } from './useCodingDevProjects'
export type {
  CodingDevProject,
  UseCodingDevProjectsResult,
  CodingDevProjectModalsApi,
} from './useCodingDevProjects'
