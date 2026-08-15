/**
 * 工作空间相关路径解析。
 * 录屏 / 截图等临时产物落在「用户设置的工作空间目录」下的 temp/，
 * 与 projects 同级；缺失时自动 mkdir。
 */
import { accessSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { RECORDINGS_DIRNAME } from '../shared/screen-record'
import { resolveWindowsClientDataRoot } from './client-data-root'

/** 工作空间下临时根目录名 */
export const WORKSPACE_TEMP_DIRNAME = 'temp'

/** 截图临时子目录（相对 workspace/temp） */
export const SCREENSHOTS_TEMP_DIRNAME = 'screenshots'

let activeWorkspaceDirGetter: (() => string) | null = null

/**
 * 注入当前生效工作空间根目录获取器（config 就绪后设置）。
 * 未注入时回退到 `{dataRoot}/workspace`。
 */
export function setActiveWorkspaceDirGetter(getter: () => string): void {
  activeWorkspaceDirGetter = getter
}

/**
 * 测试用：清空 getter。
 */
export function _resetActiveWorkspaceDirGetterForTest(): void {
  activeWorkspaceDirGetter = null
}

/**
 * 解析当前生效的工作空间根目录。
 */
export function resolveActiveWorkspaceDir(): string {
  const fromGetter = activeWorkspaceDirGetter?.()?.trim()
  if (fromGetter) {
    return path.resolve(fromGetter)
  }
  return path.join(resolveWindowsClientDataRoot(), 'workspace')
}

/**
 * 确保目录存在（已存在则 no-op）。
 */
export function ensureDirExists(dirPath: string): string {
  const resolved = path.resolve(dirPath)
  try {
    accessSync(resolved)
  } catch {
    mkdirSync(resolved, { recursive: true })
  }
  return resolved
}

/**
 * `{workspace}/temp` — 被删后调用即重建。
 */
export function resolveWorkspaceTempDir(): string {
  return ensureDirExists(path.join(resolveActiveWorkspaceDir(), WORKSPACE_TEMP_DIRNAME))
}

/**
 * `{workspace}/temp/recordings` — 录屏成片与旁白临时文件。
 */
export function resolveRecordingsDir(): string {
  return ensureDirExists(path.join(resolveWorkspaceTempDir(), RECORDINGS_DIRNAME))
}

/**
 * `{workspace}/temp/screenshots` — app_screenshot 等临时图。
 */
export function resolveScreenshotTempDir(): string {
  return ensureDirExists(path.join(resolveWorkspaceTempDir(), SCREENSHOTS_TEMP_DIRNAME))
}

/**
 * 确保工作空间下 temp 布局齐全（temp / recordings / screenshots）。
 * @param workspaceRoot 可选；默认当前生效工作空间
 */
export function ensureWorkspaceTempLayout(workspaceRoot?: string): void {
  const root = path.resolve(workspaceRoot ?? resolveActiveWorkspaceDir())
  ensureDirExists(path.join(root, WORKSPACE_TEMP_DIRNAME))
  ensureDirExists(path.join(root, WORKSPACE_TEMP_DIRNAME, RECORDINGS_DIRNAME))
  ensureDirExists(path.join(root, WORKSPACE_TEMP_DIRNAME, SCREENSHOTS_TEMP_DIRNAME))
}
