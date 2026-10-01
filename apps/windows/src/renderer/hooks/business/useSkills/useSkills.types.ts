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
  /** 累计调用次数 */
  executionCount?: number
  /** 分类目录名，无分类时为空字符串 */
  category: string
  /**
   * 运行时类型（主进程技能索引同源）。实际取值除 typescript/javascript/python/shell 外
   * 还有 claude-code（SKILL.md 类技能，见 skill-store），故不设窄联合；
   * 消费点目前只用它判 `=== 'python'`（缺运行时的平台上置灰 Python 技能）。
   */
  runtime?: string
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
