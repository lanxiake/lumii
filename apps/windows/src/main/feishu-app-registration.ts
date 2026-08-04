/**
 * 飞书应用注册客户端（OAuth device-code）。
 *
 * 对齐 OpenClaw `extensions/feishu/src/app-registration.ts`：
 * init → begin（拿 QR）→ poll（拿 appId/appSecret）。
 */

export type FeishuDomain = 'feishu' | 'lark'

const FEISHU_ACCOUNTS_URL = 'https://accounts.feishu.cn'
const LARK_ACCOUNTS_URL = 'https://accounts.larksuite.com'
const REGISTRATION_PATH = '/oauth/v1/app/registration'
const REQUEST_TIMEOUT_MS = 10_000

export interface AppRegistrationResult {
  appId: string
  appSecret: string
  domain: FeishuDomain
  openId?: string
}

export interface BeginResult {
  deviceCode: string
  qrUrl: string
  userCode: string
  interval: number
  expireIn: number
}

export type PollOutcome =
  | { status: 'success'; result: AppRegistrationResult }
  | { status: 'access_denied' }
  | { status: 'expired' }
  | { status: 'timeout' }
  | { status: 'pending' }
  | { status: 'error'; message: string }

interface InitResponse {
  nonce?: string
  supported_auth_methods?: string[]
}

interface RawBeginResponse {
  device_code: string
  verification_uri: string
  user_code: string
  verification_uri_complete: string
  interval: number
  expire_in: number
}

interface PollResponse {
  client_id?: string
  client_secret?: string
  user_info?: {
    open_id?: string
    tenant_brand?: 'feishu' | 'lark'
  }
  error?: string
  error_description?: string
}

/**
 * 按域名选择 accounts 基址。
 */
function accountsBaseUrl(domain: FeishuDomain): string {
  return domain === 'lark' ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL
}

/**
 * POST /oauth/v1/app/registration（form-urlencoded）。
 */
async function postRegistration<T>(
  baseUrl: string,
  body: Record<string, string>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const resp = await fetch(`${baseUrl}${REGISTRATION_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  })
  // poll 对 pending/error 也会返回 4xx + JSON body
  return (await resp.json()) as T
}

/**
 * 初始化注册环境，确认支持 client_secret。
 */
export async function initAppRegistration(domain: FeishuDomain = 'feishu'): Promise<void> {
  const res = await postRegistration<InitResponse>(accountsBaseUrl(domain), { action: 'init' })
  if (!res.supported_auth_methods?.includes('client_secret')) {
    throw new Error('当前环境不支持 client_secret 认证方式，无法扫码创建飞书应用')
  }
}

/**
 * 开始 device-code 流程，返回二维码 URL 与 device_code。
 */
export async function beginAppRegistration(domain: FeishuDomain = 'feishu'): Promise<BeginResult> {
  const res = await postRegistration<RawBeginResponse>(accountsBaseUrl(domain), {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  })

  const qrUrl = new URL(res.verification_uri_complete)
  qrUrl.searchParams.set('from', 'mtbot_onboard')
  // ob_cli_app：官方 OpenClaw CLI 新建机器人；ob_app 为控制台创建
  qrUrl.searchParams.set('tp', 'ob_cli_app')

  return {
    deviceCode: res.device_code,
    qrUrl: qrUrl.toString(),
    userCode: res.user_code,
    interval: res.interval || 5,
    expireIn: res.expire_in || 600,
  }
}

/**
 * 单次轮询授权结果（由上层按 interval 调度）。
 */
export async function pollAppRegistrationOnce(params: {
  deviceCode: string
  domain?: FeishuDomain
}): Promise<PollOutcome & { domain?: FeishuDomain }> {
  const domain = params.domain ?? 'feishu'
  let pollRes: PollResponse
  try {
    pollRes = await postRegistration<PollResponse>(
      accountsBaseUrl(domain),
      {
        action: 'poll',
        device_code: params.deviceCode,
      },
      30_000,
    )
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
      domain,
    }
  }

  // 租户品牌为 lark 时提示上层切换域名
  if (pollRes.user_info?.tenant_brand === 'lark' && domain !== 'lark') {
    return { status: 'pending', domain: 'lark' }
  }

  if (pollRes.client_id && pollRes.client_secret) {
    return {
      status: 'success',
      result: {
        appId: pollRes.client_id,
        appSecret: pollRes.client_secret,
        domain,
        openId: pollRes.user_info?.open_id,
      },
      domain,
    }
  }

  if (pollRes.error) {
    if (pollRes.error === 'authorization_pending') {
      return { status: 'pending', domain }
    }
    if (pollRes.error === 'slow_down') {
      return { status: 'pending', domain }
    }
    if (pollRes.error === 'access_denied') {
      return { status: 'access_denied', domain }
    }
    if (pollRes.error === 'expired_token') {
      return { status: 'expired', domain }
    }
    return {
      status: 'error',
      message: `${pollRes.error}: ${pollRes.error_description ?? 'unknown'}`,
      domain,
    }
  }

  return { status: 'pending', domain }
}
