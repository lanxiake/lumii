/**
 * LocalSkillStore - 本地技能存储管理
 *
 * 管理本地技能文件与索引（路径由构造参数传入，通常位于工作空间下 skills/）
 * 维护 index.json 索引文件，支持安装、卸载、列表查询
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { createLogger } from './logger'
import { parseSkillMdFrontmatter } from './skill-md-frontmatter'

/** 日志 */
const log = createLogger('LocalSkillStore')

/**
 * SKILL.md 元数据结构
 */
interface SkillMetadata {
  name: string
  description?: string
  version?: string
  triggers?: string[]
  tags?: string[]
  author?: string
}

/**
 * 从 SKILL.md 提取元数据（优先解析 YAML frontmatter 中的 name / description）
 */
function extractSkillMetadata(skillMdContent: string, dirName: string): SkillMetadata {
  const normalizedContent = skillMdContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const fm = parseSkillMdFrontmatter(normalizedContent)
  if (fm.name?.trim() || fm.description !== undefined || fm.version) {
    return {
      name: fm.name?.trim() || dirName,
      description: typeof fm.description === 'string' ? fm.description.trim() : undefined,
      version: fm.version?.trim() || '1.0.0',
    }
  }

  // 无 frontmatter：从第一个标题提取 name
  const titleMatch = normalizedContent.match(/^#\s+(.+)$/m)
  const name = titleMatch ? titleMatch[1].trim() : dirName

  const lines = normalizedContent.split('\n')
  let description: string | undefined
  let foundTitle = false
  for (const line of lines) {
    if (line.startsWith('#')) {
      foundTitle = true
      continue
    }
    if (foundTitle && line.trim() && !line.startsWith('#')) {
      description = line.trim()
      break
    }
  }

  return {
    name,
    description,
    version: '1.0.0',
  }
}

/**
 * 技能清单文件结构 (skill.json)
 */
export interface SkillManifest {
  /** 技能 ID */
  id: string
  /** 技能名称 */
  name: string
  /** 技能描述 */
  description?: string
  /** 版本 */
  version: string
  /** 作者 */
  author?: string
  /** 入口文件（相对于技能目录） */
  entry: string
  /** 运行时类型 */
  runtime: 'typescript' | 'javascript' | 'python' | 'shell'
  /** 权限声明 */
  permissions?: {
    fileSystem?: { read?: string[]; write?: string[] }
    network?: { allowedHosts?: string[]; allowAll?: boolean }
    process?: { allowedCommands?: string[]; allowAll?: boolean }
    requireConfirm?: boolean
  }
  /** 支持平台 */
  platforms?: string[]
  /** 分类 */
  category?: string
  /** 图标 */
  icon?: string
}

/**
 * 索引文件中的技能条目
 */
export interface SkillIndexEntry {
  /** 技能 ID（唯一，格式：dirName 或 category/dirName） */
  id: string
  /** 技能目录名 */
  dirName: string
  /** 分类目录名，无分类时为空字符串 */
  category: string
  /** 技能名称 */
  name: string
  /** 技能描述 */
  description: string
  /** 版本 */
  version: string
  /** 运行时类型 */
  runtime: string
  /** 安装时间 */
  installedAt: string
  /** 是否启用 */
  enabled: boolean
  /** 最后执行时间 */
  lastExecutedAt?: string
  /** 执行次数 */
  executionCount: number
  /**
   * 系统自动推断的激活范围（不需要用户手动配置）：
   * - always：高频主动调用，每轮强制注入
   * - contextual：正常按上下文匹配（默认）
   * - on_demand：从未被自动激活命中，仅用户显式调用
   *
   * 由 skill-hit-rate-hook 在每轮结束后根据历史统计自动更新，用户无需感知。
   */
  autoActivationScope?: "always" | "contextual" | "on_demand"
  /**
   * 带时间衰减的加权调用分（用于自动分层决策）。
   * 每次成功 invoke +1，每次 search +0.5，每轮衰减 × 0.95。
   * 不直接累加次数，避免陈旧数据永久生效。
   */
  weightedScore?: number
  /** 观测轮次数（flush 调用次数），用于保护新技能不被过早降级 */
  observationCount?: number
  /** 最近一次统计更新时间 */
  statsUpdatedAt?: string
}

/**
 * 索引文件结构
 */
export interface SkillIndex {
  /** 版本 */
  version: number
  /** 最后更新时间 */
  updatedAt: string
  /** 技能列表 */
  skills: SkillIndexEntry[]
}

/**
 * 本地技能存储
 */
export class LocalSkillStore {
  private readonly skillsDir: string
  private readonly indexPath: string
  private index: SkillIndex | null = null

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir
    this.indexPath = path.join(skillsDir, 'index.json')
  }

  /**
   * 初始化存储目录和索引
   */
  async initialize(): Promise<void> {
    log.info('初始化本地技能存储', { skillsDir: this.skillsDir })

    // 确保目录存在
    await fs.promises.mkdir(this.skillsDir, { recursive: true })

    // 加载或创建索引
    this.index = await this.loadIndex()

    // 扫描技能目录，自动注册未在索引中的技能
    await this.scanAndRegisterSkills()

    log.info('本地技能存储初始化完成', { skillCount: this.index.skills.length })
  }

  /**
   * 扫描技能目录并自动注册未在索引中的技能
   * 支持两种格式：
   * 1. mtbot 标准格式（skill.json 包含 id、entry、runtime）
   * 2. Claude Code 格式（SKILL.md + 可选的 skill.json 元数据）
   */
  private async scanAndRegisterSkills(): Promise<void> {
    try {
      await this.ensureIndex()
      log.info('[scanAndRegisterSkills] 开始扫描技能目录', { skillsDir: this.skillsDir })

      // 收集所有技能目录（两层结构）
      const skillDirs = await collectSkillDirs(this.skillsDir)
      const skillIdSet = new Set(skillDirs.map((s) => s.id))

      // 移除索引中已不存在的条目
      const beforeLen = this.index!.skills.length
      this.index!.skills = this.index!.skills.filter((s) => skillIdSet.has(s.id))
      let indexDirty = beforeLen !== this.index!.skills.length

      log.info('[scanAndRegisterSkills] 找到技能目录', { count: skillDirs.length })

      let registeredCount = 0

      for (const { id, dirName, category, skillMdPath } of skillDirs) {
        try {
          const skillMdContent = await fs.promises.readFile(skillMdPath, 'utf-8')
          const metadata = extractSkillMetadata(skillMdContent, dirName)

          const existingIdx = this.index!.skills.findIndex((s) => s.id === id)
          if (existingIdx >= 0) {
            const prev = this.index!.skills[existingIdx]
            const next = {
              ...prev,
              category,
              name: metadata.name,
              description: metadata.description || prev.description || '',
              version: metadata.version || prev.version,
            }
            const changed =
              next.name !== prev.name ||
              next.description !== prev.description ||
              next.version !== prev.version ||
              next.category !== prev.category
            this.index!.skills = this.index!.skills.map((s) => (s.id === id ? next : s))
            if (changed) indexDirty = true
            registeredCount++
            continue
          }

          // 注册新技能
          const entry: SkillIndexEntry = {
            id,
            dirName,
            category,
            name: metadata.name,
            description: metadata.description || '',
            version: metadata.version || '1.0.0',
            runtime: 'claude-code',
            installedAt: new Date().toISOString(),
            enabled: true,
            executionCount: 0,
          }
          this.index!.skills.push(entry)
          registeredCount++
          indexDirty = true
          log.info('自动注册技能', { id, name: entry.name, category })
        } catch (error) {
          log.warn('扫描技能目录失败', { id, error: error instanceof Error ? error.message : String(error) })
        }
      }

      if (indexDirty || registeredCount > 0) {
        await this.saveIndex()
        log.info('索引同步完成', { registeredCount, indexDirty })
      } else {
        log.info('[scanAndRegisterSkills] 索引与目录一致，跳过写入')
      }
    } catch (error) {
      log.error('扫描技能目录失败', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * 从磁盘目录安装技能
   *
   * 将源目录复制到 skillsDir 下，并更新索引
   *
   * @param sourceDir - 技能源目录（需包含 skill.json）
   * @returns 安装结果
   */
  async installFromDirectory(sourceDir: string): Promise<{
    success: boolean
    skillId?: string
    error?: string
  }> {
    log.info('从目录安装技能', { sourceDir })

    try {
      // 读取 skill.json
      const manifestPath = path.join(sourceDir, 'skill.json')
      const manifestExists = await fileExists(manifestPath)

      if (!manifestExists) {
        return { success: false, error: '源目录缺少 skill.json 清单文件' }
      }

      const manifestContent = await fs.promises.readFile(manifestPath, 'utf-8')
      const manifest: SkillManifest = JSON.parse(manifestContent)

      // SKILL.md 中的 name/description 优先于 skill.json（与商店包规范一致）
      for (const fn of ['SKILL.md', 'skill.md', 'Skill.md']) {
        const mdPath = path.join(sourceDir, fn)
        if (await fileExists(mdPath)) {
          const md = await fs.promises.readFile(mdPath, 'utf-8')
          const fm = parseSkillMdFrontmatter(md)
          if (fm.name?.trim()) {
            manifest.name = fm.name.trim()
          }
          if (fm.description !== undefined) {
            manifest.description = fm.description.trim()
          }
          break
        }
      }

      // 验证清单
      const validation = validateManifest(manifest)
      if (!validation.valid) {
        return { success: false, error: `清单文件无效: ${validation.errors.join(', ')}` }
      }

      // 检查入口文件是否存在
      const entryPath = path.join(sourceDir, manifest.entry)
      const entryExists = await fileExists(entryPath)

      if (!entryExists) {
        return { success: false, error: `入口文件不存在: ${manifest.entry}` }
      }

      // 目标目录：与 SKILL.md / 清单中的展示名称一致（非法字符已清理）
      const targetDirName = sanitizeDirName(manifest.name || manifest.id)
      const targetDir = path.join(this.skillsDir, targetDirName)

      // 如果已存在，先删除旧版本
      if (await fileExists(targetDir)) {
        log.info('删除旧版本技能目录', { targetDir })
        await fs.promises.rm(targetDir, { recursive: true, force: true })
      }

      // 复制目录
      await copyDirectory(sourceDir, targetDir)

      // 更新索引
      await this.ensureIndex()
      const existingIdx = this.index!.skills.findIndex((s) => s.id === manifest.id)
      const entry: SkillIndexEntry = {
        id: manifest.id,
        dirName: targetDirName,
        category: manifest.category || '',
        name: manifest.name,
        description: manifest.description || '',
        version: manifest.version,
        runtime: manifest.runtime,
        installedAt: new Date().toISOString(),
        enabled: true,
        executionCount: 0,
      }

      if (existingIdx >= 0) {
        this.index!.skills = this.index!.skills.map(s => s.id === manifest.id ? entry : s)
      } else {
        this.index!.skills = [...this.index!.skills, entry]
      }

      await this.saveIndex()

      log.info('技能安装成功', { skillId: manifest.id, version: manifest.version })
      return { success: true, skillId: manifest.id }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error('技能安装失败', { error: errorMessage })
      return { success: false, error: errorMessage }
    }
  }

  /**
   * 卸载技能
   */
  async uninstall(skillId: string): Promise<{ success: boolean; error?: string }> {
    log.info('卸载技能', { skillId })

    await this.ensureIndex()
    const entry = this.index!.skills.find((s) => s.id === skillId)

    if (!entry) {
      return { success: false, error: `技能不存在: ${skillId}` }
    }

    try {
      // 删除技能目录
      const skillDir = path.join(this.skillsDir, entry.dirName)
      if (await fileExists(skillDir)) {
        await fs.promises.rm(skillDir, { recursive: true, force: true })
      }

      // 从索引中移除
      this.index!.skills = this.index!.skills.filter((s) => s.id !== skillId)
      await this.saveIndex()

      log.info('技能卸载成功', { skillId })
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error('技能卸载失败', { skillId, error: errorMessage })
      return { success: false, error: errorMessage }
    }
  }

  /**
   * 获取已安装技能列表
   */
  async listInstalled(): Promise<SkillIndexEntry[]> {
    await this.ensureIndex()
    return [...this.index!.skills]
  }

  /**
   * 获取技能清单
   */
  async getManifest(skillId: string): Promise<SkillManifest | null> {
    await this.ensureIndex()
    const entry = this.index!.skills.find((s) => s.id === skillId)
    if (!entry) {
      return null
    }

    const manifestPath = path.join(this.skillsDir, entry.dirName, 'skill.json')
    try {
      const content = await fs.promises.readFile(manifestPath, 'utf-8')
      return JSON.parse(content) as SkillManifest
    } catch {
      log.warn('读取技能清单失败', { skillId, manifestPath })
      return null
    }
  }

  /**
   * 获取技能入口文件的绝对路径
   */
  async getEntryPath(skillId: string): Promise<string | null> {
    const manifest = await this.getManifest(skillId)
    if (!manifest) {
      return null
    }

    const entry = this.index!.skills.find((s) => s.id === skillId)
    if (!entry) {
      return null
    }

    return path.join(this.skillsDir, entry.dirName, manifest.entry)
  }

  /**
   * 启用/禁用技能
   */
  async setEnabled(skillId: string, enabled: boolean): Promise<boolean> {
    await this.ensureIndex()
    const entry = this.index!.skills.find((s) => s.id === skillId)
    if (!entry) {
      return false
    }

    this.index!.skills = this.index!.skills.map((s) =>
      s.id === skillId ? { ...s, enabled } : s,
    )
    await this.saveIndex()
    return true
  }

  /**
   * 更新执行统计
   */
  async recordExecution(skillId: string): Promise<void> {
    await this.ensureIndex()
    this.index!.skills = this.index!.skills.map((s) =>
      s.id === skillId
        ? {
            ...s,
            executionCount: s.executionCount + 1,
            lastExecutedAt: new Date().toISOString(),
          }
        : s,
    )
    await this.saveIndex()
  }

  /**
   * 兼容查找：先按 id 精确匹配，找不到再按 name（不区分大小写）匹配，
   * 返回找到的 skillId；都找不到返回 null。
   *
   * 用于 skill_invoke 工具只传了 name 场景（通用层 fallback），
   * 避免只传 name 时统计永远落不到正确条目上。
   */
  resolveSkillId(skillIdOrName: string): string | null {
    if (!this.index?.skills) return null
    const byId = this.index.skills.find((s) => s.id === skillIdOrName)
    if (byId) return byId.id
    const lower = skillIdOrName.toLowerCase()
    const byName = this.index.skills.find((s) => s.name.toLowerCase() === lower)
    return byName ? byName.id : null
  }

  /**
   * 批量更新技能激活范围（系统自动调用，用户无感知）。
   * 接收本轮所有技能的 delta Map，一次性更新并写磁盘一次（修复 #4 多次写磁盘）。
   *
   * 决策算法（修复 #1 时间衰减 + #3 冷启动保护）：
   * 1. 每轮先对历史分 × 0.95（时间衰减），避免陈旧数据永久生效
   * 2. 本轮 invokeSuccess 每次 +1，search 每次 +0.3（搜索权重低于调用）
   * 3. 观测轮次 < MIN_OBSERVATION_ROUNDS 时保持 contextual（新技能保护期）
   * 4. 分层规则（observationCount 满足后）：
   *    - score ≥ 4.0  → always
   *    - score ≥ 0.5  → contextual
   *    - score < 0.5 且观测 ≥ MIN_OBSERVATION_ROUNDS → on_demand（真正长期不用）
   */
  async updateAutoScopeBatch(
    deltas: Map<string, { invokeSuccess?: number; searchCount?: number }>,
  ): Promise<void> {
    if (deltas.size === 0) return
    await this.ensureIndex()

    const MIN_OBSERVATION_ROUNDS = 10
    const DECAY = 0.95
    const ALWAYS_THRESHOLD = 4.0
    const ON_DEMAND_THRESHOLD = 0.5

    let dirty = false
    const now = new Date().toISOString()

    this.index!.skills = this.index!.skills.map((s) => {
      const delta = deltas.get(s.id)
      // 无论本轮是否有调用，都做衰减（每轮 flush 都会经过此处）
      const decayedScore = (s.weightedScore ?? 0) * DECAY
      const addScore = (delta?.invokeSuccess ?? 0) * 1.0 + (delta?.searchCount ?? 0) * 0.3
      const newScore = decayedScore + addScore
      const newObservation = (s.observationCount ?? 0) + 1

      let scope: SkillIndexEntry["autoActivationScope"] = s.autoActivationScope ?? "contextual"

      if (newObservation < MIN_OBSERVATION_ROUNDS) {
        // 保护期：不降级，只升级
        if (newScore >= ALWAYS_THRESHOLD) scope = "always"
        else scope = s.autoActivationScope ?? "contextual"
      } else if (newScore >= ALWAYS_THRESHOLD) {
        scope = "always"
      } else if (newScore >= ON_DEMAND_THRESHOLD) {
        scope = "contextual"
      } else {
        scope = "on_demand"
      }

      const changed =
        scope !== s.autoActivationScope ||
        Math.abs(newScore - (s.weightedScore ?? 0)) > 0.01 ||
        newObservation !== s.observationCount

      if (!changed) return s
      dirty = true

      if (scope !== s.autoActivationScope) {
        log.info(
          `[updateAutoScopeBatch] "${s.name}" 激活范围自动调整: ${s.autoActivationScope ?? "contextual"} → ${scope}` +
          ` (score=${newScore.toFixed(2)} obs=${newObservation})`,
        )
      }

      return {
        ...s,
        weightedScore: newScore,
        observationCount: newObservation,
        autoActivationScope: scope,
        statsUpdatedAt: now,
      }
    })

    if (dirty) await this.saveIndex()
  }

  /**
   * 获取所有技能的自动激活范围快照（供 getSkills 使用）
   */
  getAutoScopeMap(): Map<string, SkillIndexEntry["autoActivationScope"]> {
    const map = new Map<string, SkillIndexEntry["autoActivationScope"]>()
    for (const s of this.index?.skills ?? []) {
      if (s.autoActivationScope) map.set(s.id, s.autoActivationScope)
    }
    return map
  }

  /**
   * 重新从磁盘读取索引（丢弃内存缓存）
   */
  async reload(): Promise<void> {
    this.index = await this.loadIndex()
    // 重新加载后执行一次目录扫描，确保手动复制/解压进来的技能也会回填到 index.json。
    await this.scanAndRegisterSkills()
    log.info('索引已重新加载', { skillCount: this.index.skills.length })
  }

  /**
   * 获取技能安装目录的绝对路径
   *
   * @param skillId - 技能 ID
   * @returns 技能目录路径，不存在时返回 null
   */
  getSkillDirectory(skillId: string): string | null {
    if (!this.index) {return null}
    const entry = this.index.skills.find((s) => s.id === skillId)
    if (!entry) {return null}
    const dir = entry.category
      ? path.join(this.skillsDir, entry.category, entry.dirName)
      : path.join(this.skillsDir, entry.dirName)
    return fs.existsSync(dir) ? dir : null
  }

  /**
   * 加载索引文件
   */
  private async loadIndex(): Promise<SkillIndex> {
    try {
      const content = await fs.promises.readFile(this.indexPath, 'utf-8')
      const index = JSON.parse(content) as SkillIndex
      // 兼容旧版 index.json（缺少 description 字段）
      index.skills = index.skills.map(s => ({ ...s, description: s.description ?? '' }))
      return index
    } catch {
      // 索引不存在或损坏，创建新的
      return {
        version: 1,
        updatedAt: new Date().toISOString(),
        skills: [],
      }
    }
  }

  /**
   * 保存索引文件
   */
  private async saveIndex(): Promise<void> {
    if (!this.index) {
      return
    }

    this.index = {
      ...this.index,
      updatedAt: new Date().toISOString(),
    }

    await fs.promises.writeFile(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8')
    log.debug('索引已保存', { skillCount: this.index.skills.length })
  }

  /**
   * 确保索引已加载
   */
  private async ensureIndex(): Promise<void> {
    if (!this.index) {
      this.index = await this.loadIndex()
    }
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 验证技能清单
 */
export function validateManifest(manifest: SkillManifest): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (!manifest.id || typeof manifest.id !== 'string') {
    errors.push('缺少有效的 id 字段')
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push('缺少有效的 name 字段')
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    errors.push('缺少有效的 version 字段')
  }
  if (!manifest.entry || typeof manifest.entry !== 'string') {
    errors.push('缺少有效的 entry 字段')
  }
  if (!manifest.runtime || !['typescript', 'javascript', 'python', 'shell'].includes(manifest.runtime)) {
    errors.push('runtime 字段必须为 typescript、javascript、python 或 shell')
  }

  return { valid: errors.length === 0, errors }
}

/**
 * 清理目录名（移除特殊字符）
 */
function sanitizeDirName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * 检查文件/目录是否存在
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 收集 skillsDir 下所有技能目录（固定两层结构）
 *
 *   skills/skill-name/skill.md          → id: 'skill-name',  category: ''
 *   skills/分类名/skill-name/skill.md   → id: '分类名/skill-name', category: '分类名'
 *
 * 判断标准：目录内存在文件名 toLowerCase() === 'skill.md'
 */
async function collectSkillDirs(skillsDir: string): Promise<Array<{
  id: string
  dirName: string
  category: string
  skillMdPath: string
}>> {
  const result: Array<{ id: string; dirName: string; category: string; skillMdPath: string }> = []

  let layer1: fs.Dirent[]
  try {
    layer1 = await fs.promises.readdir(skillsDir, { withFileTypes: true })
  } catch {
    return result
  }

  for (const entry of layer1) {
    if (!entry.isDirectory()) continue
    const dir1 = path.join(skillsDir, entry.name)
    const skillMd = await findSkillMdFile(dir1)
    if (skillMd) {
      result.push({ id: entry.name, dirName: entry.name, category: '', skillMdPath: path.join(dir1, skillMd) })
    } else {
      // 分类目录，扫第二层
      let layer2: fs.Dirent[]
      try {
        layer2 = await fs.promises.readdir(dir1, { withFileTypes: true })
      } catch {
        continue
      }
      for (const sub of layer2) {
        if (!sub.isDirectory()) continue
        const dir2 = path.join(dir1, sub.name)
        const subSkillMd = await findSkillMdFile(dir2)
        if (subSkillMd) {
          result.push({
            id: `${entry.name}/${sub.name}`,
            dirName: sub.name,
            category: entry.name,
            skillMdPath: path.join(dir2, subSkillMd),
          })
        }
      }
    }
  }

  return result
}

/** 在目录中查找 skill.md（大小写不敏感），返回实际文件名或 null */
async function findSkillMdFile(dir: string): Promise<string | null> {
  try {
    const files = await fs.promises.readdir(dir)
    return files.find((f) => f.toLowerCase() === 'skill.md') ?? null
  } catch {
    return null
  }
}

/**
 * 递归复制目录
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true })
  const entries = await fs.promises.readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath)
    } else {
      await fs.promises.copyFile(srcPath, destPath)
    }
  }
}
