/**
 * FeishuLoginService.pushText 单元测试
 *
 * pushText 是定时任务「飞书」通知目标的实际推送路径（cron-scheduler.ts 的
 * dispatchNotifications 通过 sendFeishuMessage 依赖注入调用它）。
 * cron-notify-dispatch.test.ts 只 mock 掉了这个依赖，没有覆盖 pushText 本身
 * 的分支：未连接 / 缺 openId / API 报错 / 成功 / 抛异常。
 *
 * FeishuSessionStore 构造时会调用 electron 的 app.getPath，测试环境需 mock electron。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/feishu-test-userdata' },
}))

const { FeishuLoginService } = await import('./feishu-login-service')

/** 构造一个 pushText 测试专用实例：直接注入私有的 httpClient / session，跳过扫码登录全流程 */
function makeServiceWithSession(params: {
  httpClient?: { im: { message: { create: ReturnType<typeof vi.fn> } } } | null
  openId?: string
}) {
  const service = new FeishuLoginService()
  const instance = service as unknown as {
    httpClient: unknown
    session: { openId?: string } | null
  }
  instance.httpClient = params.httpClient ?? null
  instance.session = params.openId !== undefined ? { openId: params.openId } : null
  return service
}

describe('FeishuLoginService.pushText', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('未连接（httpClient 为空）时返回错误，不调用任何 API', async () => {
    const service = makeServiceWithSession({ httpClient: null })
    const result = await service.pushText('结果')
    expect(result).toEqual({ ok: false, error: '飞书未连接' })
  })

  it('已连接但会话缺少 openId 时返回错误', async () => {
    const create = vi.fn()
    const service = makeServiceWithSession({ httpClient: { im: { message: { create } } }, openId: undefined })
    const result = await service.pushText('结果')
    expect(result).toEqual({ ok: false, error: '飞书会话缺少 openId，请重新扫码登录' })
    expect(create).not.toHaveBeenCalled()
  })

  it('API 返回非 0 code 时返回带 code 和 msg 的错误', async () => {
    const create = vi.fn(async () => ({ code: 99991663, msg: 'param invalid' }))
    const service = makeServiceWithSession({
      httpClient: { im: { message: { create } } },
      openId: 'ou_abc123',
    })
    const result = await service.pushText('结果')
    expect(result).toEqual({ ok: false, error: '飞书返回 99991663: param invalid' })
    expect(create).toHaveBeenCalledWith({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: 'ou_abc123', content: JSON.stringify({ text: '结果' }), msg_type: 'text' },
    })
  })

  it('API 返回 code 0 时推送成功', async () => {
    const create = vi.fn(async () => ({ code: 0, msg: 'success' }))
    const service = makeServiceWithSession({
      httpClient: { im: { message: { create } } },
      openId: 'ou_abc123',
    })
    const result = await service.pushText('早间简报：今天三件事')
    expect(result).toEqual({ ok: true })
  })

  it('API 调用抛异常时捕获并返回错误信息，不向外抛出', async () => {
    const create = vi.fn(async () => {
      throw new Error('网络超时')
    })
    const service = makeServiceWithSession({
      httpClient: { im: { message: { create } } },
      openId: 'ou_abc123',
    })
    const result = await service.pushText('结果')
    expect(result).toEqual({ ok: false, error: '网络超时' })
  })

  it('抛出非 Error 对象时也能返回字符串化的错误信息', async () => {
    const create = vi.fn(async () => {
      throw 'weird failure'
    })
    const service = makeServiceWithSession({
      httpClient: { im: { message: { create } } },
      openId: 'ou_abc123',
    })
    const result = await service.pushText('结果')
    expect(result).toEqual({ ok: false, error: 'weird failure' })
  })
})
