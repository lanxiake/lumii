/**
 * 用户记忆服务
 *
 * 提供用户记忆的读取和更新 API
 * 通过主进程 IPC 与 API Server 通信
 */

import type { UserMemory, UpdateUserMemoryResponse } from '../types/user-memory'

const MAX_CONTENT_LENGTH = 65536

/**
 * 获取当前用户记忆
 *
 * @returns 用户记忆内容和更新时间
 * @throws {Error} 当 API 调用失败时
 */
export async function getUserMemory(): Promise<UserMemory> {
  const response = (await window.electronAPI.api.getUserMemory()) as {
    success: boolean
    error?: string
    data?: UserMemory
  }

  if (!response.success) {
    throw new Error(response.error || '获取记忆失败')
  }

  return response.data as UserMemory
}

/**
 * 更新用户记忆
 *
 * @param content - Markdown 格式的记忆内容
 * @returns 更新时间
 * @throws {Error} 当内容超过 64KB 或 API 调用失败时
 */
export async function updateUserMemory(content: string): Promise<UpdateUserMemoryResponse> {
  // 客户端预校验（符合 PRD 要求）
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`内容超过最大长度限制（${MAX_CONTENT_LENGTH} 字符）`)
  }

  const response = (await window.electronAPI.api.updateUserMemory(content)) as {
    success: boolean
    error?: string
    data?: UpdateUserMemoryResponse
  }

  if (!response.success) {
    throw new Error(response.error || '更新记忆失败')
  }

  return response.data as UpdateUserMemoryResponse
}
