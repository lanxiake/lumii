/**
 * QbotLoginService.replyMarkdown / replyText 单元测试。
 *
 * replyMarkdown 走 msg_type=2（Markdown），QQ 平台未开通该能力时服务端会拒，
 * 需降级 msg_type=0 纯文本重发一次（行为与旧版一致，不丢消息）。
 * QbotSessionStore 构造会调 electron app.getPath，测试环境需 mock electron。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qbot-test-userdata' },
}))

const { QbotLoginService } = await import('./qbot-login-service')

function makeService() {
  const service = new QbotLoginService()
  ;(service as unknown as { accessToken: string | null }).accessToken = 'tok'
  return service
}

function okResponse() {
  return { ok: true, status: 200, text: async () => '' }
}

function errResponse(status = 400) {
  return { ok: false, status, text: async () => 'markdown not allowed' }
}

/** 取出第 n 次 fetch 的请求体 */
function requestBody(fetchMock: ReturnType<typeof vi.fn>, n: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[n]?.[1] as { body: string }
  return JSON.parse(init.body) as Record<string, unknown>
}

describe('QbotLoginService.replyMarkdown', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('成功时发 msg_type=2，content 为编译后的 markdown', async () => {
    const ok = await makeService().replyMarkdown('user1', '# 标题\n\n正文')
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/v2/users/user1/messages')
    const body = requestBody(fetchMock, 0)
    expect(body.msg_type).toBe(2)
    expect(body.content).toBe('# 标题\n\n正文')
  })

  it('平台拒绝 markdown 时降级纯文本重发一次', async () => {
    let n = 0
    fetchMock.mockImplementation(async () => {
      n += 1
      return n === 1 ? errResponse(400) : okResponse()
    })
    const ok = await makeService().replyMarkdown('user1', '# 标题\n\n**正文**')
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const body = requestBody(fetchMock, 1)
    expect(body.msg_type).toBe(0)
    expect(body.content).toBe('标题\n\n正文')
  })

  it('两次都失败时返回 false', async () => {
    fetchMock.mockImplementation(async () => errResponse(400))
    const ok = await makeService().replyMarkdown('user1', '正文')
    expect(ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('缺少 accessToken 时不发请求', async () => {
    const service = new QbotLoginService()
    const ok = await service.replyMarkdown('user1', '正文')
    expect(ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('QbotLoginService.replyText 回归', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('仍发 msg_type=0 纯文本', async () => {
    const ok = await makeService().replyText('user1', '**原样**')
    expect(ok).toBe(true)
    const body = requestBody(fetchMock, 0)
    expect(body.msg_type).toBe(0)
    expect(body.content).toBe('**原样**')
  })
})
