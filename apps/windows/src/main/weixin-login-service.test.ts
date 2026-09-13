/**
 * WeixinLoginService.sendTextReply 单元测试。
 *
 * sendTextReply 现在承担「编译 + 分段发送」：Markdown 先编译为手机友好文本
 * （单段 ≤1000 字、最多 5 段），段间加间隔，某段失败即停止后续段。
 * WeixinSessionStore 构造会调 electron app.getPath，测试环境需 mock electron；
 * apiSendTextChunk 走真实网络，需 mock。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/weixin-test-userdata' },
}))

vi.mock('./weixin-media-reply.js', () => ({
  apiSendTextChunk: vi.fn(async () => true),
  sendMediaReply: vi.fn(async () => true),
}))

const { WeixinLoginService } = await import('./weixin-login-service')
const { apiSendTextChunk } = await import('./weixin-media-reply.js')

const sendChunk = vi.mocked(apiSendTextChunk)

/** 注入假 sessionStore，避免读真实用户数据目录 */
function makeService() {
  const service = new WeixinLoginService()
  ;(service as unknown as { sessionStore: unknown }).sessionStore = {
    loadSession: async () => ({ botToken: 'bt', baseUrl: 'https://ilink.test' }),
  }
  return service
}

/** 单段超 1000 字的长文，编译后应拆成多段 */
function longText(): string {
  const p1 = `第一段${'甲'.repeat(600)}`
  const p2 = `第二段${'乙'.repeat(600)}`
  return `${p1}\n\n${p2}`
}

describe('WeixinLoginService.sendTextReply', () => {
  beforeEach(() => {
    sendChunk.mockClear()
    sendChunk.mockImplementation(async () => true)
  })

  it('短文本编译为单条，Markdown 记号已降级', async () => {
    const ok = await makeService().sendTextReply('u1', '**完成**了', 'ctx')
    expect(ok).toBe(true)
    expect(sendChunk).toHaveBeenCalledTimes(1)
    expect(sendChunk.mock.calls[0]?.[2]).toBe('完成了')
  })

  it('长文本按段落分多条发送，每段 ≤1000 字', async () => {
    const ok = await makeService().sendTextReply('u1', longText(), 'ctx')
    expect(ok).toBe(true)
    expect(sendChunk).toHaveBeenCalledTimes(2)
    for (const call of sendChunk.mock.calls) {
      expect((call[2] as string).length).toBeLessThanOrEqual(1000)
    }
    expect(sendChunk.mock.calls[0]?.[2]).toContain('第一段')
    expect(sendChunk.mock.calls[1]?.[2]).toContain('第二段')
  })

  it('缺少 contextToken 时返回 false 且不发请求', async () => {
    const ok = await makeService().sendTextReply('u1', '内容', '')
    expect(ok).toBe(false)
    expect(sendChunk).not.toHaveBeenCalled()
  })

  it('某段失败后停止发送后续段', async () => {
    sendChunk.mockImplementation(async () => false)
    const ok = await makeService().sendTextReply('u1', longText(), 'ctx')
    expect(ok).toBe(false)
    expect(sendChunk).toHaveBeenCalledTimes(1)
  })
})
