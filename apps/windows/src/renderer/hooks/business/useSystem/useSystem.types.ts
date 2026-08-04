/**
 * useSystem.types.ts - 系统监控类型定义
 */

/** 系统信息 */
export interface SystemInfo {
  hostname: string
  platform: string
  arch: string
  release: string
  uptime: number
  cpuModel: string
  cpuCores: number
  totalMemory: number
  freeMemory: number
  usedMemory: number
  memoryUsagePercent: number
  cpuUsage?: number
}

/** 磁盘信息 */
export interface DiskInfo {
  name: string
  mount: string
  type: string
  total: number
  free: number
  used: number
  usagePercent: number
}

/** 进程信息 */
export interface ProcessInfo {
  pid: number
  name: string
  cpu: number
  memory: number
  memoryBytes: number
  status: string
  user?: string
  startTime?: Date
}

/** 进程排序方式 */
export type ProcessSortBy = 'name' | 'cpu' | 'memory' | 'pid'
