/**
 * 技能目录监控器
 *
 * 使用 Node.js 原生 fs.watch 监控技能目录，支持复制、移动、删除等所有操作。
 * chokidar polling 模式无法感知 move/rename 事件，因此改用原生 API。
 *
 * 设计要点：
 * - fs.watch 在 Windows 上使用 ReadDirectoryChangesW，能感知 rename（含 move）
 * - 防抖 1500ms：合并短时间内的多次事件为一次扫描
 * - isRebuilding 互斥锁：防止并发扫描竞态
 * - refresh() 公共方法：供 IPC 调用，手动触发重新扫描
 * - 支持嵌套分类目录：category/skillName/SKILL.md
 * - Agent 在客户端执行，无需向网关上报技能列表
 */

import fs from 'fs'
import path from 'path'
import { parseFrontmatter } from './skill-parser'
import { createLogger } from './logger'
import type { SkillMetadata } from './types/skill-metadata'

const log = createLogger('SkillWatcher')

/** 防抖延迟（ms）：等待文件系统操作完全稳定后再扫描 */
const DEBOUNCE_MS = 1500

/** 技能扫描最大分类嵌套深度（防御符号链接成环） */
const MAX_SKILL_SCAN_DEPTH = 6

/**
 * 本进程自己生成、不应触发重扫的文件名。
 *
 * index.json 由 LocalSkillStore 写在被监控的 skills/ 目录内：扫描 → 写索引 →
 * watch 事件 → 再扫描，会形成自激循环。技能的增删改本身一定伴随 skill.md /
 * 目录变动，仍会正常触发重扫，因此过滤掉索引文件不会漏掉真实变更。
 */
const SELF_WRITTEN_FILES: ReadonlySet<string> = new Set(['index.json'])

/** 判断 fs.watch 回调传来的路径是否为本进程自写文件（filename 为相对 skillsDir 的路径） */
function isSelfWrittenFile(filename: string | null): boolean {
  if (!filename) return false
  const normalized = filename.replace(/\\/g, '/')
  const base = normalized.includes('/')
    ? normalized.slice(normalized.lastIndexOf('/') + 1)
    : normalized
  return SELF_WRITTEN_FILES.has(base)
}

export class SkillWatcher {
  private watcher: fs.FSWatcher | null = null
  private skillsDir: string
  private skillList: SkillMetadata[] = []
  private isWatching = false
  /** 技能列表变更回调（本地通知，不上报网关） */
  private onSkillsChanged: ((skills: SkillMetadata[]) => void) | null = null
  /** 防抖定时器 */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  /** 互斥锁：防止并发扫描 */
  private isRebuilding = false

  constructor(workspaceDir: string) {
    this.skillsDir = path.join(workspaceDir, 'skills')
  }

  /** 设置技能列表变更回调（本地通知） */
  public setOnSkillsChanged(callback: (skills: SkillMetadata[]) => void): void {
    this.onSkillsChanged = callback
  }

