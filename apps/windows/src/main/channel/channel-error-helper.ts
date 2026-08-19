/**
 * channel-error-helper
 *
 * 渠道消息（微信/企微/飞书）错误统一映射：将主代理路径的异常
 * 转换成中文友好文案，便于渠道用户快速定位配置问题。
 *
 * 配合「即时回执」文案：
 * - 收到消息立即回复："✅ 已收到，正在处理…"
 * - 处理失败回复："❌ 处理失败：{友好错误信息}。可打开桌面客户端，在「设置 - 模型提供商」检查连接状态与 API 密钥。"
 */

/** 渠道即时回执文案（极简） */
export const CHANNEL_ACK_TEXT = '✅ 已收到，正在处理…'

/**
 * 将未知异常转换为中文友好错误信息。
 *
 * 映射策略（按匹配优先级）：
 * 1. 明确 key 失效 / invalid api key / Unauthorized / 401 → 指向「API 密钥错误」
 * 2. 明确额度 / insufficient_quota / Rate limit / quota exceeded / 429 → 指向「额度不足或限流」
 * 3. 明确 网络错误 / ECONNRESET / ETIMEDOUT / ENOTFOUND / fetch failed / 连接失败 / 超时 → 指向「网络问题」
 * 4. 明确 provider not found / provider disabled / no provider / 未配置 → 指向「模型未启用」
 * 5. ACP 后端不可用 / AcpBackendManager.xxx → 保持原信息（Acp 路径已自己回复）
 * 6. 否则拼接原 message（截断到 200 字符内，避免刷屏）
 */
export function toFriendlyChannelError(err: unknown): string {
  const msg =
    err instanceof Error
      ? (err.message || '').trim()
      : typeof err === 'string'
        ? err.trim()
        : ''

  const low = msg.toLowerCase()

  // 1) API 密钥 / 鉴权
  if (
    /invalid.*(api|key)/i.test(msg) ||
    /unauthorized/.test(low) ||
    /401\b/.test(low) ||
    /auth(entication|orization)?.*fail/i.test(msg) ||
    /(key|token).*(无效|错误|不合法|过期)/.test(msg) ||
    /incorrect.*api/i.test(msg)
  ) {
    return 'API 密钥无效或已过期，请在桌面客户端「设置 - 模型提供商」检查并重新配置正确的 API Key，然后重试。'
  }

  // 2) 额度 / 限流
  if (
    /quota.?exceeded/i.test(msg) ||
    /insufficient.?quota/i.test(msg) ||
    /rate.?limit/i.test(msg) ||
    /too.?many.?requests/i.test(msg) ||
    /429\b/.test(low) ||
    /(额度|余额|次数).*(不足|用完|耗尽|超限|超限)/.test(msg) ||
    /billing.?hard.?limit/i.test(msg)
  ) {
    return '模型额度不足或触发频率限制。请在提供商官网充值/检查额度，或稍后重试；可切换到其他已启用的模型。'
  }

  // 3) 模型不可用 / 未配置
  if (
    /provider.*(not found|not configured|disabled|unavailable)/i.test(msg) ||
    /no.*provider.*(available|enabled)/i.test(msg) ||
    /model.*(not found|not support|invalid|disabled)/i.test(msg) ||
    /(模型|提供商).*(未配置|不存在|未启用|不可用|不支持|非法)/.test(msg) ||
    /model_not_found/i.test(msg)
  ) {
    return '未检测到可用模型。请在桌面客户端「设置 - 模型提供商」启用至少一个模型（如 OpenAI / 硅基流动 / 通义等），并填写正确凭据。'
  }

  // 4) 网络 / 超时 / 连接错误
  if (
    /econn(refused|reset|aborted)/i.test(low) ||
    /etimedout/i.test(low) ||
    /enotfound/i.test(low) ||
    /fetch.*fail/i.test(msg) ||
    /network.*(error|fail)/i.test(msg) ||
    /(连接|网络|超时|请求失败|无法访问|无法连接|DNS.*解析)/.test(msg) ||
    /timeout/i.test(low)
  ) {
    return '网络连接超时或请求失败。请检查本机网络是否通畅、系统代理是否干扰 API 请求；若使用自建/中转地址请核对 endpoint 是否可访问。'
  }

  // 5) 权限 / 沙箱拒（agent 自保护提示）
  if (
    /permission.*denied/i.test(msg) ||
    /access.*denied/i.test(msg) ||
    /forbidden/i.test(low) ||
    /403\b/.test(low) ||
    /(拒绝|没有权限|权限不足)/.test(msg)
  ) {
    return '权限不足或访问被拒绝（403）。若是模型问题请到官网核实账户权限；若是本地文件/命令受限，请在桌面端再次授权后重试。'
  }

  // 6) 兜底：原样（截断，避免刷屏）
  if (msg.length === 0) {
    return '未知错误（未捕获异常）。可打开桌面客户端查看详细日志，或稍后重试。'
  }
  const truncated = msg.length > 200 ? msg.slice(0, 200) + '…' : msg
  return `${truncated}`
}

/** 渠道失败回复完整格式（带尾部引导） */
export function buildChannelErrorMessage(err: unknown): string {
  const friendly = toFriendlyChannelError(err)
  return `❌ 处理失败：${friendly}\n可打开桌面客户端，在「设置 - 模型提供商」检查连接状态与 API 密钥。`
}
