import React from 'react'
import * as ReactDOM from 'react-dom'
import * as JsxRuntime from 'react/jsx-runtime'

import { registerCard, type CardRenderer } from '../components/A2UIRenderer/card-registry'
import { registerSlot, type SlotEntry } from '../components/slots/slot-registry'

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
  entry: string
  revision: string
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
}

interface LoadedPlugin {
  descriptor: ClientPluginDescriptor
  dispose: () => void
}

const REGISTER_KEY = '__LUMII_REGISTER_PLUGIN__'
const loaded = new Map<string, LoadedPlugin>()
const pending = new Map<string, ClientPluginFactory>()
const disposers = new Map<string, Array<() => void>>()

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

function injectScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = url
    el.async = false
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`脚本加载失败: ${url}`))
    document.head.appendChild(el)
  })
}

function unload(pluginId: string): void {
  const entry = loaded.get(pluginId)
  if (!entry) return
  loaded.delete(pluginId)
  try {
    entry.dispose()
  } catch (err) {
    console.error(`[client-plugin] ${pluginId} 卸载失败`, err)
  }
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
  // 先收工厂；同 id 重复注册时以后来的为准（热重载场景）
  pending.delete(descriptor.id)

  // URL 用**目录名**定位文件：id 可能被 plugin.json 改写，与目录名不同
  const url = `${SCHEME}/${encodeURIComponent(descriptor.dir)}/${descriptor.entry}?v=${descriptor.revision}`
  await injectScript(url)

  const factory = pending.get(descriptor.id)
  if (!factory) {
    console.error(`[client-plugin] ${descriptor.id} 没有调用 __LUMII_REGISTER_PLUGIN__`)
    return
  }

  // 注册前先卸旧版本：否则同一 type / slot id 会撞「已注册」而抛错
  unload(descriptor.id)

  let dispose: void | (() => void)
  try {
    dispose = factory(createApi(descriptor.id))
  } catch (err) {
    console.error(`[client-plugin] ${descriptor.id} 激活失败`, err)
    return
  }

  loaded.set(descriptor.id, {
    descriptor,
    dispose: () => {
      if (typeof dispose === 'function') dispose()
    },
  })
  // 主进程只捕获 log/warn/error；console.info 不进日志文件（踩过两次）
  console.log(`[client-plugin] ${descriptor.id}@${descriptor.version} 已加载`)
}

async function syncOnce(): Promise<void> {
  const list = await fetchList()
  const seen = new Set<string>()

  for (const descriptor of list) {
    seen.add(descriptor.id)
    const current = loaded.get(descriptor.id)
    if (current && current.descriptor.revision === descriptor.revision) continue
    await loadOne(descriptor)
  }

  for (const id of [...loaded.keys()]) {
    if (!seen.has(id)) unload(id)
  }
}

/** 启动插件宿主：拉一次清单，然后按 revision 轮询。重复调用无副作用。 */
export async function initClientPlugins(): Promise<void> {
  if (started) return
  started = true

  globalThis[REGISTER_KEY] = (id, factory) => {
    pending.set(id, factory)
  }

  await syncOnce()
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
  delete globalThis[REGISTER_KEY]
  started = false
}
