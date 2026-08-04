/**
 * 技能元数据类型定义
 */

export interface SkillMetadata {
  /** 技能标识 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 版本号 */
  version: string;
  /**
   * 相对于 skills/ 根目录的路径，如：
   *   "my-skill/skill.md"           （无分类）
   *   "内容创作/baoyu-format/skill.md" （有分类）
   */
  location: string;
  /** 分类目录名，无分类时为空字符串 */
  category: string;
  /** 是否启用 */
  enabled: boolean;
  /** 最后修改时间（毫秒时间戳） */
  lastModified: number;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  [key: string]: unknown;
}
