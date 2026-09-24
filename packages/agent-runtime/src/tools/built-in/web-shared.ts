/**
 * web-shared — 网页工具共享工具函数
 *
 * 缓存、超时、URL校验等通用逻辑，供 web-search-tool 和 web-fetch-tool 共用。
 */

export const DEFAULT_TIMEOUT_SECONDS = 30;
export const DEFAULT_CACHE_TTL_MINUTES = 15;

/**
 * 校验 URL 合法性，防止 SSRF 攻击
 * - 仅允许 http/https 协议
 * - 阻止内网/本地地址
 */
export function validateUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}. Only http and https are allowed.`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // 阻止本地地址
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0"
  ) {
    throw new Error(`Access to local addresses is not allowed: ${hostname}`);
  }

  // 阻止内网 IP 段
  if (
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname === "169.254.169.254" || // AWS/GCP metadata
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local")
  ) {
    throw new Error(`Access to internal network addresses is not allowed: ${hostname}`);
  }

  return parsed;
}

export function normalizeCacheKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 创建带超时的 AbortSignal，返回 cleanup 函数以避免 timer 泄漏
 */
export function withTimeout(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}
