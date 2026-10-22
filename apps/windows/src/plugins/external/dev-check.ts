import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

import { parseClientPluginMeta, type ClientPluginMeta } from '../../main/client-plugin-meta'

/**
 * `plugin_dev check` 的静态体检。
 *
 * 只做**文件层面能确定的事**：形状、语法、注册契约、槽位名、明显违反规范的写法。
 * 真正的运行时结果（槽位撞 id、apply 抛错）以宿主状态为准，由工具层附在结果里——
 * 静态检查假装能覆盖运行时，比不检查更糟。
 */

export const KNOWN_SLOTS = [
  'dashboard.main',
  'dashboard.grid',
  'dashboard.plugins',
  'app.nav',
  'app.view',
  'settings.section',
] as const

export type PluginKind = 'client' | 'main'

export interface PluginIssue {
  code: string
  message: string
}

export interface PluginCheckInput {
  kind: PluginKind
  /** 插件目录名（= 写盘时用的名字；客户端插件的 id 可被 plugin.json 覆盖） */
  id: string
  clientRoot: string
  mainRoot: string
  /** 宿主版本；给了才校验 client 的 engines.lumii */
  appVersion?: string
}

export interface PluginCheckResult {
  ok: boolean
  kind: PluginKind
  dir: string
  errors: PluginIssue[]
  warnings: PluginIssue[]
  /** 从 plugin.json 读到的元数据（客户端） */
  meta?: ClientPluginMeta
}

function issue(code: string, message: string): PluginIssue {
  return { code, message }
}

/** id 会直接拼进路径：拒绝分隔符与 `..`，避免体检跑到插件目录外面。 */
function safeDir(root: string, id: string): string | null {
  if (!id || id === '.' || id === '..') return null
  if (id.includes('/') || id.includes('\\')) return null
  const dir = path.join(root, id)
  const resolvedRoot = path.resolve(root)
  const resolvedDir = path.resolve(dir)
  if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + path.sep)) return null
  return dir
}

/** 扫描同目录下其它插件，找出重复 id（复制目录忘改 id 是最常见的配置错误）。 */
function duplicateIds(root: string, selfDirName: string, selfId: string): string[] {
  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return []
  }
  const hits: string[] = []
  for (const dirName of dirs) {
    if (dirName === selfDirName) continue
    const dir = path.join(root, dirName)
    try {
      if (!statSync(dir).isDirectory()) continue
      if (!existsSync(path.join(dir, 'client.js'))) continue
    } catch {
      continue
    }
    const meta = parseClientPluginMeta(dir, dirName)
    if (meta.id === selfId) hits.push(dirName)
  }
  return hits
}

