import { spawn } from 'child_process'
import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { ConfigManager } from '../config-manager'
import { directoryManager } from '../directory-manager'
import {
  buildCodingDevEnvInfo,
  defaultWorkspaceFallback,
} from '../coding-dev-env.js'
import {
  detectLocalAcpTool,
  isPrimaryLocalAcpToolId,
  listLocalAcpToolsMetadata,
  needsWindowsShell,
} from '../coding-dev-cli-detect.js'
import {
  installLocalAcpTool,
  previewUninstallLocalAcpTool,
  uninstallLocalAcpTool,
} from '../coding-dev-cli-install.js'
import {
  createProject,
  openExistingProject,
  removeProject,
  reconcileProjectsWithDisk,
} from '../coding-dev-projects.js'
import { resolveClientStateDir } from '../paths'
import { getProjectGitStatus } from '../project-git/project-git-status'

export interface CodingDevIpcOptions {
  getConfigManager: () => ConfigManager | null
  getActiveWorkspaceDir: () => string
  reapplyCodingDevAcpEnv: () => void
}

export function registerCodingDevIpcHandlers(options: CodingDevIpcOptions): void {
  const { getConfigManager, getActiveWorkspaceDir, reapplyCodingDevAcpEnv } = options

  ipcMain.handle('app:getCodingDevEnvInfo', async () => {
    if (!getConfigManager()) {
      throw new Error('ConfigManager 未初始化')
    }
    const mtbotDataDir = resolveClientStateDir()
    const fb = defaultWorkspaceFallback(mtbotDataDir)
    return buildCodingDevEnvInfo({
      appConfig: getConfigManager()!.getAppConfig(),
      defaultWorkspaceFallback: fb,
    })
  })

  /** 获取本机 ACP 工具元数据（名称、链接、安装命令）— 同步读取，无版本探测 */
  ipcMain.handle('app:listCodingDevToolsMetadata', () => {
    return listLocalAcpToolsMetadata()
  })

  /** 探测单个本机 ACP 工具是否已安装，并返回版本信息 */
  ipcMain.handle('app:detectCodingDevTool', async (_event, toolId: string) => {
    if (!isPrimaryLocalAcpToolId(toolId)) {
      throw new Error(`未知工具 ID: ${toolId}`)
    }
    return detectLocalAcpTool(toolId)
  })

  ipcMain.handle('app:installCodingDevTool', async (_event, toolId: string) => {
    return installLocalAcpTool(toolId)
  })

  /** 卸载本机 ACP CLI（执行官方白名单卸载命令或手动移除文档化路径） */
  ipcMain.handle('app:uninstallCodingDevTool', async (_event, toolId: string) => {
    return uninstallLocalAcpTool(toolId)
  })

  /** 卸载前预览：将要执行的命令与风险提示（不执行） */
  ipcMain.handle('app:previewUninstallCodingDevTool', async (_event, toolId: string) => {
    return previewUninstallLocalAcpTool(toolId)
  })

  /** 触发 CLI 登录流程（如 cursor 的 agent login，打开浏览器 OAuth） */
  ipcMain.handle('app:loginCodingDevTool', async (_event, toolId: string) => {
    if (!isPrimaryLocalAcpToolId(toolId)) {
      throw new Error(`未知工具 ID: ${toolId}`)
    }
    const status = await detectLocalAcpTool(toolId)
    if (!status.installed || !status.resolvedPath) {
      throw new Error(`${status.label} 未安装`)
    }
    // cursor: agent login 打开浏览器，等待用户完成授权
    // 其他 CLI 同样逻辑，按需扩展
    const loginArgs: Record<string, string[]> = {
      cursor: ['login'],
      claude: ['login'],
      codex: ['auth', 'login'],
      opencode: ['login'],
    }
    const args = loginArgs[toolId]
    if (!args) {
      throw new Error(`${status.label} 暂不支持客户端一键登录，请在命令行手动执行`)
    }
    return new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      const useShell = needsWindowsShell(status.resolvedPath!)
      const child = spawn(status.resolvedPath!, args, {
        windowsHide: false, // 显示窗口，让用户看到登录进度
        shell: useShell,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (buf: Buffer) => {
        stdout += buf.toString('utf8')
      })
      child.stderr?.on('data', (buf: Buffer) => {
        stderr += buf.toString('utf8')
      })
      child.on('error', (err) => {
        reject(err)
      })
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, message: '登录成功' })
        } else {
          const err = stderr || stdout || `退出码 ${code}`
          resolve({ success: false, message: `登录失败：${err.slice(0, 300)}` })
        }
      })
    })
  })

  ipcMain.handle('app:setCodingDevAcpWorkspace', async (_event, dirPath: string | undefined) => {
    if (!getConfigManager()) {
      throw new Error('ConfigManager 未初始化')
    }
    const trimmed = typeof dirPath === 'string' ? dirPath.trim() : ''
    if (trimmed) {
      try {
        const stat = await fs.stat(trimmed)
        if (!stat.isDirectory()) {
          throw new Error('指定路径不是目录')
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('目录不存在', { cause: err })
        }
        throw err
      }
    }
    await getConfigManager()!.updateAppConfig({
      codingDevAcpWorkspace: trimmed || undefined,
    })
    reapplyCodingDevAcpEnv()
  })

  // === ACP 项目管理 ===
  ipcMain.handle('app:listCodingDevProjects', async () => {
    if (!getConfigManager() || !directoryManager) throw new Error('未初始化')
    const cfg = getConfigManager()!.getAppConfig()
    const projectsDir = join(getActiveWorkspaceDir(), 'projects')
    const reconciled = await reconcileProjectsWithDisk({
      projectsDir,
      existing: cfg.codingDevProjects ?? [],
      activeProject: cfg.codingDevActiveProject,
    })
    if (reconciled.changed) {
      await getConfigManager()!.updateAppConfig({
        codingDevProjects: reconciled.projects,
        codingDevActiveProject: reconciled.activeProject,
      })
      reapplyCodingDevAcpEnv()
    }
    return {
      projects: reconciled.projects,
      activeProject: reconciled.activeProject,
    }
  })

  ipcMain.handle('app:createCodingDevProject', async (_event, name: string) => {
    if (!getConfigManager() || !directoryManager) throw new Error('未初始化')
    const projectsDir = join(getActiveWorkspaceDir(), 'projects')
    const existing = getConfigManager()!.getAppConfig().codingDevProjects ?? []
    const projects = await createProject({ projectsDir, name: String(name ?? ''), existing })
    const activeProject = projects[projects.length - 1]?.name
    await getConfigManager()!.updateAppConfig({ codingDevProjects: projects, codingDevActiveProject: activeProject })
    reapplyCodingDevAcpEnv()
    return { projects, activeProject }
  })

  ipcMain.handle('app:openCodingDevProject', async (_event, name: string, targetPath: string) => {
    if (!getConfigManager() || !directoryManager) throw new Error('未初始化')
    const projectsDir = join(getActiveWorkspaceDir(), 'projects')
    const existing = getConfigManager()!.getAppConfig().codingDevProjects ?? []
    const projects = await openExistingProject({
      projectsDir,
      name: String(name ?? ''),
      targetPath: String(targetPath ?? ''),
      existing,
    })
    const activeProject = projects[projects.length - 1]?.name
    await getConfigManager()!.updateAppConfig({ codingDevProjects: projects, codingDevActiveProject: activeProject })
    reapplyCodingDevAcpEnv()
    return { projects, activeProject }
  })

  ipcMain.handle('app:removeCodingDevProject', async (_event, name: string) => {
    if (!getConfigManager() || !directoryManager) throw new Error('未初始化')
    const projectsDir = join(getActiveWorkspaceDir(), 'projects')
    const cfg = getConfigManager()!.getAppConfig()
    const existing = cfg.codingDevProjects ?? []
    const projects = await removeProject({ projectsDir, name: String(name ?? ''), existing })
    // 若移除的是活动项目，活动项目回退到列表首个（或清空）
    const activeProject =
      cfg.codingDevActiveProject && projects.some((p) => p.name === cfg.codingDevActiveProject)
        ? cfg.codingDevActiveProject
        : projects[0]?.name
    await getConfigManager()!.updateAppConfig({ codingDevProjects: projects, codingDevActiveProject: activeProject })
    reapplyCodingDevAcpEnv()
    return { projects, activeProject }
  })

  ipcMain.handle('app:setCodingDevActiveProject', async (_event, name: string) => {
    if (!getConfigManager()) throw new Error('ConfigManager 未初始化')
    const trimmed = typeof name === 'string' ? name.trim() : ''
    const projects = getConfigManager()!.getAppConfig().codingDevProjects ?? []
    if (trimmed && !projects.some((p) => p.name === trimmed)) {
      throw new Error(`项目「${trimmed}」不存在`)
    }
    await getConfigManager()!.updateAppConfig({ codingDevActiveProject: trimmed || undefined })
    reapplyCodingDevAcpEnv()
    return { projects, activeProject: trimmed || undefined }
  })

  ipcMain.handle('app:getProjectGitStatus', async (_event, projectName: string) => {
    if (!getConfigManager()) throw new Error('ConfigManager 未初始化')
    const projects = getConfigManager()!.getAppConfig().codingDevProjects ?? []
    const project = projects.find((p) => p.name === projectName)
    if (!project) return { available: false, isRepo: false, files: [] }
    return getProjectGitStatus(project.realPath)
  })

  // === 应用操作 ===
}
