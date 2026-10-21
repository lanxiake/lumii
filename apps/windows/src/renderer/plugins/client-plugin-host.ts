import React from 'react'
import * as ReactDOM from 'react-dom'
import * as JsxRuntime from 'react/jsx-runtime'

import { registerCard, type CardRenderer } from '../components/A2UIRenderer/card-registry'
import { PluginPage } from '../components/slots/PluginPage'
import { registerSlot, type SlotEntry } from '../components/slots/slot-registry'
import { pluginFormat } from '../utils/format'
import { createPluginStorage, type PluginStorage } from './plugin-storage'

/**
 * 渲染层插件宿主。
 *
 * ## 怎么拿到插件
 *
 * 主进程用 `lumii-plugin://` 协议提供清单与文件（见 `main/client-plugin-protocol.ts`）。
 * 这里只做两件事：拉清单、注入脚本。**不开 IPC 通道**——加载器不需要。
 *
 * ## 插件能拿什么
 *
 * 工厂函数收到一组**宿主提供的模块**（React / ReactDOM / jsx-runtime / 注册 API），
 * 而不是自己打包一份 React。两份 React 会让 hooks 直接抛错，这是插件系统最常见的坑。
 *
 * ## 生命周期
 *
 * - 同 id 重新加载前先注销旧版本注册的一切（卡片、槽位）；
 * - 失败保留旧版本，并记录一条错误；
 * - 轮询清单做变更检测（与主进程的扩展加载器同一套思路，1 秒一次）。
 */

const SCHEME = 'lumii-plugin://local'
const POLL_INTERVAL_MS = 1000

interface ClientPluginDescriptor {
  dir: string
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 来源标记（agent = Agent 自举开发） */
  origin: 'agent' | 'user'
  entry: string
  revision: string
  /** 是否启用（主进程从 extensions.json 写进清单） */
  enabled: boolean
  /** 清单可解析且 engines 满足当前客户端 */
  compatible: boolean
  manifestError?: string
  incompatibleReason?: string
}

/** 给设置页看的快照：清单元数据 + 本进程里的真实加载状态 */
export interface ClientPluginState {
  id: string
  name: string
  version: string
  description?: string
  dir: string
  enabled: boolean
  origin: 'agent' | 'user'
  state: 'loaded' | 'failed' | 'disabled' | 'incompatible' | 'unknown'
  error?: string
}

/** 插件工厂：拿到宿主模块，返回激活函数 */
export type ClientPluginFactory = (api: ClientPluginApi) => void | (() => void)

export interface ClientPluginApi {
  React: typeof React
  ReactDOM: typeof ReactDOM
  jsx: typeof JsxRuntime
  /** 注册卡片类型（内建类型会被拒绝） */
  registerCard: (type: string, renderer: CardRenderer) => () => void
  /** 往槽位里加条目 */
  registerSlot: <P>(slot: string, entry: SlotEntry<P>) => () => void
  /** 整页外壳：与内置页同口径（令牌 + 主内容区 20px 内边距） */
  Page: typeof PluginPage
  /** 共享格式化：number / percent / currency / bytes / date / dateTime / relative */
  format: typeof pluginFormat
  /** 按插件 id 命名空间隔离的持久化 */
  storage: PluginStorage
}

interface LoadedPlugin {
  descriptor: ClientPluginDescriptor
  /** 保留工厂：新版本激活失败时用它重新激活上一版（回滚） */
  factory: ClientPluginFactory
  dispose: () => void
}

const REGISTER_KEY = '__LUMII_REGISTER_PLUGIN__'
const loaded = new Map<string, LoadedPlugin>()
const pending = new Map<string, ClientPluginFactory>()
const disposers = new Map<string, Array<() => void>>()
/** 已失败过的版本：同一 revision 不重复重试（轮询每秒一次，否则会刷屏） */
const failedRevision = new Map<string, string>()
/** 最近一轮清单里的描述符（设置页要显示名字/版本，加载失败的也要显示） */
const descriptors = new Map<string, ClientPluginDescriptor>()
/** 最近的错误（按插件 id）；成功后清掉 */
const errors = new Map<string, string>()

