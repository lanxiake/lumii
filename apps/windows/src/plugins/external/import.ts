/**
 * 手动导入插件：压缩包（.zip）或文件夹。
 *
 * 目标目录由内容决定（不是让用户选）：
 * - 有 `main.js` → `~/.lumii/extensions/<目录>/`（主进程扩展；带 `client.js` 时两半边一起）
 * - 只有 `client.js` → `~/.lumii/plugins/<目录>/`（纯渲染层插件）
 *
 * 规则：
 * - 压缩包里常见的「外面套一层目录」自动剥掉；
 * - 必须含 `main.js` 或 `client.js`，否则拒绝（避免把随便一个 zip 倒进插件目录）；
 * - 目录名优先取 `plugin.json` 的 `id`，没有则用源目录名，统一净化成安全文件名；
 * - **版本校验**：同名插件已存在时比较两个 `plugin.json.version`——只有**更高版本**才允许
 *   覆盖（升级），同版本或降级一律拒绝；版本号必须写成 `x.y.z[-tag]`；
 * - 升级时先把旧目录挪到插件根之外的 `.plugin-backup/`，失败原样还原，成功后删除备份。
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dialog } from 'electron'

import { extractZip } from '../install/zip'
import { resolveClientPluginsDir, resolveExtensionsDir } from './paths'

export type ImportSourceKind = 'zip' | 'folder'

export interface ImportUpgradeInfo {
  from: string
  to: string
}

export type ImportPluginResult =
  | {
      ok: true
      dir: string
      id: string
      kind: 'main' | 'client' | 'both'
      /** 同名插件版本更高时走升级，这里带旧/新版本 */
      upgraded?: ImportUpgradeInfo
    }
  | { ok: false; error: string; cancelled?: boolean }

export interface ImportRoots {
  extensions: string
  plugins: string
}

interface DeclaredMeta {
  id?: string
  version?: string
}

function defaultRoots(): ImportRoots {
  return { extensions: resolveExtensionsDir(), plugins: resolveClientPluginsDir() }
}

/** 目录名净化：只留字母数字与 `._-`，其余换成 `-`；空则回退 */
function sanitizeDirName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || `plugin-${Date.now()}`
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * 找到真正的插件根：很多压缩包把内容放在一层同名目录里。
 * 最多向下剥 3 层，避免把嵌套很深的项目误当插件。
 */
async function findPluginRoot(dir: string, depth = 0): Promise<string | null> {
  if (!(await isFile(path.join(dir, 'main.js'))) && !(await isFile(path.join(dir, 'client.js')))) {
    if (depth >= 3) return null
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return null
    }
    const dirs = entries.filter((e) => !e.startsWith('.') && e !== '__MACOSX')
    if (dirs.length !== 1) return null
    const child = path.join(dir, dirs[0])
    try {
      if (!(await stat(child)).isDirectory()) return null
    } catch {
      return null
    }
    return findPluginRoot(child, depth + 1)
  }
  return dir
}

