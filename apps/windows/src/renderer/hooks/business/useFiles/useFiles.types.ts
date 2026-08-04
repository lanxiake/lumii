/**
 * useFiles.types.ts - 文件管理类型定义
 */

/** 文件信息 */
export interface FileItem {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: Date
  createdAt: Date
  extension?: string
  icon?: string
}

/** 用户路径 */
export interface UserPaths {
  home: string
  desktop: string
  documents: string
  downloads: string
}

/** 文件排序方式 */
export type FileSortBy = 'name' | 'size' | 'date' | 'type'
export type SortOrder = 'asc' | 'desc'

/** 文件管理配置 */
export interface FileManagerConfig {
  initialPath?: string
  rootPath?: string
  /** 自动刷新间隔（毫秒），用于目录变化增量更新；0 表示关闭 */
  watchIntervalMs?: number
}

/** 搜索选项 */
export interface SearchOptions {
  recursive?: boolean
  maxResults?: number
}
