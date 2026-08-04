/**
 * SkillNet 技能商店后端（独立版）
 *
 * 搜索走 SkillNet 公共 REST API（与 skillnet CLI 同源 http://api-skillnet.openkg.cn/v1/search）；
 * 安装走 `skillnet download <github-url> -d <skillsDir>`，下载到本地 workspace/skills 目录，
 * 与 skills:listLocalInstalled / skills:uninstallLocal 共用同一目录，保证装/用/卸一致。
 */

import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)

const SKILLNET_SEARCH_URL = 'http://api-skillnet.openkg.cn/v1/search'
const SEARCH_TIMEOUT_MS = 25_000

/** SkillNet 搜索接口返回的单条技能 */
interface SkillnetRawSkill {
  skill_name: string
  skill_description?: string
  author?: string
  stars?: number
  skill_url?: string
  category?: string
  evaluation?: Record<string, { level?: string; reason?: string }> | null
}

/** 商店技能信息（字段名与 renderer useSkillStore.StoreSkillInfo 对齐） */
interface StoreSkillInfo {
  id: string
  name: string
  description: string
  version: string
  author: string
  category: string
  tags: string[]
  runMode: 'local'
  subscription: { type: 'free' }
  downloads: number
  rating: number
  ratingCount: number
  updatedAt: string
  sourceUrl?: string
  installed?: boolean
}

/** 评估等级 → 数值（用于聚合出一个 0-5 的评分供 UI 展示） */
const LEVEL_SCORE: Record<string, number> = { Good: 5, Average: 3, Poor: 1 }

