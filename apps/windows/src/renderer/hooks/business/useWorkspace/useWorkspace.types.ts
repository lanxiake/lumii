/**
 * useWorkspace.types.ts - 工作空间 Hook 类型定义
 */

/**
 * 工作空间快捷位置
 */
export interface WorkspaceLocation {
  /** 唯一标识 */
  id: string
  /** 显示名称 */
  label: string
  /** 图标 */
  icon: string
  /** 相对于工作空间根的路径（空字符串表示根目录） */
  relativePath: string
  /** 分组标题（用于侧边栏分组展示） */
  group: 'root' | 'config' | 'directories'
}

/**
 * useWorkspace Hook 返回值
 */
export interface UseWorkspaceReturn {
  /** 工作空间根目录绝对路径 */
  workspaceDir: string
  /** 是否正在初始化 */
  isInitializing: boolean
  /** 初始化错误 */
  initError: string | null
  /** 工作空间快捷位置列表 */
  locations: WorkspaceLocation[]
  /** 将绝对路径转为相对于工作空间的显示路径 */
  toRelativePath: (absolutePath: string) => string
  /** 将相对路径转为绝对路径 */
  toAbsolutePath: (relativePath: string) => string
}
