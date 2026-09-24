/**
 * pet-asset-protocol — 用户宠物目录的资源通道（主进程）
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §5.1
 *
 * 内置模型走既有解析（dev 用 `/pet-models/` Vite 中间件，打包用 `file://`），一行不改。
 * **用户模型**则必须另开通道，原因是 dev 模式下宠物窗口从 `http://127.0.0.1:5174`
 * 加载，而 HTTP 页面读不了 `file://` 子资源，Vite 中间件又只映射到
 * `apps/windows/resources/`，够不到用户数据目录。
 *
 * 三条候选（详见 P0-a 实施计划 §2.2）里选了自定义协议：
 *   - 无 dev/打包分支：同一套 URL 两种模式都成立，消除一类只在打包后暴露的故障
 *   - 路径语义干净：注册 standard scheme 后 `new URL('atlas.png', 'lumii-pet://model/x/manifest.json')`
 *     得到 `lumii-pet://model/x/atlas.png`，清单里的**相对引用**直接可用
 *   - 读取面收敛：处理器只认用户宠物目录这一个根，路径穿越在协议层被挡死
 *
 * URL 形态：`lumii-pet://model/<相对用户宠物目录的路径>`
 */

import { existsSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { resolveClientStateDir } from '../client-data-root'

const log = {
  info: (...args: unknown[]) => console.log('[pet-asset-protocol]', ...args),
  warn: (...args: unknown[]) => console.warn('[pet-asset-protocol]', ...args),
}

const PET_ASSET_SCHEME = 'lumii-pet'
const PET_ASSET_HOST = 'model'

/**
 * 用户宠物目录。
 *
 * 放在**客户端数据根**（`~/.lumii`，见 client-data-root.ts）之下，不用
 * `app.getPath('userData')`。这一点是实测撞出来的：
 *
 *   `app.setName('Lumii')` 在 `whenReady()` 之后调用，而 userData 在更早的启动阶段
 *   就已按 `app.getName()` 算好并缓存 —— 于是 dev 下是 `%APPDATA%/lumii-windows`
 *   （package.json 的 name），打包才是 `%APPDATA%/Lumii`（productName）。
 *   实测日志：`已注册 lumii-pet:// 协议处理器，根目录 C:\...\lumii-windows\pet-models`。
 *
 * 工具链（packages/pet-asset）装到的目录必须与客户端扫的目录一致，而 CLI 不依赖
 * Electron，无从得知当前是 dev 还是打包。改用数据根后两边都落在 `~/.lumii/pet-models`，
 * 按构造一致。
 *
 * 另外两条理由：数据根在 Agent 写权限之外（设计 §5.1 的安全边界），
 * 且 `LUMII_CLIENT_DATA_DIR` 可覆盖，便于隔离测试。
 */
export function resolveUserPetModelsDir(): string {
  return join(resolveClientStateDir(), PET_MODELS_SUBDIR)
}

/** 用户宠物目录名（数据根之下）。packages/pet-asset 侧有一份同值实现，改动须同步。 */
const PET_MODELS_SUBDIR = 'pet-models'

/** 绝对路径 → `lumii-pet://` URL；不在用户宠物目录内时抛错（调用方传错路径属于 bug） */
export function buildPetAssetUrl(absPath: string): string {
  const root = resolveUserPetModelsDir()
  const abs = resolve(absPath)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`路径不在用户宠物目录内：${abs}`)
  }
  const encoded = rel.split(sep).map(encodeURIComponent).join('/')
  return `${PET_ASSET_SCHEME}://${PET_ASSET_HOST}/${encoded}`
}

/**
 * `lumii-pet://` URL → 绝对磁盘路径；非法或越界返回 null。
 *
 * 越界判定在 `resolve()` **之后**做（而不是只看输入里有没有 `..`）：
 * 符号链接、`%2e%2e` 编码、Windows 的短名等都能绕过朴素字符串检查，
 * 归一化后再比对前缀才是可靠的写法。
 */
export function petAssetUrlToDiskPath(url: string): string | null {
  let pathname: string
  try {
    const u = new URL(url)
    if (u.protocol !== `${PET_ASSET_SCHEME}:`) return null
    if (u.hostname !== PET_ASSET_HOST) return null
    pathname = u.pathname
  } catch {
    return null
  }

  let rel: string
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  } catch {
    return null
  }
  if (!rel || rel.includes('\0')) return null

  const root = resolveUserPetModelsDir()
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}

/** app ready 前注册 privileged scheme（否则渲染层无法 fetch / 用作纹理源） */
export function registerPetAssetSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PET_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ])
}

/** app ready 后注册协议处理器 */
export function registerPetAssetProtocolHandler(): void {
  protocol.handle(PET_ASSET_SCHEME, (request) => {
    const abs = petAssetUrlToDiskPath(request.url)
    if (!abs) {
      log.warn(`拒绝越界或非法的资源请求: ${request.url}`)
      return new Response('forbidden', { status: 403 })
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return new Response('not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(abs).href)
  })
  log.info(`已注册 ${PET_ASSET_SCHEME}:// 协议处理器，根目录 ${resolveUserPetModelsDir()}`)
}
