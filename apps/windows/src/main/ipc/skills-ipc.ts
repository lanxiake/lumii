/**
 * 本地技能管理相关 IPC handlers
 */
import { ipcMain } from 'electron'
import { join, basename, resolve, sep } from 'path'
import { promises as fs } from 'fs'
import type { ClientSkillRuntime } from '../skill-runtime'
import type { SkillWatcher } from '../skill-watcher'
import { wrapSingleFile } from '../skill-wrapper'

interface SkillsIpcDeps {
  getSkillRuntime: () => ClientSkillRuntime | null
  getSkillWatcher: () => SkillWatcher | null
  getWorkspaceDir: () => string
  log: {
    debug: (...args: unknown[]) => void
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
  }
}

let deps: SkillsIpcDeps | null = null

export function setSkillsIpcDeps(d: SkillsIpcDeps): void {
  deps = d
}

export function registerSkillsIpcHandlers(): void {
  if (!deps) throw new Error('SkillsIpc deps not set')

  /**
   * 列出本地已安装技能
   */
  ipcMain.handle('skills:listLocalInstalled', async () => {
    const skillRuntime = deps!.getSkillRuntime()
    if (!skillRuntime) {
      deps!.log.warn('[Skills IPC] 技能运行时未初始化，返回空列表')
      return { success: true, data: [] }
    }
    deps!.log.debug('[Skills IPC] 列出本地已安装技能')
    const result = await skillRuntime.listLocalInstalled()
    return { success: true, data: result }
  })

  /**
   * 从目录安装技能
   */
  ipcMain.handle('skills:installFromDirectory', async (_event, sourceDir: string) => {
    const skillRuntime = deps!.getSkillRuntime()
    if (!skillRuntime) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
      throw new Error('无效的源目录路径')
    }
    deps!.log.info('[Skills IPC] 从目录安装技能', { sourceDir })
    return skillRuntime.installFromDirectory(sourceDir)
  })

  /**
   * 从外部目录导入技能（仅含 SKILL.md 的知识型技能）
   * 将源目录复制到 skillsDir，然后触发 scanAndRegister 自动注册
   */
  ipcMain.handle('skills:importDirectory', async (_event, sourceDir: string) => {
    const skillRuntime = deps!.getSkillRuntime()
    const skillWatcher = deps!.getSkillWatcher()
    if (!skillRuntime || !skillWatcher) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
      throw new Error('无效的源目录路径')
    }

    const dirName = basename(sourceDir)
    const skillsDir = join(deps!.getWorkspaceDir(), 'skills')
    const targetDir = join(skillsDir, dirName)

    deps!.log.info('[Skills IPC] 导入技能目录', { sourceDir, targetDir })

    // 如果目标已存在则先删除（覆盖更新）
    try {
      await fs.access(targetDir)
      await fs.rm(targetDir, { recursive: true, force: true })
    } catch {
      // 目标不存在，正常继续
    }

    // 递归复制目录
    await fs.cp(sourceDir, targetDir, { recursive: true })

    // 触发扫描注册
    await skillRuntime.reloadExternalSkills()
    const skills = await skillWatcher.refresh()

    deps!.log.info('[Skills IPC] 技能目录导入完成', { dirName, totalSkills: skills.length })
    return { success: true, skillId: dirName }
  })

  /**
   * 卸载本地技能
   */
  ipcMain.handle('skills:uninstallLocal', async (_event, skillId: string) => {
    const skillRuntime = deps!.getSkillRuntime()
    const skillWatcher = deps!.getSkillWatcher()
    if (!skillRuntime) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof skillId !== 'string' || skillId.length === 0) {
      throw new Error('无效的技能 ID')
    }
    deps!.log.info('[Skills IPC] 卸载本地技能', { skillId })
    const result = await skillRuntime.uninstallLocal(skillId)
    // 卸载后重新扫描并上报
    skillWatcher?.refresh().catch((err) => deps!.log.warn('[Skills IPC] 卸载后刷新失败:', err))
    return result
  })

  /**
   * 本地执行技能
   */
  ipcMain.handle('skills:executeLocal', async (_event, params: {
    skillId: string
    params: Record<string, unknown>
    timeoutMs?: number
  }) => {
    const skillRuntime = deps!.getSkillRuntime()
    if (!skillRuntime) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof params.skillId !== 'string' || params.skillId.length === 0) {
      throw new Error('无效的技能 ID')
    }
    deps!.log.info('[Skills IPC] 本地执行技能', { skillId: params.skillId })
    return skillRuntime.executeSkill({
      requestId: `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      skillId: params.skillId,
      params: params.params ?? {},
      requireConfirm: false,
      timeoutMs: params.timeoutMs ?? 120_000,
      runMode: 'local',
    })
  })

  /**
   * 启用/禁用技能
   */
  ipcMain.handle('skills:setEnabled', async (_event, skillId: string, enabled: boolean) => {
    const skillRuntime = deps!.getSkillRuntime()
    const skillWatcher = deps!.getSkillWatcher()
    if (!skillRuntime) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof skillId !== 'string' || skillId.length === 0) {
      throw new Error('无效的技能 ID')
    }
    if (typeof enabled !== 'boolean') {
      throw new Error('enabled 必须为布尔值')
    }
    deps!.log.info('[Skills IPC] 设置技能启用状态', { skillId, enabled })
    const result = await skillRuntime.setLocalEnabled(skillId, enabled)
    // 启用/禁用后重新扫描并上报
    skillWatcher?.refresh().catch((err) => deps!.log.warn('[Skills IPC] 状态变更后刷新失败:', err))
    return result
  })

  /**
   * 获取技能详情
   */
  ipcMain.handle('skills:getSkillDetail', async (_event, skillId: string) => {
    const skillRuntime = deps!.getSkillRuntime()
    if (!skillRuntime) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof skillId !== 'string' || skillId.length === 0) {
      throw new Error('无效的技能 ID')
    }
    deps!.log.info('[Skills IPC] 获取技能详情', { skillId })
    return skillRuntime.getSkillDetail(skillId)
  })

  /**
   * 手动刷新技能列表：重新扫描本地技能目录并上报到 Gateway
   */
  ipcMain.handle('skills:refresh', async () => {
    const skillRuntime = deps!.getSkillRuntime()
    const skillWatcher = deps!.getSkillWatcher()
    if (!skillWatcher) {
      throw new Error('技能监控器未初始化')
    }
    deps!.log.info('[Skills IPC] 手动触发技能刷新')
    // 先同步本地索引与运行时，再执行 watcher 扫描上报，避免"上报数量已更新但列表未更新"。
    if (skillRuntime) {
      await skillRuntime.reloadExternalSkills()
    }
    const skills = await skillWatcher.refresh()
    return { success: true, count: skills.length }
  })

  /**
   * 获取技能所在目录的绝对路径
   */
  ipcMain.handle('skills:getSkillDir', async (_event, skillId: string) => {
    if (typeof skillId !== 'string' || skillId.length === 0) {
      throw new Error('无效的技能 ID')
    }
    const skillsDir = join(deps!.getWorkspaceDir(), 'skills')
    // 索引里已记录 category（可能是多级分类），优先用它解析真实安装目录
    const fromStore = deps!.getSkillRuntime()?.getSkillStore()?.getSkillDirectory(skillId)
    if (fromStore) return fromStore

    const resolved = resolve(skillsDir, skillId)
    if (resolved !== skillsDir && !resolved.startsWith(skillsDir + sep)) {
      throw new Error('技能 ID 越出技能目录')
    }
    return resolved
  })

  /**
   * 从单文件脚本安装技能（自动包装 + 安装）
   */
  ipcMain.handle('skills:installFromScript', async (_event, filePath: string, meta?: {
    name?: string
    description?: string
  }) => {
    const skillRuntime = deps!.getSkillRuntime()
    if (!skillRuntime) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('无效的文件路径')
    }
    deps!.log.info('[Skills IPC] 从脚本安装技能', { filePath, meta })

    // 先包装为技能目录
    const skillsDir = join(deps!.getWorkspaceDir(), 'skills', '.wrap-temp')
    const wrapResult = await wrapSingleFile({
      filePath,
      outputDir: skillsDir,
      meta,
    })

    if (!wrapResult.success || !wrapResult.skillDir) {
      return { success: false, error: wrapResult.error ?? '包装失败' }
    }

    // 再通过 installFromDirectory 安装
    const installResult = await skillRuntime.installFromDirectory(wrapResult.skillDir)

    // 清理临时目录
    try {
      await fs.rm(wrapResult.skillDir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结果
    }

    return installResult
  })
}
