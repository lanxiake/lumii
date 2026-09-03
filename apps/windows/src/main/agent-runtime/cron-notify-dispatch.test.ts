/**
 * dispatchNotifications 的派发分支检查。
 *
 * 只关心「哪些渠道被调到、有没有按渠道策略格式化」，不碰真实 DB/飞书/文件系统：
 * prependActiveDashboardFeedItem 被 mock，其余渠道用 spy 注入。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const prependMock = vi.fn(async () => undefined)
vi.mock('../dashboard-feed-store', () => ({
  prependActiveDashboardFeedItem: prependMock,
}))

const { CronScheduler } = await import('./cron-scheduler')

type Deps = ConstructorParameters<typeof CronScheduler>[1]

function makeScheduler(overrides: Partial<Deps> = {}) {
  const showCronNotification = vi.fn()
  const addMemory = vi.fn()
  const sendFeishuMessage = vi.fn(async () => ({ ok: true }))
  const deps = {
    showCronNotification,
    addMemory,
    sendFeishuMessage,
    getLastActiveConvId: () => null,
    createInstanceById: async () => 'inst',
    prompt: async () => undefined,
    destroy: () => undefined,
    getFileRepo: () => null,
    getCwd: () => 'C:/tmp',
    ...overrides,
  } as unknown as Deps
  const scheduler = new CronScheduler({ isOpen: true, db: {} } as never, deps)
  // dispatchNotifications 是私有方法，测试直接取出调用
  const dispatch = (
    scheduler as unknown as {
      dispatchNotifications: (
        job: { id: string; name: string; task_text: string },
        targets: string | null,
        output: string,
      ) => Promise<void>
    }
  ).dispatchNotifications.bind(scheduler)
  return { dispatch, showCronNotification, addMemory, sendFeishuMessage }
}

const job = { id: 'custom-job', name: '测试提醒', task_text: '汇总今天要做的事' }

describe('dispatchNotifications', () => {
  beforeEach(() => {
    prependMock.mockClear()
  })

  it('未配置 targets 时回落系统通知', async () => {
    const s = makeScheduler()
    await s.dispatch(job, null, '结果')
    expect(s.showCronNotification).toHaveBeenCalledWith('灵栖 · 测试提醒', '结果', 'cron:custom-job')
    expect(s.addMemory).not.toHaveBeenCalled()
    expect(s.sendFeishuMessage).not.toHaveBeenCalled()
    expect(prependMock).not.toHaveBeenCalled()
  })

  it('只勾飞书时不发系统通知，且带任务名前缀', async () => {
    const s = makeScheduler()
    await s.dispatch(job, 'feishu', '结果')
    expect(s.showCronNotification).not.toHaveBeenCalled()
    expect(s.sendFeishuMessage).toHaveBeenCalledWith('【测试提醒】\n结果')
  })

  it('多渠道逐个派发，各渠道拿到自己策略的产出', async () => {
    const s = makeScheduler()
    await s.dispatch(job, 'system,news,focus', '今天三件事')
    expect(s.showCronNotification).toHaveBeenCalledWith('灵栖 · 测试提醒', '今天三件事', 'cron:custom-job')
    expect(s.addMemory).toHaveBeenCalledWith('测试提醒：今天三件事')
    expect(prependMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: '测试提醒', summary: '今天三件事', source: '定时任务' }),
    )
  })

  it('Markdown 正文按渠道降级：通知压单行、飞书保留换行', async () => {
    const s = makeScheduler()
    await s.dispatch(job, 'system,feishu', '## 今天\n\n- 写方案\n- **评审**')
    expect(s.showCronNotification).toHaveBeenCalledWith('灵栖 · 测试提醒', '今天 · 写方案 · 评审', 'cron:custom-job')
    expect(s.sendFeishuMessage).toHaveBeenCalledWith('【测试提醒】\n今天\n\n· 写方案\n· 评审')
  })

  it('企微目标只 warn 跳过，不伪装成功', async () => {
    const s = makeScheduler()
    await expect(s.dispatch(job, 'wecom', '结果')).resolves.toBeUndefined()
    expect(s.showCronNotification).not.toHaveBeenCalled()
  })

  it('单渠道失败不影响其他渠道', async () => {
    prependMock.mockRejectedValueOnce(new Error('磁盘满'))
    const s = makeScheduler()
    await expect(s.dispatch(job, 'news,feishu', '结果')).resolves.toBeUndefined()
    expect(s.sendFeishuMessage).toHaveBeenCalledWith('【测试提醒】\n结果')
  })

  it('任务名为空时用任务指令首句兜底', async () => {
    const s = makeScheduler()
    await s.dispatch({ id: 't-empty', name: '  ', task_text: '汇总今天要做的事' }, 'focus', '结果')
    expect(s.addMemory).toHaveBeenCalledWith('汇总今天要做的事：结果')
  })

  it('feishu 走 channelRouter.send，默认 peer 来自 list', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const list = vi.fn(async () => [
      {
        channel: 'feishu' as const,
        connected: true,
        pushMode: 'native_push' as const,
        peers: [{ id: 'ou_me', label: '我', canSend: true }],
      },
    ])
    const s = makeScheduler({
      getChannelRouter: () => ({ list, send }) as never,
      sendFeishuMessage: undefined,
    })
    await s.dispatch(job, 'feishu', '结果')
    expect(send).toHaveBeenCalledWith({
      channel: 'feishu',
      to: 'ou_me',
      text: '【测试提醒】\n结果',
    })
  })

  it('weixin:peer 走 router.send 且 to 正确', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const list = vi.fn(async () => [])
    const s = makeScheduler({
      getChannelRouter: () => ({ list, send }) as never,
    })
    await s.dispatch(job, 'weixin:wxid_abc', '结果')
    expect(send).toHaveBeenCalledWith({
      channel: 'weixin',
      to: 'wxid_abc',
      text: '【测试提醒】\n结果',
    })
  })

  it('plain weixin 无 peer 时不调用 send', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const s = makeScheduler({
      getChannelRouter: () => ({ list: async () => [], send }) as never,
    })
    await s.dispatch(job, 'weixin', '结果')
    expect(send).not.toHaveBeenCalled()
  })

  it('预置简报/日报/复盘任务不再 focus 写工作记忆', async () => {
    const s = makeScheduler()
    await s.dispatch(
      {
        id: 'seed-daily-report',
        name: '工作日报整理',
        task_text: '整理我今天的工作进度，生成一份简短日报。',
      },
      'focus',
      '今天完成\n- 修了 bug',
    )
    expect(s.addMemory).not.toHaveBeenCalled()
  })
})
