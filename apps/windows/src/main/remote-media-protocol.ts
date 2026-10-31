/**
 * lumii-remote 自定义协议：给**需要鉴权的远端媒体**做本地代理。
 *
 * 为什么必须有它：ComfyUI `/view` 走 Basic Auth，而 `<img src>` / `<video src>`
 * 是浏览器内核自己发的请求，带不上自定义头——渲染层只能拿到 401，预览区就是空白。
 * 这里把地址包成 `lumii-remote://media/?src=<远端URL>`，由主进程按 MCP 配置里的
 * `*_AUTH_*` 环境变量补头再转发。
 *
 * **密钥不进 DOM**：URL 里只有远端地址，凭据在主进程按 origin 查配置得到，
 * 所以截图、日志、剪贴板都不会漏 token。
 *
 * 安全边界：只代理**已配置 MCP Server 的 COMFYUI_URL origin**，不是开放代理。
 */
import { net, protocol } from 'electron'
import { applyPresetDefaults, loadMcpServerConfigs } from './config/mcp-config'
import { findMcpPreset } from '../shared/mcp-presets'
import { REMOTE_MEDIA_SCHEME } from './remote-media-url'

export { REMOTE_MEDIA_SCHEME, buildRemoteMediaUrl } from './remote-media-url'

interface AuthRule {
  readonly origin: string
  readonly header: string
  /** 头值：scheme + token，或裸 token */
  readonly value: string
}

/** 配置读取缓存：同一进程内 5s 内复用，避免每张图都读一次文件 */
let cache: { at: number; rules: AuthRule[] } | null = null
const CACHE_TTL_MS = 5_000

/** 从 MCP 配置推导可代理的 origin 与鉴权头 */
function loadAuthRules(): AuthRule[] {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.rules

  const rules: AuthRule[] = []
  try {
    for (const raw of loadMcpServerConfigs()) {
      const entry = applyPresetDefaults(raw, findMcpPreset(raw.name))
      const env = entry.env ?? {}
      const base = env.COMFYUI_URL?.trim()
      if (!base || !/^https?:\/\//i.test(base)) continue
      let origin: string
      try {
        origin = new URL(base).origin
      } catch {
        continue
      }
      const token = env.COMFYUI_AUTH_TOKEN?.trim()
      if (!token) {
        // 无鉴权的服务也允许代理（同一份代码路径），只是不带头
        rules.push({ origin, header: '', value: '' })
        continue
      }
      const scheme = env.COMFYUI_AUTH_SCHEME?.trim() || 'Basic'
      const header = env.COMFYUI_AUTH_HEADER?.trim() || 'Authorization'
      rules.push({ origin, header, value: `${scheme} ${token}` })
    }
  } catch {
    // 配置读不到就当没有可代理的源（返回 403，渲染层显示空白而不是报错崩掉）
  }

  cache = { at: now, rules }
  return rules
}

/** 仅供单测：丢掉配置缓存 */
export function resetRemoteMediaCacheForTests(): void {
  cache = null
}

/** app ready 后注册协议处理器 */
export function registerRemoteMediaProtocolHandler(): void {
  protocol.handle(REMOTE_MEDIA_SCHEME, async (request) => {
    let src: string | null = null
    try {
      src = new URL(request.url).searchParams.get('src')
    } catch {
      return new Response('bad url', { status: 400 })
    }
    if (!src) return new Response('missing src', { status: 400 })

    let target: URL
    try {
      target = new URL(src)
    } catch {
      return new Response('bad src', { status: 400 })
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return new Response('forbidden scheme', { status: 403 })
    }

    const rule = loadAuthRules().find((r) => r.origin === target.origin)
    if (!rule) {
      // 不在已配置的媒体源里：拒绝，避免变成任意外网代理
      return new Response('origin not allowed', { status: 403 })
    }

    try {
      // Range 必须透传：<video> 的续缓冲与 seek 靠 206 分片，丢了就只在整段
      // 200 上从头往下读，界面上表现为播到某秒卡死。
      const range = request.headers.get('range')
      const headers: Record<string, string> = rule.header ? { [rule.header]: rule.value } : {}
      if (range) headers.Range = range
      return await net.fetch(target.href, { headers })
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), { status: 502 })
    }
  })
}
