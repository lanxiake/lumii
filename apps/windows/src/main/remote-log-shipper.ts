/**
 * remote-log-shipper — Windows 客户端日志远程归集
 *
 * 参照 kids-mobile 模式：内存队列 + 批量 POST 到网关 /v1/client/logs。
 * 仅上报 error + 关键生命周期事件，不上报 debug/info。
 *
 * 守卫：未认证时不发请求，避免 401 风暴。
 */

export type ClientLogLevel = "info" | "warn" | "error"

export interface ClientLogEntry {
  level: ClientLogLevel
  event: string
  message?: string
  meta?: Record<string, unknown>
}

export interface WindowsLogShipperDeps {
  readonly getGatewayUrl: () => string | null
  readonly getAuthToken: () => string | null
  readonly getDeviceId: () => string | undefined
}

const FLUSH_INTERVAL_MS = 10_000
const BATCH_SIZE = 20
const MAX_QUEUE = 100
const FETCH_TIMEOUT_MS = 8_000

export interface RemoteLogShipper {
  ship(entry: ClientLogEntry): void
  flush(): Promise<void>
  destroy(): void
}

export function createWindowsLogShipper(deps: WindowsLogShipperDeps): RemoteLogShipper {
  const queue: ClientLogEntry[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let flushing = false
  let destroyed = false

  async function flush(): Promise<void> {
    if (flushing || queue.length === 0 || destroyed) return

    const gatewayUrl = deps.getGatewayUrl()
    const token = deps.getAuthToken()
    if (!gatewayUrl || !token) return

    flushing = true
    const batch = queue.splice(0, BATCH_SIZE)
    const url = `${gatewayUrl.replace(/\/+$/, "")}/v1/client/logs`
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      }
      const deviceId = deps.getDeviceId()
      if (deviceId) headers["X-Device-Id"] = deviceId

      await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ platform: "windows", entries: batch }),
        signal: controller.signal,
      })
    } catch {
      // 静默丢弃
    } finally {
      clearTimeout(t)
      flushing = false
      if (queue.length > 0 && !destroyed) schedule()
    }
  }

  function schedule(): void {
    if (timer || destroyed) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, FLUSH_INTERVAL_MS)
  }

  return {
    ship(entry: ClientLogEntry): void {
      if (destroyed) return
      queue.push(entry)
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
      if (queue.length >= BATCH_SIZE) void flush()
      else schedule()
    },
    flush,
    destroy(): void {
      destroyed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
