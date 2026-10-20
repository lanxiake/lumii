import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  validateManifest,
  type LumiiPluginManifest,
  type PluginDefinition,
  type PluginHost,
} from '@mtbot/plugin-core'

import type { MainEvents } from './kernel/events'
import { resolveClientStateDir } from './paths'

/**
 * 外部扩展：`~/.lumii/extensions/<目录>/main.js`
 *
 * 与内置扩展的区别只有一处——**代码在 bundle 之外**，所以改完能亚秒级重载；
 * 内置扩展被打进主进程单文件，改动只能靠 electron-vite 重启主进程（数秒）。
 *
 * 模块契约（与内置同形状）：
 *
 * ```js
 * export default {
 *   manifest: { id: 'com.example.foo', name: '…', version: '0.1.0',
 *               engines: { lumii: '>=0.1.0' }, kind: 'code' },
 *   definition: { id: 'com.example.foo', apply(ctx) { … } },
 * }
 * ```
 *
 * 注意：不做沙箱。扩展与主进程同权限——自用客户端的选择，见决策记录 D1/D2。
 */

export interface ExternalExtensionModule {
  manifest: LumiiPluginManifest
  definition: PluginDefinition<MainEvents>
}

export interface ExternalExtensionEntry {
  dir: string
  entryFile: string
  /** 上次加载时的 mtime+size，用于判断是否真的变了 */
  revision: string
  manifestId: string
  name: string
  version: string
  /** 上一版定义：新版本激活失败时用来回滚，以及被禁用后仍能列举 */
  definition?: PluginDefinition<MainEvents>
  /** 是否已挂到宿主上（被禁用或导入失败时为 false） */
  enabled: boolean
  /** 本次加载的错误（导入失败 / 激活失败）；旧版本仍在服务时也会带着它 */
  error?: string
}

/** 给 UI 的外部扩展快照：配置上的开关 + 宿主里的真实状态 */
export interface ExternalExtensionInfo {
  dir: string
  id: string
  name: string
  version: string
  enabled: boolean
  state: string
  activationMs?: number
  error?: string
}

const ENTRY_FILE = 'main.js'

/**
 * 轮询间隔。
 *
 * 为什么不用 `fs.watch`：本机实测**收不到**子文件改动事件（`fs.watch(扩展根目录)` 在
 * 一次 `appendFileSync` 后 3 秒内零事件，persistent 开关无关）。目录监听在这个
 * 路径（~/.lumii 下）不可靠，而扩展数量是个位数，每秒 stat 一次的代价可以忽略。
 *
 * ponytail: 1s 轮询 + 每次全量 stat。扩展到几十个且需要毫秒级时，换成
 * 每目录 fs.watch（并回退到轮询）—— 现在不值得。
 */
const POLL_INTERVAL_MS = 1000

export function resolveExtensionsDir(): string {
  return path.join(resolveClientStateDir(), 'extensions')
}

/**
 * 扫出所有含 main.js 的子目录。目录不存在时返回空数组（不是错误）。
 *
 * 根目录可注入：测试用临时目录，不碰真实 `~/.lumii`。
 */
export function discoverExternalExtensions(
  root: string = resolveExtensionsDir(),
): Array<{ dir: string; entryFile: string }> {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }

  const found: Array<{ dir: string; entryFile: string }> = []
  for (const name of entries) {
    const dir = path.join(root, name)
    const entryFile = path.join(dir, ENTRY_FILE)
    try {
      if (!statSync(dir).isDirectory()) continue
      statSync(entryFile)
    } catch {
      continue
    }
    found.push({ dir, entryFile })
  }
  return found
}

/**
 * 把未知模块收窄成 `ExternalExtensionModule`。
 *
 * 外部模块是运行时读进来的任意 JS，类型系统在这里没有任何保证——所以先做结构校验
 * 再收窄，而不是 `as never` 把一切都放过。校验失败抛错，由调用方决定「保留旧版本」。
 */
