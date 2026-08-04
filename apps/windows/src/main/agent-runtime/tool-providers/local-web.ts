/**
 * 本地 Web 请求 — ToolExecutionContext.fetch 实现
 *
 * 增强：重试、User-Agent、超时、错误分类
 */

const log = {
  info: (...args: unknown[]) => console.log('[local-web]', ...args),
  warn: (...args: unknown[]) => console.warn('[local-web]', ...args),
}

export async function fetchLocal(
  url: string,
  opts?: RequestInit,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...(opts?.headers as Record<string, string> | undefined),
  }
  const maxRetries = 1
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        log.info(`[fetchLocal] 第 ${attempt + 1} 次重试 url=${url}`)
      }
      const response = await fetch(url, {
        ...opts,
        headers,
        signal: opts?.signal ?? AbortSignal.timeout(45_000),
      })
      const body = await response.text()
      return { status: response.status, body }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      log.warn(`[fetchLocal] 请求失败 (attempt=${attempt}): ${lastError.message}`)
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }

  // 所有重试都失败，返回错误信息而非抛出
  const message = classifyFetchError(lastError)
  return { status: 0, body: `[请求失败] ${message}\nURL: ${url}` }
}

function classifyFetchError(err: Error | null): string {
  const msg = err?.message ?? '未知错误'
  if (msg.includes('AbortError') || msg.includes('timeout'))
    return '请求超时（45秒）'
  if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo'))
    return 'DNS 解析失败，请检查网络连接'
  if (msg.includes('ECONNREFUSED')) return '连接被拒绝'
  if (msg.includes('ECONNRESET')) return '连接被重置'
  if (msg.includes('fetch failed')) return `网络请求失败: ${msg}`
  return msg
}