/** 读 plugin.json 的 id/version；文件不存在返回空对象，格式坏则抛错 */
async function readDeclaredMeta(root: string): Promise<DeclaredMeta> {
  const file = path.join(root, 'plugin.json')
  if (!(await pathExists(file))) return {}
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    throw new Error(`plugin.json 不是合法 JSON：${(err as Error).message}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error('plugin.json 必须是对象')
  const obj = raw as Record<string, unknown>
  return {
    ...(typeof obj.id === 'string' && obj.id.trim() ? { id: obj.id.trim() } : {}),
    ...(typeof obj.version === 'string' && obj.version.trim()
      ? { version: obj.version.trim() }
      : {}),
  }
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/** 校验版本号格式；空值返回 null（未声明） */
export function normalizeVersion(value: string | undefined): string | null {
  if (!value) return null
  const v = value.trim()
  if (!VERSION_RE.test(v)) {
    throw new Error(`版本号格式不合法：「${v}」，应为 x.y.z 或 x.y.z-tag`)
  }
  return v
}

/** 比较 x.y.z[-tag]；返回值 >0 表示 a 更新 */
export function compareVersions(a: string, b: string): number {
  const core = (v: string) => v.split(/[-+]/, 1)[0]!.split('.').map((n) => Number(n) || 0)
  const [aCore, bCore] = [core(a), core(b)]
  for (let i = 0; i < 3; i++) {
    const diff = (aCore[i] ?? 0) - (bCore[i] ?? 0)
    if (diff !== 0) return diff
  }
  // 正式版 > 预发布版；同为预发布时按字符串比较（够用且稳定）
  const aPre = /[-+]/.test(a)
  const bPre = /[-+]/.test(b)
  if (aPre !== bPre) return aPre ? -1 : 1
  return a.localeCompare(b)
}

/**
 * 从一个本地路径导入（zip 文件或目录）。UI 走 `importPluginFromDialog`，
 * 这里保持纯函数形态便于单测。
 */
export async function importPluginFrom(
  sourcePath: string,
  kind: ImportSourceKind,
  roots: ImportRoots = defaultRoots(),
): Promise<ImportPluginResult> {
  let staging: string | null = null
  try {
    const srcStat = await stat(sourcePath).catch(() => null)
    if (!srcStat) return { ok: false, error: '路径不存在' }

    if (kind === 'zip') {
      if (!srcStat.isFile()) return { ok: false, error: '请选择一个 .zip 文件' }
      staging = await mkdtemp(path.join(tmpdir(), 'lumii-plugin-zip-'))
      await extractZip(sourcePath, staging)
    } else if (!srcStat.isDirectory()) {
      return { ok: false, error: '请选择一个插件文件夹' }
    }

    const searchRoot = staging ?? sourcePath
    const root = await findPluginRoot(searchRoot)
    if (!root) {
      return { ok: false, error: '没有找到 main.js 或 client.js，不是有效的插件' }
    }

    const hasMain = await isFile(path.join(root, 'main.js'))
    const hasClient = await isFile(path.join(root, 'client.js'))
    const pluginKind: 'main' | 'client' | 'both' =
      hasMain && hasClient ? 'both' : hasMain ? 'main' : 'client'

    const meta = await readDeclaredMeta(root)
    const incomingVersion = normalizeVersion(meta.version)

    // 没有 plugin.json 时用「压缩包内插件目录名」；若内容就在包根，则用压缩包文件名
    const relativeRoot = path.relative(searchRoot, root)
    const fallbackName = relativeRoot
      ? path.basename(root)
      : kind === 'zip'
        ? path.basename(sourcePath, path.extname(sourcePath))
        : path.basename(sourcePath)
    const dirName = sanitizeDirName(meta.id ?? fallbackName)
    const targetRoot = hasMain ? roots.extensions : roots.plugins
    const target = path.join(targetRoot, dirName)

    const copyOptions = {
      recursive: true,
      force: false,
      filter: (src: string) => {
        const name = path.basename(src)
        return name !== 'node_modules' && name !== '.git'
      },
    }

    if (await pathExists(target)) {
      // 升级：版本必须两边都有，且新版本更高
      const installed = await readDeclaredMeta(target).catch(() => ({} as DeclaredMeta))
      const installedVersion = normalizeVersion(installed.version)
      if (!installedVersion || !incomingVersion) {
        return {
          ok: false,
          error: `同名插件已存在（${dirName}），但缺少可比较的 plugin.json.version，无法判断升级。请先在插件列表里删除旧版本`,
        }
      }
      if (compareVersions(incomingVersion, installedVersion) <= 0) {
        return {
          ok: false,
          error: `已安装 ${installedVersion}，导入版本 ${incomingVersion} 不高于已安装版本，已拒绝`,
        }
      }

      // 备份放在插件根**之外**：留在根内会被扫描器当成另一个插件
      const backupRoot = path.join(path.dirname(targetRoot), '.plugin-backup')
      const backup = path.join(backupRoot, `${dirName}-${Date.now()}`)
      await mkdir(backupRoot, { recursive: true })
      await rename(target, backup)
      try {
        await cp(root, target, copyOptions)
        await rm(backup, { recursive: true, force: true }).catch(() => undefined)
      } catch (err) {
        // 失败还原旧版本：宁可升级没发生，也不要留一个半新半旧的目录
        await rm(target, { recursive: true, force: true }).catch(() => undefined)
        await rename(backup, target).catch(() => undefined)
        throw err
      }
      return {
        ok: true,
        dir: target,
        id: dirName,
        kind: pluginKind,
        upgraded: { from: installedVersion, to: incomingVersion },
      }
    }

    await mkdir(targetRoot, { recursive: true })
    // 只拷贝插件本身：压缩包已解到独立 staging；文件夹导入时排除 .git/node_modules
    await cp(root, target, copyOptions)

    return { ok: true, dir: target, id: dirName, kind: pluginKind }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) }
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 弹系统对话框选择来源，然后导入 */
export async function importPluginFromDialog(
  kind: ImportSourceKind,
  roots?: ImportRoots,
): Promise<ImportPluginResult> {
  const picked =
    kind === 'zip'
      ? await dialog.showOpenDialog({
          title: '选择插件压缩包',
          properties: ['openFile'],
          filters: [{ name: '插件压缩包', extensions: ['zip'] }],
        })
      : await dialog.showOpenDialog({
          title: '选择插件文件夹',
          properties: ['openDirectory'],
        })

  if (picked.canceled || picked.filePaths.length === 0) {
    return { ok: false, error: '已取消', cancelled: true }
  }
  return importPluginFrom(picked.filePaths[0]!, kind, roots)
}