/**
 * 设置页快照。
 *
 * `useSyncExternalStore` 要求同一状态下返回**同一引用**，所以这里缓存，
 * 并且只在内容真的变化时通知——否则每秒一次轮询会让设置页每秒重渲染一次。
 *
 * ⚠️ **这三样必须跨 HMR 存活**：Vite 热替换会重新执行本模块，模块级 `new Set()`
 * 会变成新的一批，而已经挂载的消费者（`ExtensionsPanel`）仍持有**旧模块**的
 * `subscribeClientPlugins` / `getClientPluginStates` 引用。表现是
 * 「插件在跑、侧栏入口也在，设置页却永远显示『还没有客户端插件』」（2026-10-21 实测，
 * 整机重启才恢复）。挂到 globalThis 后新旧实例读写同一份，订阅不断。
 */
interface SharedState {
  listeners: Set<() => void>
  snapshot: ClientPluginState[]
  signature: string
}

const SHARED_KEY = Symbol.for('lumii.client-plugin-host.shared')
const shared: SharedState = ((globalThis as Record<symbol, unknown>)[SHARED_KEY] ??=
  { listeners: new Set<() => void>(), snapshot: [], signature: '' }) as SharedState

export function subscribeClientPlugins(listener: () => void): () => void {
  shared.listeners.add(listener)
  return () => {
    shared.listeners.delete(listener)
  }
}

export function getClientPluginStates(): ClientPluginState[] {
  return shared.snapshot
}

function rebuildStates(): void {
  const next: ClientPluginState[] = []
  for (const descriptor of descriptors.values()) {
    const runtimeError = errors.get(descriptor.id)
    /**
     * 清单问题优先于运行时错误：
     * - manifestError → failed（清单写坏了）
     * - engines 不满足 → incompatible（版本不兼容，面板要据此提示）
     * 这两种都不会被激活（syncInner 里直接跳过）。
     */
    const blockedError =
      descriptor.manifestError ??
      (!descriptor.compatible ? descriptor.incompatibleReason ?? '不兼容当前客户端版本' : undefined)
    next.push({
      id: descriptor.id,
      name: descriptor.name,
      version: descriptor.version,
      ...(descriptor.description ? { description: descriptor.description } : {}),
      dir: descriptor.dir,
      enabled: descriptor.enabled,
      origin: descriptor.origin,
      state: !descriptor.enabled
        ? 'disabled'
        : descriptor.manifestError
          ? 'failed'
          : !descriptor.compatible
            ? 'incompatible'
            : loaded.has(descriptor.id)
              ? 'loaded'
              : runtimeError
                ? 'failed'
                : 'unknown',
      error: blockedError ?? runtimeError,
    })
  }
  next.sort((a, b) => a.id.localeCompare(b.id))

  const signature = next
    .map((s) => `${s.id}|${s.enabled}|${s.state}|${s.error ?? ''}|${s.origin}|${s.version}`)
    .join('\n')
  if (signature === shared.signature) return
  shared.signature = signature
  shared.snapshot = next
  for (const listener of shared.listeners) listener()
  reportToMain(next)
}

/**
 * 把加载状态同步给主进程。
 *
 * 客户端插件的加载结果只在渲染层（语法错误、契约写错、槽位撞车），
 * 而 Agent 的 `plugin_dev status` 跑在主进程——不上报的话它只能猜。
 * 只在签名变化时发，与设置页重渲染同频；失败不影响宿主本身。
 */
