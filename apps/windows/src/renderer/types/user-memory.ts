/**
 * 用户记忆类型定义
 */

/**
 * 用户记忆数据结构
 */
export interface UserMemory {
  /** Markdown 格式的记忆内容 */
  content: string
  /** 最后更新时间 */
  updatedAt: string
}

/**
 * 更新用户记忆响应
 */
export interface UpdateUserMemoryResponse {
  /** 更新时间 */
  updatedAt: string
}
