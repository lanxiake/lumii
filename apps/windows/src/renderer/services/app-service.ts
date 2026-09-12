/**
 * 应用服务 — 封装宿主级能力（app 域文件定位 / 拖拽路径 + 桌面通知）
 */
import type { ProjectGitStatus } from '@main/project-git/types'

/** 在系统文件管理器中定位文件 */
export async function showItemInFolder(filePath: string): Promise<void> {
  await window.electronAPI.app.showItemInFolder(filePath)
}

/** 取拖拽 File 对象的本地真实路径（Electron webUtils） */
export function getPathForFile(file: File): string {
  return window.electronAPI.app.getPathForFile(file)
}

/** 用系统默认浏览器打开外链；失败抛出（如默认浏览器关联失效），由调用方决定降级 */
export async function openExternal(url: string): Promise<void> {
  await window.electronAPI.app.openExternal(url)
}

/** 只读获取挂载项目的 Git 状态（分支 / ahead-behind / 远端 / 文件状态） */
export async function getProjectGitStatus(projectName: string): Promise<ProjectGitStatus> {
  return window.electronAPI.app.getProjectGitStatus(projectName)
}

/** 桌面通知（主进程 Notification + 托盘 + 任务栏闪烁）；接口不可用或失败时静默 */
export function notifyDesktop(title: string, body: string): void {
  void window.electronAPI?.notifyDesktop?.(title, body)?.catch(() => {})
}

/** 获取应用版本 */
export async function getAppVersion(): Promise<string> {
  return window.electronAPI.app.getVersion()
}

/** 读取开机自启状态 */
export async function getOpenAtLogin(): Promise<boolean> {
  return window.electronAPI.app.getOpenAtLogin()
}

/** 设置开机自启；返回实际生效状态 */
export async function setOpenAtLogin(enable: boolean): Promise<boolean> {
  return window.electronAPI.app.setOpenAtLogin(enable)
}

/** 在资源管理器中打开当前应用日志文件 */
export async function openLogFile(): Promise<{ success: boolean; path?: string; error?: string }> {
  return window.electronAPI.app.openLogFile()
}