function reportToMain(states: ClientPluginState[]): void {
  try {
    window.electronAPI?.extensions?.reportClientStates?.(
      states.map(({ id, name, version, dir, enabled, origin, state, error }) => ({
        id,
        name,
        version,
        dir,
        enabled,
        origin,
        state,
        ...(error ? { error } : {}),
      })),
    )
  } catch (err) {
    console.warn('[client-plugin] 状态上报失败（不影响插件运行）', err)
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __LUMII_REGISTER_PLUGIN__:
    | ((id: string, factory: ClientPluginFactory) => void)
    | undefined
}

let started = false
let pollTimer: ReturnType<typeof setInterval> | null = null

/** 宿主暴露给插件的固定模块表（插件不得自带第二份 React） */
function createApi(pluginId: string): ClientPluginApi {
  const own: Array<() => void> = []
  disposers.set(pluginId, own)

  return {
    React,
    ReactDOM,
    jsx: JsxRuntime,
    Page: PluginPage,
    format: pluginFormat,
    storage: createPluginStorage(pluginId),
    registerCard: (type, renderer) => {
      const off = registerCard(type, renderer)
      own.push(off)
      return off
    },
    registerSlot: (slot, entry) => {
      const off = registerSlot(slot, { ...entry, owner: pluginId } as never)
      own.push(off)
      return off
    },
  }
}

async function fetchList(): Promise<ClientPluginDescriptor[]> {
  try {
    const res = await fetch(`${SCHEME}/list.json`, { cache: 'no-store' })
    if (!res.ok) return []
    return (await res.json()) as ClientPluginDescriptor[]
  } catch (err) {
    // 插件目录不存在或协议未注册：当作「没有插件」，但要留下原因（静默失败排查过一次）
    console.log('[client-plugin] 清单拉取失败（按无插件处理）:', (err as Error)?.message ?? err)
    return []
  }
}

interface ScriptLoadResult {
  /** 非空 = 脚本拉下来了但**执行时**抛错（语法错误、顶层 throw） */
  runtimeError: Error | null
}

function injectScript(url: string): Promise<ScriptLoadResult> {
  return new Promise((resolve, reject) => {
    let runtimeError: Error | null = null
    /**
     * 脚本执行期抛错（含 SyntaxError）**不触发** `<script>` 的 onerror——onload 照常触发。
     * 不监听 window 的 error，下面就只能报「没有调用 __LUMII_REGISTER_PLUGIN__」，
     * 把执行错误误报成注册错误，会把人往错方向带（实测：改出语法错误时日志就是这么写的）。
     */
    const onWindowError = (event: ErrorEvent) => {
      if (event.filename !== url) return
      runtimeError = event.error instanceof Error ? event.error : new Error(event.message)
    }
    const cleanup = () => window.removeEventListener('error', onWindowError)
    window.addEventListener('error', onWindowError)

    const el = document.createElement('script')
    el.src = url
    el.async = false
    el.onload = () => {
      // 加载完就摘掉：热更新每次都插一条，不摘会在长开发会话里堆几百个标签
      cleanup()
      el.remove()
      resolve({ runtimeError })
    }
    el.onerror = () => {
      cleanup()
      el.remove()
      reject(new Error(`脚本加载失败: ${url}`))
    }
    document.head.appendChild(el)
  })
}

function unload(pluginId: string): void {
  const entry = loaded.get(pluginId)
  if (entry) {
    loaded.delete(pluginId)
    try {
      entry.dispose()
    } catch (err) {
      console.error(`[client-plugin] ${pluginId} 卸载失败`, err)
    }
  }
  /**
   * ⚠ **不能因为「没有 loaded 条目」就提前返回**：激活中途抛错时，工厂已经注册了一部分
   * 槽位（有的成功、有的撞 id），而 `loaded` 只在激活成功后才有值。
   * 早退会让这些半截条目永久留在注册表里——下次重试会撞上**自己上次留下的** id，
   * 于是这个插件从此永远起不来（2026-10-21 探针实测：冲突一次后重试报
   * `slot "dashboard.grid" 里已存在 id "probe.slots.grid"`）。
   */
  for (const off of disposers.get(pluginId) ?? []) {
    try {
      off()
    } catch {
      /* 注销失败不影响其他清理 */
    }
  }
  disposers.delete(pluginId)
}

async function loadOne(descriptor: ClientPluginDescriptor): Promise<void> {
  const previous = loaded.get(descriptor.id)
  // 先收工厂；同 id 重复注册时以后来的为准（热重载场景）
  pending.delete(descriptor.id)

  // URL 用**目录名**定位文件：id 可能被 plugin.json 改写，与目录名不同
  const url = `${SCHEME}/${encodeURIComponent(descriptor.dir)}/${descriptor.entry}?v=${descriptor.revision}`
  let runtimeError: Error | null = null
  try {
    runtimeError = (await injectScript(url)).runtimeError
  } catch (err) {
    // 脚本都下不来：旧版本继续服务（先卸后载会让「编辑到一半保存」变成功能消失）
    errors.set(descriptor.id, `脚本加载失败：${(err as Error)?.message ?? String(err)}`)
    console.error(`[client-plugin] ${descriptor.id} 脚本加载失败，保留旧版本`, err)
    return
  }

  const factory = pending.get(descriptor.id)
  if (!factory) {
    // 区分「执行时抛错」与「跑完了但没注册」：前者看上面那条 SyntaxError，后者才是契约写错
    const message = runtimeError
      ? `脚本执行出错：${runtimeError.message}`
      : '没有调用 __LUMII_REGISTER_PLUGIN__（一个插件只能注册一次，且 id 要与 plugin.json 一致）'
    errors.set(descriptor.id, message)
    console.error(`[client-plugin] ${descriptor.id} ${message}`, runtimeError ?? '')
    return
  }

  // 注册前必须先卸旧版本：同一 type / slot id 会撞「已注册」而抛错
  unload(descriptor.id)

  try {
    activate(descriptor, factory)
    failedRevision.delete(descriptor.id)
    errors.delete(descriptor.id)
  } catch (err) {
    errors.set(descriptor.id, `激活失败：${(err as Error)?.message ?? String(err)}`)
    console.error(`[client-plugin] ${descriptor.id} 激活失败`, err)
    // 记下这个 revision：轮询每秒一次，不记会「每秒重试、每秒回滚、每秒刷错误」
    failedRevision.set(descriptor.id, descriptor.revision)
    // 激活过程可能已注册了一部分（卡片成功、槽位失败），一并清掉
    unload(descriptor.id)
    if (previous) {
      try {
        activate(previous.descriptor, previous.factory)
        console.warn(`[client-plugin] ${descriptor.id} 已回滚到上一个版本（修好文件后自动重试）`)
      } catch (rollbackErr) {
        console.error(`[client-plugin] ${descriptor.id} 回滚也失败，已停止`, rollbackErr)
        unload(descriptor.id)
      }
    }
  }
}

/** 真正激活：建 api、调工厂、登记。抛错时由调用方决定回滚。 */
function activate(descriptor: ClientPluginDescriptor, factory: ClientPluginFactory): void {
  const api = createApi(descriptor.id)
  const dispose = factory(api)
  loaded.set(descriptor.id, {
    descriptor,
    factory,
    dispose: () => {
      if (typeof dispose === 'function') dispose()
    },
  })
  // 主进程只捕获 log/warn/error；console.info 不进日志文件（踩过两次）
  console.log(`[client-plugin] ${descriptor.id}@${descriptor.version} 已加载`)
}

let syncing = false

async function syncOnce(): Promise<void> {
  // 重入保护：轮询 1 秒一次，而一次加载（脚本下载）可能更久；
  // 两次并发同步会互相 unload，出现「插件刚加载就被卸掉」
  if (syncing) return
  syncing = true
  try {
    await syncInner()
  } finally {
    syncing = false
  }
}

async function syncInner(): Promise<void> {
  const list = await fetchList()
  const seen = new Set<string>()

  /**
   * 清单里的**集合**变了（插件被加进来 / 删掉）→ 清掉失败记录。
   *
   * 为什么：`failedRevision` 只认「自己文件的 revision」。一个插件因为**和别的插件撞
   * 槽位 id** 而失败时，对方的文件没变、自己的也没变——用户删掉冲突方后，
   * 它会永远停在失败态（2026-10-21 探针实测）。集合一变就整体重试一次，代价可忽略。
   */
  const previousIds = new Set(descriptors.keys())
  const nextIds = new Set(list.map((d) => d.id))
  const setChanged =
    previousIds.size !== nextIds.size || [...nextIds].some((id) => !previousIds.has(id))
  if (setChanged && previousIds.size > 0) failedRevision.clear()

  descriptors.clear()
  for (const descriptor of list) descriptors.set(descriptor.id, descriptor)
  for (const descriptor of list) seen.add(descriptor.id)

  /**
   * **先卸掉清单里消失的，再加载**。
   *
   * 顺序不能反：被删掉的插件占着的槽位 id 必须在本轮就释放，
   * 否则同轮里因为撞 id 而失败的插件会再失败一次（实测：删掉冲突方后 B 仍然报
   * 「已存在 id pair.test」，因为清理放在了加载之后）。
   */
  for (const id of [...loaded.keys()]) {
    if (!seen.has(id)) unload(id)
  }

  for (const descriptor of list) {
    // 被禁用：立刻卸掉。开关写在 extensions.json，主进程下一轮 list.json 就带过来——
    // 这里不需要额外的 IPC，用户点完开关 ≤1 秒就见效。
    if (!descriptor.enabled) {
      unload(descriptor.id)
      failedRevision.delete(descriptor.id)
      continue
    }

    // 清单坏了或版本不兼容：不激活，但保留在列表里（rebuildStates 会给出原因）
    if (descriptor.manifestError || !descriptor.compatible) {
      unload(descriptor.id)
      failedRevision.delete(descriptor.id)
      continue
    }

    const current = loaded.get(descriptor.id)
    if (current && current.descriptor.revision === descriptor.revision) continue
    // 这个版本刚失败过：等文件改了（revision 变化）再试
    if (failedRevision.get(descriptor.id) === descriptor.revision) continue
    try {
      await loadOne(descriptor)
    } catch (err) {
      // 单个插件炸掉不该拖累同轮的其它插件
      errors.set(descriptor.id, `加载异常：${(err as Error)?.message ?? String(err)}`)
      console.error(`[client-plugin] ${descriptor.id} 加载异常`, err)
    }
  }

  for (const id of [...errors.keys()]) {
    if (!seen.has(id)) errors.delete(id)
  }

  rebuildStates()
}

/** 启动插件宿主：拉一次清单，然后按 revision 轮询。重复调用无副作用。 */
export async function initClientPlugins(): Promise<void> {
  if (started) return
  started = true

  globalThis[REGISTER_KEY] = (id, factory) => {
    pending.set(id, factory)
  }

  try {
    await syncOnce()
  } catch (err) {
    // 起不来就把 started 放回去。否则一次瞬时错误（HMR 期间改到一半的版本、
    // 协议还没就绪）会让宿主**永久停摆**——之后既不再轮询，也没人能再调 init。
    started = false
    throw err
  }
  console.log(`[client-plugin] 宿主已启动（已加载 ${loaded.size} 个插件）`)
  pollTimer = setInterval(() => {
    void syncOnce().catch((err) => console.warn('[client-plugin] 同步失败', err))
  }, POLL_INTERVAL_MS)
}

/** 仅测试/卸载用 */
export function stopClientPlugins(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  for (const id of [...loaded.keys()]) unload(id)
  descriptors.clear()
  errors.clear()
  failedRevision.clear()
  delete globalThis[REGISTER_KEY]
  started = false
  rebuildStates()
}

/**
 * 编辑**本文件**时的自恢复。
 *
 * 没有这两行：旧模块的 setInterval 还在跑、新模块的 `loaded` 是空的 →
 * 重新注册撞「已存在 id」，所有插件报废，只能重开窗口。
 * 这是 P4 里同类问题（内置卡片用模块级布尔做幂等）的第三次出现，
 * 所以这里把它写成机制而不是注释。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => stopClientPlugins())
  import.meta.hot.accept((newModule) => {
    void newModule
      ?.initClientPlugins()
      .catch((err: unknown) => console.error('[client-plugin] HMR 重启宿主失败', err))
  })
}


