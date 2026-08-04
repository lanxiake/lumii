/**
 * useSkills.types.ts - 技能管理类型定义
 */

/** 已安装技能信息 */
export interface InstalledSkillInfo {
  id: string
  userId: string
  skillItemId: string
  installedVersion: string
  isEnabled: boolean
  installedAt: string
  lastUsedAt?: string
  /** 分类目录名，无分类时为空字符串 */
  category: string
  skill: {
    id: string
    name: string
    description?: string
    version: string
    authorName?: string
    categoryId?: string
    tags?: string[]
    status: string
    downloadCount: number
    ratingAvg?: string
    ratingCount: number
    iconUrl?: string
    sourceType: 'system' | 'user'
    isFeatured: boolean
    createdAt: string
    updatedAt: string
  }
}

/** 技能统计信息 */
export interface SkillStats {
  total: number
  enabled: number
  disabled: number
}

/** 技能执行结果 */
export interface SkillExecutionResult {
  success: boolean
  data?: unknown
  error?: string
  message?: string
}

/** API 响应类型 */
export interface GetInstalledSkillsResponse {
  success: boolean
  data?: InstalledSkillInfo[]
  error?: string
}

export interface ToggleSkillResponse {
  success: boolean
  data?: { isEnabled: boolean }
  error?: string
}
