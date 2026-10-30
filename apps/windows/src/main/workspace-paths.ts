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
const WORKSPACE_TEMP_DIRNAME = 'temp'

/** 截图临时子目录（相对 workspace/temp） */
const SCREENSHOTS_TEMP_DIRNAME = 'screenshots'

/**
 * getter 挂在 `globalThis`：云同步是官方外部扩展，bundle 里有本模块的第二份拷贝。
 * 模块级变量会让它永远读不到主进程注入的 getter，静默回落到默认工作空间
 * （同步到错目录，且不报错）。用全局槽位后两份代码读写同一个 getter。
 */
const WORKSPACE_GETTER_KEY = Symbol.for('lumii.workspace-paths.active-workspace-getter')

function sharedGetter(): { get: (() => string) | null } {
  const g = globalThis as Record<symbol, unknown>
  return (g[WORKSPACE_GETTER_KEY] ??= { get: null }) as { get: (() => string) | null }
}

/**
 * 注入当前生效工作空间根目录获取器（config 就绪后设置）。
 * 未注入时回退到 `{dataRoot}/workspace`。
 */
export function setActiveWorkspaceDirGetter(getter: () => string): void {
  sharedGetter().get = getter
}

/**
 * 测试用：清空 getter。
 */
export function _resetActiveWorkspaceDirGetterForTest(): void {
  sharedGetter().get = null
}

/**
 * 解析当前生效的工作空间根目录。
 */
export function resolveActiveWorkspaceDir(): string {
  const fromGetter = sharedGetter().get?.()?.trim()
  if (fromGetter) {
    return path.resolve(fromGetter)
  }
  return path.join(resolveWindowsClientDataRoot(), 'workspace')
}

/**
 * 确保目录存在（已存在则 no-op）。
 */
function ensureDirExists(dirPath: string): string {
  const resolved = path.resolve(dirPath)
  try {
    accessSync(resolved)
  } catch {
    mkdirSync(resolved, { recursive: true })
  }
  return resolved
}

/** 工作空间下 Wiki 资料库根目录名 */
const WORKSPACE_WIKI_DIRNAME = 'wiki'

/**
 * `{workspace}/wiki` — Wiki 资料库物理目录（ref 侧车与 native md）。
 */
export function resolveWikiDir(workspaceRoot?: string): string {
  const root = path.resolve(workspaceRoot ?? resolveActiveWorkspaceDir())
  return ensureDirExists(path.join(root, WORKSPACE_WIKI_DIRNAME))
}

/**
 * `{workspace}/temp` — 被删后调用即重建。
 */
export function resolveWorkspaceTempDir(): string {
  return ensureDirExists(path.join(resolveActiveWorkspaceDir(), WORKSPACE_TEMP_DIRNAME))
}

/** 工作空间下确定性流水线根目录名 */
const WORKSPACE_PIPELINES_DIRNAME = 'pipelines'

/**
 * `{workspace}/pipelines` — 确定性流水线的 spec 与 run 记录（与 `resolveWikiDir` 同形）。
 * spec 随 git + 云同步；`<id>/runs/` 走 vcs-ignore（见 Task 8 的迁移）。
 */
export function resolvePipelinesDir(workspaceRoot?: string): string {
  const root = path.resolve(workspaceRoot ?? resolveActiveWorkspaceDir())
  return ensureDirExists(path.join(root, WORKSPACE_PIPELINES_DIRNAME))
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