  /** 启动监控 */
  public async start(): Promise<void> {
    if (this.isWatching) {
      log.warn('[start] 监控器已在运行')
      return
    }

    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true })
    }

    // 初始扫描
    await this.rebuildSkillList()

    // 启动原生 fs.watch（recursive 覆盖子目录，Windows 原生支持）
    try {
      this.watcher = fs.watch(
        this.skillsDir,
        { recursive: true, persistent: true },
        (_eventType, filename) => {
          if (isSelfWrittenFile(filename)) {
            log.debug(`[watch] 跳过本进程自写文件: ${filename}`)
            return
          }
          log.debug(`[watch] 事件: ${_eventType} filename=${filename ?? '(unknown)'}`)
          this.scheduleRebuild()
        }
      )

      this.watcher.on('error', (err) => {
        log.error('[watch] 监控器错误，尝试重启:', err)
        this.restartWatcher()
      })

      this.isWatching = true
      log.info(`[start] 技能监控器已启动，监控目录: ${this.skillsDir}`)
    } catch (err) {
      log.error('[start] 启动 fs.watch 失败:', err)
    }
  }

  /** 停止监控 */
  public async stop(): Promise<void> {
    this.cancelDebounce()
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    this.isWatching = false
    log.info('[stop] 技能监控器已停止')
  }

  /**
   * 手动刷新：重新扫描技能目录
   * 供 IPC 通道 skills:refresh 调用
   */
  public async refresh(): Promise<SkillMetadata[]> {
    log.info('[refresh] 手动触发技能刷新')
    this.cancelDebounce()
    await this.rebuildSkillList()
    return [...this.skillList]
  }

  /** 更新工作空间路径 */
  public async updateWorkspaceDir(newWorkspaceDir: string): Promise<void> {
    log.info(`[updateWorkspaceDir] 工作空间路径变更: ${newWorkspaceDir}`)
    await this.stop()
    this.skillsDir = path.join(newWorkspaceDir, 'skills')
    await this.start()
  }

  /** 获取当前技能列表（快照） */
  public getSkillList(): SkillMetadata[] {
    return [...this.skillList]
  }

  // ─── 私有方法 ────────────────────────────────────────────────────────────────

  /** 防抖调度：合并短时间内的多次事件为一次扫描 */
  private scheduleRebuild(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null
      await this.rebuildSkillList()
    }, DEBOUNCE_MS)
  }

  private cancelDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  /** 重新扫描技能目录（带互斥锁），扫描完成后通知本地回调 */
  private async rebuildSkillList(): Promise<void> {
    if (this.isRebuilding) {
      log.debug('[rebuildSkillList] 扫描已在进行中，跳过')
      return
    }
    this.isRebuilding = true
    try {
      this.skillList = await this.scanSkillsDirectory()
      log.info(`[rebuildSkillList] 扫描完成，找到 ${this.skillList.length} 个技能`)
      this.onSkillsChanged?.(this.skillList)
    } catch (error) {
      log.error('[rebuildSkillList] 扫描失败:', error)
    } finally {
      this.isRebuilding = false
    }
  }

  /**
   * 递归扫描技能目录，分类层级不限深度：
   *
   *   skills/skill-name/skill.md                → category: ''
   *   skills/分类/skill-name/skill.md            → category: '分类'
   *   skills/分类/子分类/skill-name/skill.md     → category: '分类/子分类'
   *
   * 判断标准：目录内存在文件名 toLowerCase() === 'skill.md'，该目录即技能本体，不再往下扫。
   */
  private async scanSkillsDirectory(): Promise<SkillMetadata[]> {
    const skills: SkillMetadata[] = []
    await this.scanCategoryDir(this.skillsDir, '', skills, 0)
    return skills
  }

  /** 递归扫描单个分类目录；depth 上限防御符号链接成环 */
  private async scanCategoryDir(
    absDir: string,
    category: string,
    out: SkillMetadata[],
    depth: number,
  ): Promise<void> {
    if (depth > MAX_SKILL_SCAN_DEPTH) {
      log.warn(`[scanSkillsDirectory] 超出最大扫描深度，停止下探: ${absDir}`)
      return
    }
    for (const entry of await readDirs(absDir)) {
      const childAbs = path.join(absDir, entry)
      const skillFile = await findSkillMd(childAbs)
      if (skillFile) {
        const meta = await readSkillMeta(childAbs, skillFile, entry, category)
        if (meta) out.push(meta)
      } else {
        const childCategory = category ? `${category}/${entry}` : entry
        await this.scanCategoryDir(childAbs, childCategory, out, depth + 1)
      }
    }
  }

  /** 监控器出错后重启 */
  private async restartWatcher(): Promise<void> {
    this.watcher?.close()
    this.watcher = null
    this.isWatching = false
    await new Promise((r) => setTimeout(r, 2000))
    await this.start()
  }
}

// ─── 模块级辅助函数 ──────────────────────────────────────────────────────────

/** 读取目录下所有子目录名，目录不存在时返回空数组 */
async function readDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * 在指定目录中查找 skill.md 文件（大小写不敏感）
 * 返回实际文件名，未找到返回 null
 */
async function findSkillMd(dir: string): Promise<string | null> {
  try {
    const files = await fs.promises.readdir(dir)
    return files.find((f) => f.toLowerCase() === 'skill.md') ?? null
  } catch {
    return null
  }
}

/**
 * 读取技能目录的元数据
 * @param dir       技能目录绝对路径
 * @param skillFile skill.md 的实际文件名
 * @param dirName   目录名（作为 name 的回退值）
 * @param category  分类目录名，无分类时传空字符串
 */
async function readSkillMeta(
  dir: string,
  skillFile: string,
  dirName: string,
  category: string,
): Promise<SkillMetadata | null> {
  const skillMdPath = path.join(dir, skillFile)
  try {
    const content = await fs.promises.readFile(skillMdPath, 'utf-8')
    const frontmatter = parseFrontmatter(content)
    const stat = await fs.promises.stat(skillMdPath)
    const location = category
      ? `${category}/${dirName}/${skillFile}`
      : `${dirName}/${skillFile}`
    return {
      name: (frontmatter.name as string) || dirName,
      description: (frontmatter.description as string) || '',
      version: (frontmatter.version as string) || '1.0.0',
      location,
      category,
      enabled: true,
      lastModified: Math.floor(stat.mtimeMs),
    }
  } catch {
    return null
  }
}
