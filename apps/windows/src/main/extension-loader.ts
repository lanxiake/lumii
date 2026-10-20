import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { LumiiPluginManifest, PluginContext, PluginHost } from '@mtbot/plugin-core'

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
  definition: { id: string; apply(ctx: PluginContext<MainEvents>): void | Promise<void> }
}

export interface ExternalExtensionEntry {
  dir: string
  entryFile: string
  /** 上次加载时的 mtime+size，用于判断是否真的变了 */
  revision: string
  manifestId: string
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

/** 扫出所有含 main.js 的子目录。目录不存在时返回空数组（不是错误）。 */
export function discoverExternalExtensions(): Array<{ dir: string; entryFile: string }> {
  const root = resolveExtensionsDir()
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
  ) {}

  /** 首次加载全部外部扩展。单个失败只记日志，不影响其他扩展与应用启动。 */
  async loadAll(): Promise<void> {
    for (const { dir, entryFile } of discoverExternalExtensions()) {
      await this.reload(dir, entryFile)
    }
  }

  /** 开始轮询外部扩展目录。目录不存在也不报错——用户还没建过外部扩展。 */
  startWatching(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.rescanSafely()
    }, POLL_INTERVAL_MS)
    this.log.info(`[ext] 轮询外部扩展目录（每 ${POLL_INTERVAL_MS}ms）：${resolveExtensionsDir()}`)
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
    const current = new Map(discoverExternalExtensions().map(e => [e.dir, e.entryFile]))

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

    // 先卸载旧版本：作用域销毁要等完，否则新旧两份会同时持有服务与监听器
    if (previous) await this.unload(previous.dir)

    let mod: ExternalExtensionModule | undefined
    try {
      // ?v=revision 是唯一可靠的缓存破除手段：ESM 无法真正卸载旧模块对象
      const ns = (await import(`${pathToFileURL(entryFile).href}?v=${revision}`)) as {
        default?: ExternalExtensionModule
      } & Partial<ExternalExtensionModule>
      // 约定是 `export default {...}`；也容忍具名导出（export const manifest / definition）
      mod = ns.default ?? (ns as ExternalExtensionModule)
    } catch (error) {
      this.log.error(`[ext] 加载失败 ${entryFile}`, error)
      return
    }

    const manifest = mod?.manifest
    const definition = mod?.definition
    if (!manifest?.id || typeof definition?.apply !== 'function') {
      this.log.error(`[ext] ${entryFile} 未导出 { manifest, definition.apply }`)
      return
    }

    try {
      this.host.register(definition as never)
      const error = await this.host.activate(manifest.id)
      if (error) {
        this.log.error(`[ext] 激活失败 ${manifest.id}`, error)
        await this.host.unregister(manifest.id)
        return
      }
    } catch (error) {
      this.log.error(`[ext] 注册失败 ${manifest.id}`, error)
      return
    }

    this.loaded.set(dir, { dir, entryFile, revision, manifestId: manifest.id })
    this.log.info(`[ext] ${manifest.id} 已加载（${path.basename(dir)}）`)
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
