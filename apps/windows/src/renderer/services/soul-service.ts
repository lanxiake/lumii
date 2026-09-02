/**
 * AI 灵魂（SOUL）服务
 *
 * 通过主进程 IPC 读写本地 soul.md。
 */

export interface SoulRecord {
  content: string
  updatedAt: string
}

export interface UpdateSoulResponse {
  updatedAt: string
}

/**
 * 获取当前 SOUL 内容。
 */
export async function getSoulContent(): Promise<SoulRecord> {
  const response = (await window.electronAPI.api.getSoulContent()) as {
    success: boolean
    error?: string
    data?: SoulRecord
  }

  if (!response.success || !response.data) {
    throw new Error(response.error || '获取 AI 灵魂失败')
  }

  return response.data
}

/**
 * 更新 SOUL 内容并持久化到本地文件。
 */
export async function updateSoulContent(content: string): Promise<UpdateSoulResponse> {
  const response = (await window.electronAPI.api.updateSoulContent(content)) as {
    success: boolean
    error?: string
    data?: UpdateSoulResponse
  }

  if (!response.success || !response.data) {
    throw new Error(response.error || '保存 AI 灵魂失败')
  }

  return response.data
}
