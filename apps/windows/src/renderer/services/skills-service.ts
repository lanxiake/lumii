/**
 * 技能服务 — 封装 window.electronAPI.skills 与技能商店相关 IPC
 *
 * 归一化两处历史格式差异（调用点不再各自处理）：
 * - listLocalInstalled 可能返回裸数组或 { success, data }
 * - getStoreSkills 可能返回数组或 { items }（旧/新格式）
 */

/** 与 IPC 对齐的本地技能条目（宽松类型：旧数据字段可能缺失） */
export interface LocalSkillInfo {
  id: string
  name?: string
  description?: string
  enabled?: boolean
}

/** 技能商店条目（仅取列表展示所需字段） */
export interface StoreSkillItem {
  id: string
  name?: string
}

/**
 * 列出本地已安装技能；接口不可用或失败时返回空列表（原组件行为：静默降级）。
 */
export async function listInstalledSkills(): Promise<LocalSkillInfo[]> {
  const api = window.electronAPI?.skills
  if (!api) return []
  try {
    const raw = await api.listLocalInstalled()
    const list = Array.isArray(raw) ? raw : ((raw as { data?: unknown })?.data ?? [])
    return Array.isArray(list) ? (list as LocalSkillInfo[]) : []
  } catch {
    return []
  }
}

/**
 * 重新扫描本地技能目录并上报，返回检测到的技能数。
 * 失败向调用方抛出（原手动刷新路径会提示错误）。
 */
export async function refreshSkills(): Promise<{ success: boolean; count: number }> {
  return (await window.electronAPI.skills.refresh()) as { success: boolean; count: number }
}

/** 状态变更后的后台上报（fire-and-forget，不阻塞 UI、失败静默） */
export function refreshSkillsInBackground(): void {
  window.electronAPI.skills.refresh().catch(() => {})
}

/** 获取技能安装目录 */
export async function getSkillDir(skillItemId: string): Promise<string> {
  return window.electronAPI.skills.getSkillDir(skillItemId)
}

/** 从本地目录导入技能（仅含 SKILL.md 的知识型技能） */
export async function importSkillDirectory(sourcePath: string): Promise<{ success: boolean; skillId?: string }> {
  return window.electronAPI.skills.importDirectory(sourcePath)
}

/**
 * 查询技能商店；接口不可用或失败时返回空数组（调用方按「未上架」处理）。
 */
export async function searchStoreSkills(query: string, limit = 1): Promise<StoreSkillItem[]> {
  try {
    const result = await (window.electronAPI.api as unknown as {
      getStoreSkills?: (params: { search: string; limit: number }) => Promise<{
        data?: unknown
        items?: unknown
      }>
    }).getStoreSkills?.({ search: query, limit })
    const rawData = result?.data
    const items = Array.isArray(rawData)
      ? rawData
      : ((rawData as { items?: unknown })?.items ?? result?.items ?? [])
    return Array.isArray(items) ? (items as StoreSkillItem[]) : []
  } catch {
    return []
  }
}

/**
 * 安装技能商店中的技能。
 * 返回值语义与原实现一致：仅显式 `success === false` 视为失败。
 */
export async function installStoreSkill(skillId: string): Promise<boolean> {
  const result = await (window.electronAPI.api as unknown as {
    installStoreSkill?: (skillId: string) => Promise<{ success?: boolean }>
  }).installStoreSkill?.(skillId)
  return result?.success !== false
}