export function parseExternalModule(namespace: unknown, appVersion?: string): ExternalExtensionModule {
  if (typeof namespace !== 'object' || namespace === null) {
    throw new Error('模块不是对象')
  }

  // 约定 `export default {...}`；也容忍具名导出（export const manifest / definition）
  const candidate = (namespace as { default?: unknown }).default ?? namespace
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('默认导出不是对象')
  }

  const rawManifest = (candidate as { manifest?: unknown }).manifest
  const rawDefinition = (candidate as { definition?: unknown }).definition
  if (rawDefinition === undefined) throw new Error('缺少 definition')
  if (typeof (rawDefinition as { apply?: unknown }).apply !== 'function') {
    throw new Error('definition.apply 必须是函数')
  }

  const manifest = validateManifest(rawManifest, { appVersion })
  const definition = rawDefinition as PluginDefinition<MainEvents>

  if (definition.id !== manifest.id) {
    throw new Error(`definition.id(${definition.id}) 与 manifest.id(${manifest.id}) 不一致`)
  }

  return { manifest, definition }
}

function revisionOf(file: string): string {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}-${stat.size}`
  } catch {
    return 'missing'
  }
}

/**
 * 外部扩展的加载与热重载。
 *
 * 用「整目录重扫 + 按 revision 跳过未变的」而不是逐目录 fs.watch：
 * 扩展数量是个位数，重扫成本可忽略，少一层「哪个 watcher 该跟哪个目录」的状态。
 */
export class ExternalExtensionRuntime {
  private readonly loaded = new Map<string, ExternalExtensionEntry>()
  private pollTimer: NodeJS.Timeout | null = null
  private rescanning = false

  constructor(
    private readonly host: PluginHost<MainEvents>,
    private readonly log: {
      info(m: string): void
      warn(m: string): void
      error(m: string, e?: unknown): void
    },
    options: { root?: string; appVersion?: string; disabledIds?: ReadonlySet<string> } = {},
  ) {
    this.root = options.root ?? resolveExtensionsDir()
    this.appVersion = options.appVersion
    this.disabledIds = options.disabledIds ?? new Set()
  }

  private readonly root: string
  private readonly appVersion?: string
  /** 启动时从 extensions.json 读到的禁用项；运行时不变（开关重启后生效） */
  private readonly disabledIds: ReadonlySet<string>

  /** 当前已知的外部扩展（含被禁用的与导入失败的）。UI 的列表用它。 */
  inspect(): ExternalExtensionInfo[] {
    return [...this.loaded.values()].map((entry) => {
      const live = this.host.get(entry.manifestId)
      return {
        dir: entry.dir,
        id: entry.manifestId,
        name: entry.name,
        version: entry.version,
        enabled: entry.enabled,
        state: entry.enabled ? (live?.state ?? 'unknown') : 'disabled',
        activationMs: live?.activationMs,
        error:
          entry.error ??
          (live?.error ? String((live.error as Error)?.message ?? live.error) : undefined),
      }
    })
  }

  /** 首次加载全部外部扩展。单个失败只记日志，不影响其他扩展与应用启动。 */
  async loadAll(): Promise<void> {
    for (const { dir, entryFile } of discoverExternalExtensions(this.root)) {
      await this.reload(dir, entryFile)
    }
  }

  /** 开始轮询外部扩展目录。目录不存在也不报错——用户还没建过外部扩展。 */
  startWatching(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.rescanSafely()
    }, POLL_INTERVAL_MS)
    this.log.info(`[ext] 轮询外部扩展目录（每 ${POLL_INTERVAL_MS}ms）：${this.root}`)
  }

  stopWatching(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async rescanSafely(): Promise<void> {
    // 上一轮还没跑完就跳过本轮：重载涉及动态 import 与作用域销毁，不能交叉
    if (this.rescanning) return
    this.rescanning = true
    try {
      await this.rescan()
    } catch (error) {
      this.log.error('[ext] 重扫外部扩展失败', error)
    } finally {
      this.rescanning = false
    }
  }

  /** 重扫：新增的加载、变更的重载、消失的摘掉。 */
  async rescan(): Promise<void> {
    const current = new Map(discoverExternalExtensions(this.root).map(e => [e.dir, e.entryFile]))

    for (const dir of [...this.loaded.keys()]) {
      if (!current.has(dir)) {
        await this.unload(dir)
      }
    }

    for (const [dir, entryFile] of current) {
      const known = this.loaded.get(dir)
      if (known && known.revision === revisionOf(entryFile)) continue
      await this.reload(dir, entryFile)
    }
  }

  private async reload(dir: string, entryFile: string): Promise<void> {
    const revision = revisionOf(entryFile)
    const previous = this.loaded.get(dir)
    const dirName = path.basename(dir)

    let mod: ExternalExtensionModule
    try {
      // ?v=revision 是唯一可靠的缓存破除手段：ESM 无法真正卸载旧模块对象
      mod = parseExternalModule(await import(`${pathToFileURL(entryFile).href}?v=${revision}`), this.appVersion)
    } catch (error) {
      // 新代码坏了 → 旧版本继续服务。先卸后载会让「编辑到一半保存」变成功能凭空消失
      const message = (error as Error)?.message ?? String(error)
      this.log.error(`[ext] 加载失败 ${entryFile}，保留旧版本`, error)
      // 记下这次 revision：否则 rescan 每秒重试一次、每秒刷一条同样的错误
      this.loaded.set(
        dir,
        previous
          ? { ...previous, revision, error: message }
          : {
              dir,
              entryFile,
              revision,
              manifestId: dirName,
              name: dirName,
              version: '?',
              enabled: false,
              error: message,
            },
      )
      return
    }

    const { manifest, definition } = mod

    // 与内置扩展撞 id 时给出可读的原因，而不是底层的「重复注册」
    const occupied = this.host.get(manifest.id)
    if (occupied && occupied.id !== previous?.manifestId) {
      this.log.error(`[ext] ${manifest.id} 与已加载的扩展同名，已跳过（${dirName}）`)
      return
    }

    // 先卸旧的：作用域销毁要等完，否则新旧两份会同时持有服务与监听器
    if (previous) await this.unload(previous.dir)

    // 被禁用：只登记不激活。登记是为了让它在列表里仍然看得见——
    // 关掉之后就从 UI 里消失，等于逼用户去手改 JSON。
    if (this.disabledIds.has(manifest.id)) {
      this.loaded.set(dir, {
        dir,
        entryFile,
        revision,
        manifestId: manifest.id,
        name: manifest.name,
        version: manifest.version,
        definition,
        enabled: false,
      })
      this.log.info(`[ext] ${manifest.id} 已按配置禁用（${dirName}）`)
      return
    }

    try {
      this.host.register(definition)
      const error = await this.host.activate(manifest.id)
      if (error) throw error
    } catch (error) {
      this.log.error(`[ext] ${manifest.id} 新版本加载失败`, error)
      await this.host.unregister(manifest.id).catch(() => undefined)
      // 卸载已经发生，只有把上一版重新激活才算真回滚
      if (previous) await this.restore({ ...previous, error: (error as Error)?.message ?? String(error) })
      return
    }

    this.loaded.set(dir, {
      dir,
      entryFile,
      revision,
      manifestId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      definition,
      enabled: true,
    })
    this.log.info(`[ext] ${manifest.id} 已加载（${dirName}）`)
  }

  /** 新版本失败时把上一版重新挂起来。回滚也失败则如实报告该扩展已停止。 */
  private async restore(entry: ExternalExtensionEntry): Promise<void> {
    if (!entry.definition) return
    try {
      this.host.register(entry.definition)
      const error = await this.host.activate(entry.manifestId)
      if (error) throw error
      this.loaded.set(entry.dir, entry)
      this.log.warn(`[ext] ${entry.manifestId} 已回滚到上一个版本`)
    } catch (error) {
      this.log.error(`[ext] ${entry.manifestId} 回滚也失败，该扩展已停止`, error)
    }
  }

  private async unload(dir: string): Promise<void> {
    const entry = this.loaded.get(dir)
    if (!entry) return
    this.loaded.delete(dir)

    try {
      await this.host.unregister(entry.manifestId)
      this.log.info(`[ext] ${entry.manifestId} 已卸载`)
    } catch (error) {
      this.log.warn(`[ext] 卸载 ${entry.manifestId} 失败：${(error as Error).message}`)
    }
  }
}
