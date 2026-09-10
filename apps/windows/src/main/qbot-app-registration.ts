/**
 * QQ 机器人扫码建应用（device-code，逆向自 OpenClaw 内部 cgi，未公开承诺稳定）。
 *
 * 一期把「扫码建应用」当可选加速路径：lite_create 失败（未授权/接口变动）时，
 * 由上层 QbotLoginService 捕获后降级到凭证表单（用户去 q.qq.com 手填 AppID+AppSecret）。
 */

const LITE_CREATE_URL = 'https://bot.q.qq.com/cgi-bin/lite_create'

export interface QbotAppRegistrationResult {
  appId: string
  appSecret: string
}

/**
 * 调用内部 cgi 创建机器人，返回 AppID + AppSecret。
 * 失败抛错（上层 catch 转降级）。
 */
export async function liteCreateApp(idempotencyKey: string): Promise<QbotAppRegistrationResult> {
  const resp = await fetch(LITE_CREATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apply_source: 1, idempotency_key: idempotencyKey }),
    signal: AbortSignal.timeout(15_000),
  })
  const payload = (await resp.json()) as {
    ret?: number
    errcode?: number
    data?: { appid?: string; client_secret?: string }
  }
  const appId = payload.data?.appid
  const appSecret = payload.data?.client_secret
  if (!appId || !appSecret) {
    throw new Error(`lite_create 失败 (ret=${payload.ret ?? payload.errcode ?? 'unknown'})`)
  }
  return { appId, appSecret }
}
