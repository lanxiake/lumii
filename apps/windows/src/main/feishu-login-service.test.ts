/**
 * FeishuLoginService.pushText / pushMedia 单元测试
 *
 * pushText 是定时任务「飞书」通知目标的实际推送路径（cron-scheduler.ts 的
 * dispatchNotifications 通过 sendFeishuMessage 依赖注入调用它）。
 * cron-notify-dispatch.test.ts 只 mock 掉了这个依赖，没有覆盖 pushText 本身
 * 的分支：未连接 / 缺 openId / API 报错 / 成功 / 抛异常。
 *
 * pushMedia 的关键约束：飞书要求上传素材时的 file_type 与发送消息的 msg_type
 * 严格匹配，不匹配会返回 HTTP 400 / code 230055（mp4 必须发 media、opus 必须发 audio）。
 *
 * FeishuSessionStore 构造时会调用 electron 的 app.getPath，测试环境需 mock electron。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

/** 拼一个 pushMedia 用的绝对路径；文件不需要真实存在，读流已被 mock */
function fakeMediaPath(fileName: string): string {
  return path.join(os.tmpdir(), 'lumii-feishu-media', fileName)
}

/** 构造带 im.file / im.image / im.message mock 的实例，用于 pushMedia 分支测试 */
function makeMediaService() {
  // 标注入参类型：否则 vi.fn 推出的 mock.calls 元素为空元组 []，
  // 断言 calls[0]?.[0] 会因索引越界而报 TS2493
  const fileCreate = vi.fn(async (_req?: unknown) => ({
    code: 0,
    msg: 'success',
    data: { file_key: 'file_v3_abc' },
  }))
  const imageCreate = vi.fn(async (_req?: unknown) => ({
    code: 0,
    msg: 'success',
    data: { image_key: 'img_v2_abc' },
  }))
  const messageCreate = vi.fn(async (_req?: unknown) => ({ code: 0, msg: 'success' }))
  const service = new FeishuLoginService()
  const instance = service as unknown as {
    httpClient: unknown
    session: { openId?: string } | null
  }
  instance.httpClient = {
    im: {
      file: { create: fileCreate },
      image: { create: imageCreate },
      message: { create: messageCreate },
    },
  }
  instance.session = { openId: 'ou_abc123' }
  return { service, fileCreate, imageCreate, messageCreate }
}

describe('FeishuLoginService.pushMedia', () => {
  beforeAll(() => {
    // 上传素材只关心传参，避免真实开流导致的异步 ENOENT
    vi.spyOn(fs, 'createReadStream').mockImplementation(
      ((filePath: string) => ({ mockedStreamOf: filePath })) as never,
    )
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mp4 以 file_type=mp4 上传后必须用 msg_type=media 发送（否则飞书报 230055）', async () => {
    const { service, fileCreate, messageCreate } = makeMediaService()
    const result = await service.pushMedia(fakeMediaPath('演示视频.mp4'))

    expect(result).toEqual({ ok: true })
    expect(fileCreate.mock.calls[0]?.[0]).toMatchObject({
      data: { file_type: 'mp4', file_name: '演示视频.mp4' },
    })
    expect(messageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: 'ou_abc123',
        msg_type: 'media',
        content: JSON.stringify({ file_key: 'file_v3_abc' }),
      },
    })
  })

  it('opus 以 file_type=opus 上传后必须用 msg_type=audio 发送', async () => {
    const { service, fileCreate, messageCreate } = makeMediaService()
    const result = await service.pushMedia(fakeMediaPath('语音.opus'))

    expect(result).toEqual({ ok: true })
    expect(fileCreate.mock.calls[0]?.[0]).toMatchObject({ data: { file_type: 'opus' } })
    expect(messageCreate.mock.calls[0]?.[0]).toMatchObject({ data: { msg_type: 'audio' } })
  })

  it('pdf 等文档仍以 msg_type=file 发送', async () => {
    const { service, fileCreate, messageCreate } = makeMediaService()
    const result = await service.pushMedia(fakeMediaPath('说明.pdf'))

    expect(result).toEqual({ ok: true })
    expect(fileCreate.mock.calls[0]?.[0]).toMatchObject({ data: { file_type: 'pdf' } })
    expect(messageCreate.mock.calls[0]?.[0]).toMatchObject({ data: { msg_type: 'file' } })
  })

  it('mp4 之外的视频格式回落为 stream 上传 + msg_type=file，避免类型不匹配', async () => {
    const { service, fileCreate, messageCreate } = makeMediaService()
    const result = await service.pushMedia(fakeMediaPath('录屏.mkv'))

    expect(result).toEqual({ ok: true })
    expect(fileCreate.mock.calls[0]?.[0]).toMatchObject({ data: { file_type: 'stream' } })
    expect(messageCreate.mock.calls[0]?.[0]).toMatchObject({ data: { msg_type: 'file' } })
  })

  it('图片走 im.image 上传并以 msg_type=image 发送', async () => {
    const { service, imageCreate, fileCreate, messageCreate } = makeMediaService()
    const result = await service.pushMedia(fakeMediaPath('封面.png'))

    expect(result).toEqual({ ok: true })
    expect(imageCreate).toHaveBeenCalledTimes(1)
    expect(fileCreate).not.toHaveBeenCalled()
    expect(messageCreate.mock.calls[0]?.[0]).toMatchObject({
      data: { msg_type: 'image', content: JSON.stringify({ image_key: 'img_v2_abc' }) },
    })
  })

  it('fileName 参数决定素材类型判定，与真实路径后缀无关', async () => {
    const { service, fileCreate, messageCreate } = makeMediaService()
    const result = await service.pushMedia(fakeMediaPath('tmp-blob.bin'), 'ou_target', '成片.mp4')

    expect(result).toEqual({ ok: true })
    expect(fileCreate.mock.calls[0]?.[0]).toMatchObject({
      data: { file_type: 'mp4', file_name: '成片.mp4' },
    })
    expect(messageCreate.mock.calls[0]?.[0]).toMatchObject({
      data: { receive_id: 'ou_target', msg_type: 'media' },
    })
  })
})