/** 从评估对象聚合平均分（无评估返回 0） */
function ratingFromEvaluation(evaluation: SkillnetRawSkill['evaluation']): number {
  if (!evaluation) return 0
  const scores = Object.values(evaluation)
    .map((d) => LEVEL_SCORE[d?.level ?? ''] ?? 0)
    .filter((n) => n > 0)
  if (scores.length === 0) return 0
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

/** GitHub skill_url 的最后一段作为目录名（安装/卸载据此匹配） */
function skillDirNameFromUrl(url: string): string {
  const clean = url.split('?')[0].split('#')[0].replace(/\/+$/, '')
  const seg = clean.split('/').filter(Boolean).pop() ?? ''
  return decodeURIComponent(seg)
}

/** 将 SkillNet 原始结果映射为商店卡片结构 */
function mapRawSkill(raw: SkillnetRawSkill): StoreSkillInfo {
  const url = raw.skill_url ?? ''
  return {
    id: url || raw.skill_name,
    name: raw.skill_name,
    description: raw.skill_description ?? '',
    version: '1.0.0',
    author: raw.author ?? 'unknown',
    category: raw.category ?? '',
    tags: raw.category ? [raw.category] : [],
    runMode: 'local',
    subscription: { type: 'free' },
    downloads: raw.stars ?? 0,
    rating: ratingFromEvaluation(raw.evaluation),
    ratingCount: 0,
    updatedAt: '',
    sourceUrl: url,
    installed: false,
  }
}

/** 详情缓存：搜索结果按 id 缓存，供 getStoreSkillDetail 命中（skillnet 无独立详情接口） */
const detailCache = new Map<string, StoreSkillInfo>()

export interface StoreQuery {
  category?: string
  subscription?: string
  sortBy?: 'downloads' | 'rating' | 'updated' | 'name'
  search?: string
  tags?: string[]
  offset?: number
  limit?: number
}

/** renderer sortBy → skillnet sort_by（仅 stars/recent 两种） */
function mapSortBy(sortBy?: string): 'stars' | 'recent' {
  return sortBy === 'updated' ? 'recent' : 'stars'
}

/**
 * 调 SkillNet 搜索接口。空搜索词时用分类或默认种子词，保证商店打开即有内容。
 */
async function searchSkillnet(
  q: StoreQuery,
): Promise<{ skills: StoreSkillInfo[]; total: number }> {
  const limit = q.limit ?? 20
  const offset = q.offset ?? 0
  const page = Math.floor(offset / limit) + 1
  const query = (q.search?.trim() || q.category?.trim() || 'agent').slice(0, 60)

  const params = new URLSearchParams({
    q: query,
    mode: 'keyword',
    limit: String(limit),
    page: String(page),
    min_stars: '0',
    sort_by: mapSortBy(q.sortBy),
  })
  if (q.category?.trim()) params.set('category', q.category.trim())

  const res = await fetch(`${SKILLNET_SEARCH_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`SkillNet 搜索失败：HTTP ${res.status}`)
  }
  const json = (await res.json()) as {
    data?: SkillnetRawSkill[]
    meta?: { total?: number }
  }

  const raw = Array.isArray(json.data) ? json.data : []
  const skills = raw.filter((r) => r.skill_url).map(mapRawSkill)
  for (const s of skills) detailCache.set(s.id, s)
  return { skills, total: json.meta?.total ?? offset + skills.length }
}

/**
 * 通过 skillnet CLI 下载 GitHub 技能到本地 skillsDir。
 * skillId 即搜索结果的 skill_url（GitHub 链接）。
 */
async function downloadViaSkillnet(skillUrl: string, skillsDir: string): Promise<string> {
  if (!/^https?:\/\/github\.com\//i.test(skillUrl)) {
    throw new Error('仅支持从 GitHub 下载技能')
  }
  try {
    await execFileAsync('skillnet', ['download', skillUrl, '-d', skillsDir], {
      timeout: 120_000,
      windowsHide: true,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/ENOENT|not recognized|command not found/i.test(msg)) {
      throw new Error('未检测到 skillnet 命令，请先安装：pip install skillnet-ai')
    }
    throw new Error(`skillnet 下载失败：${msg}`)
  }
  return skillDirNameFromUrl(skillUrl)
}

export interface SkillnetStoreDeps {
  /** 本地技能安装目录（workspace/skills），与 list/uninstall 同源 */
  getSkillsDir: () => string
  /** 下载完成后重新扫描注册本地技能（reload runtime + watcher.refresh） */
  reloadSkills: () => Promise<void>
}

/**
 * 注册技能商店相关 IPC。所有远程操作均基于 SkillNet。
 */
export function registerSkillnetStoreHandlers(deps: SkillnetStoreDeps): void {
  ipcMain.handle('api:getStoreSkills', async (_e, q: StoreQuery = {}) => {
    try {
      const { skills, total } = await searchSkillnet(q)
      const offset = q.offset ?? 0
      const hasMore = offset + skills.length < total
      return { success: true, data: skills, meta: { total, hasMore } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // SkillNet 无「推荐/热门/最近/统计/分类」概念：返回空，商店为纯搜索驱动
  ipcMain.handle('api:getStoreFeatured', async () => ({ success: true, data: [] }))
  ipcMain.handle('api:getStorePopular', async () => ({ success: true, data: [] }))
  ipcMain.handle('api:getStoreRecent', async () => ({ success: true, data: [] }))
  ipcMain.handle('api:getStoreStats', async () => ({ success: true }))
  ipcMain.handle('api:getStoreCategories', async () => ({ success: true, data: [] }))
  ipcMain.handle('api:refreshStore', async () => ({ success: true }))

  ipcMain.handle('api:getStoreSkillDetail', async (_e, skillId: string) => {
    const cached = detailCache.get(skillId)
    if (cached) return { success: true, data: cached }
    return { success: false, error: '技能详情不可用，请重新搜索' }
  })

  ipcMain.handle('api:installStoreSkill', async (_e, skillId: string) => {
    try {
      const dirName = await downloadViaSkillnet(skillId, deps.getSkillsDir())
      await deps.reloadSkills()
      return { success: true, data: { skillId, dirName } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 独立版不提供在线创建（需 API_KEY）；用 skillnet CLI 创建后从本地目录导入
  ipcMain.handle('api:createUserSkill', async () => ({
    success: false,
    error: '独立版暂不支持在线创建技能，请用 skillnet CLI 创建后从本地目录导入',
  }))
}

