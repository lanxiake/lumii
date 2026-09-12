/**
 * 搜索工具配置服务 — 封装 window.electronAPI.api 的搜索配置子域
 */

export interface SearchToolsConfig {
  langSearchApiKey?: string
  searxngBaseUrl?: string
}

/** 读取搜索配置；失败或无数据返回 null */
export async function fetchSearchConfig(): Promise<SearchToolsConfig | null> {
  const res = await window.electronAPI.api.getSearchConfig()
  return res.success && res.data ? res.data : null
}

/** 保存搜索配置；结果原样返回（调用方负责提示错误） */
export async function saveSearchConfig(config: SearchToolsConfig): Promise<{ success: boolean; error?: string }> {
  return window.electronAPI.api.setSearchConfig(config)
}