function checkClient(input: PluginCheckInput, dir: string, errors: PluginIssue[], warnings: PluginIssue[]): PluginCheckResult['meta'] {
  const entry = path.join(dir, 'client.js')
  if (!existsSync(entry)) {
    errors.push(issue('entry_missing', '缺少 client.js'))
    return undefined
  }

  const meta = parseClientPluginMeta(dir, input.id, { appVersion: input.appVersion })
  if (meta.manifestError) errors.push(issue('manifest', meta.manifestError))
  if (meta.incompatibleReason) errors.push(issue('incompatible', meta.incompatibleReason))

  const id = meta.id
  if (meta.id !== input.id) {
    // 不是错误（目录名只用于定位文件），但会让「改哪个 id」变得不直观
    warnings.push(issue('id_differs_from_dir', `plugin.json 的 id（${meta.id}）与目录名（${input.id}）不同`))
  }
  for (const other of duplicateIds(path.dirname(dir), input.id, id)) {
    errors.push(issue('duplicate_id', `id "${id}" 同时出现在 ${other}/，只会加载一个；请改掉其中一个 id`))
  }

  const source = readFileSync(entry, 'utf8')

  try {
    // 经典脚本：插件是 <script> 注入的，不经过打包
    new vm.Script(source, { filename: entry })
  } catch (err) {
    errors.push(issue('syntax', `client.js 语法错误：${(err as Error).message}`))
  }

  if (/(^|\n)\s*import\s+[\s\S]*?from\s*['"]/.test(source) || /\bimport\s*\(/.test(source)) {
    errors.push(issue('esm_import', '插件以经典脚本执行，不能使用 import；需要依赖时用 api 里提供的模块'))
  }
  if (/\brequire\s*\(/.test(source)) {
    errors.push(issue('require', '插件没有 CommonJS 运行时，不能使用 require'))
  }

  const calls = [...source.matchAll(/__LUMII_REGISTER_PLUGIN__\s*\(/g)]
  if (calls.length === 0) {
    errors.push(issue('no_register', '没有调用 __LUMII_REGISTER_PLUGIN__（插件不会生效）'))
  } else if (calls.length > 1) {
    errors.push(issue('multi_register', `调用了 ${calls.length} 次 __LUMII_REGISTER_PLUGIN__；一个插件只能注册一次，后面的调用不会执行`))
  } else {
    const registered = source.match(/__LUMII_REGISTER_PLUGIN__\s*\(\s*(['"`])([^'"`]+)\1/)?.[2]
    if (!registered) {
      errors.push(issue('register_id', '注册调用的第一个参数必须是插件 id 字符串字面量'))
    } else if (registered !== id) {
      errors.push(issue('register_id_mismatch', `注册 id（${registered}）与插件 id（${id}）不一致`))
    }
  }

  for (const match of source.matchAll(/registerSlot\s*\(\s*(['"`])([^'"`]+)\1/g)) {
    const slot = match[2]!
    if (!(KNOWN_SLOTS as readonly string[]).includes(slot)) {
      errors.push(issue('unknown_slot', `未知槽位 "${slot}"；可用槽位见 plugin_dev guide`))
      continue
    }
    // 条目 id 的约定是「插件 id 前缀」；这里只看注册调用之后的一小段，宁可漏报不误报
    const window = source.slice(match.index ?? 0, (match.index ?? 0) + 600)
    const entryId = window.match(/id\s*:\s*(['"`])([^'"`]+)\1/)?.[2]
    if (entryId && !entryId.startsWith(`${id}.`)) {
      warnings.push(issue('slot_prefix', `槽位 "${slot}" 的条目 id "${entryId}" 没有以 "${id}." 开头，可能和别的插件相撞`))
    }
  }

  if (/#[0-9a-fA-F]{3,8}\b/.test(source)) {
    warnings.push(issue('hardcoded_color', '出现十六进制颜色；请用设计令牌 var(--color-*)，否则主题切换不跟随'))
  }

  return meta
}

function checkMain(input: PluginCheckInput, dir: string, errors: PluginIssue[], warnings: PluginIssue[]): void {
  const entry = path.join(dir, 'main.js')
  if (!existsSync(entry)) {
    errors.push(issue('entry_missing', '缺少 main.js'))
    return
  }
  const source = readFileSync(entry, 'utf8')
  if (!/export\s+default\s*\{/.test(source) && !/export\s+const\s+(manifest|definition)\b/.test(source)) {
    errors.push(issue('main_exports', 'main.js 既没有 `export default {...}`，也没有具名的 manifest/definition 导出'))
  }
  if (/#[0-9a-fA-F]{3,8}\b/.test(source)) {
    warnings.push(issue('hardcoded_color', '出现十六进制颜色；界面请用设计令牌（见 plugin_dev guide）'))
  }
  // ESM 语法无法在 vm.Script 里编译；语法错误由加载器在 ≤1 秒内给出运行时错误，
  // 工具层会把 ExternalExtensionRuntime.inspect() 的 error 一并返回。
}

/**
 * 体检一个插件目录。`ok=false` 表示有 error；只有 warning 时仍为 ok。
 */
export function checkPlugin(input: PluginCheckInput): PluginCheckResult {
  const errors: PluginIssue[] = []
  const warnings: PluginIssue[] = []
  const root = input.kind === 'client' ? input.clientRoot : input.mainRoot
  const dir = safeDir(root, input.id)

  if (!dir) {
    return {
      ok: false,
      kind: input.kind,
      dir: '',
      errors: [issue('bad_id', `非法的插件名：${input.id}`)],
      warnings,
    }
  }
  if (!existsSync(dir)) {
    return {
      ok: false,
      kind: input.kind,
      dir,
      errors: [issue('dir_missing', `目录不存在：${dir}`)],
      warnings,
    }
  }

  let meta: PluginCheckResult['meta']
  if (input.kind === 'client') {
    meta = checkClient(input, dir, errors, warnings)
  } else {
    checkMain(input, dir, errors, warnings)
  }

  return {
    ok: errors.length === 0,
    kind: input.kind,
    dir,
    errors,
    warnings,
    ...(meta ? { meta } : {}),
  }
}
