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
 * - **不覆盖**已有目录：那是用户可能在改的代码，宁可让用户先删。
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dialog } from 'electron'

import { extractZip } from '../install/zip'
import { resolveClientPluginsDir, resolveExtensionsDir } from './paths'

export type ImportSourceKind = 'zip' | 'folder'

export type ImportPluginResult =
  | { ok: true; dir: string; id: string; kind: 'main' | 'client' | 'both' }
  | { ok: false; error: string; cancelled?: boolean }

export interface ImportRoots {
  extensions: string
  plugins: string
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

async function readDeclaredId(root: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8')) as {
      id?: unknown
    }
    return typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null
  } catch {
    return null
  }
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

    // 没有 plugin.json 时用「压缩包内插件目录名」；若内容就在包根，则用压缩包文件名
    const relativeRoot = path.relative(searchRoot, root)
    const fallbackName = relativeRoot
      ? path.basename(root)
      : kind === 'zip'
        ? path.basename(sourcePath, path.extname(sourcePath))
        : path.basename(sourcePath)
    const dirName = sanitizeDirName((await readDeclaredId(root)) ?? fallbackName)
    const targetRoot = hasMain ? roots.extensions : roots.plugins
    const target = path.join(targetRoot, dirName)

    const exists = await stat(target)
      .then(() => true)
      .catch(() => false)
    if (exists) {
      return {
        ok: false,
        error: `同名插件目录已存在：${dirName}。请先在插件列表里删除或改名后再导入`,
      }
    }

    await mkdir(targetRoot, { recursive: true })
    // 只拷贝插件本身：压缩包已解到独立 staging；文件夹导入时排除 .git/node_modules
    await cp(root, target, {
      recursive: true,
      force: false,
      filter: (src) => {
        const name = path.basename(src)
        return name !== 'node_modules' && name !== '.git'
      },
    })

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
