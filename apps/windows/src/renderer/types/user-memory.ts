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

/**
 * 用户记忆服务响应包装
 */
export interface UserMemoryServiceResponse<T> {
  /** 是否成功 */
  success: boolean
  /** 响应数据 */
  data?: T
  /** 错误信息 */
  error?: string
  /** 错误码 */
  code?: string
}
