import { describe, expect, it, vi, beforeEach } from 'vitest'

const { loadMock, saveMock } = vi.hoisted(() => ({ loadMock: vi.fn(), saveMock: vi.fn() }))
vi.mock('../config/mcp-config', () => ({
  loadMcpServerConfigs: loadMock,
  saveMcpServerConfigs: saveMock,
}))

import { runWechatSelfcheck, writeWechatDbToConfig } from './wechat-selfcheck'

const ROOT = 'D:\\微信\\xwechat_files\\wxid_a_1234\\db_storage'

function okCall() {
  return vi.fn(async (_s: string, tool: string) =>
    tool === 'check_env'
      ? JSON.stringify({ ok: true, reason: '', weixin_running: true })
      : JSON.stringify({ found: true, root: ROOT, source: 'ini', wxid: 'wxid_a' }),
  )
}

describe('writeWechatDbToConfig', () => {
  beforeEach(() => {
    loadMock.mockReset()
    saveMock.mockReset()
  })

  it('配置里没有 LUMII_WECHAT_DB ⇒ 补写并落盘', () => {
    loadMock.mockReturnValue([{ name: 'wechat-local', command: 'x.exe', enabled: true }])
    expect(writeWechatDbToConfig(ROOT)).toBe(true)
    expect(saveMock).toHaveBeenCalledTimes(1)
    const written = saveMock.mock.calls[0]![0] as Array<{ env?: Record<string, string> }>
    expect(written[0]!.env?.LUMII_WECHAT_DB).toBe(ROOT)
  })

  it('用户已显式填过 ⇒ 绝不覆盖', () => {
    loadMock.mockReturnValue([
      { name: 'wechat-local', command: 'x.exe', enabled: true, env: { LUMII_WECHAT_DB: 'C:\\mine' } },
    ])
    expect(writeWechatDbToConfig(ROOT)).toBe(false)
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('没有 wechat-local 条目 ⇒ 不写', () => {
    loadMock.mockReturnValue([])
    expect(writeWechatDbToConfig(ROOT)).toBe(false)
    expect(saveMock).not.toHaveBeenCalled()
  })
})

describe('runWechatSelfcheck', () => {
  beforeEach(() => {
    loadMock.mockReset()
    saveMock.mockReset()
    loadMock.mockReturnValue([{ name: 'wechat-local', command: 'x.exe', enabled: true }])
  })

  it('数据目录找到 + 环境 ok ⇒ ok=true，且补写了配置', async () => {
    const out = await runWechatSelfcheck(okCall())
    expect(out.connected).toBe(true)
    expect(out.ok).toBe(true)
    expect(out.db).toMatchObject({ ok: true, root: ROOT, source: 'ini', wxid: 'wxid_a' })
    expect(out.actions.join()).toContain('写入 MCP 配置')
    expect(saveMock).toHaveBeenCalledTimes(1)
  })

  it('writeConfig=false ⇒ 只自检不写配置', async () => {
    const out = await runWechatSelfcheck(okCall(), { writeConfig: false })
    expect(out.ok).toBe(true)
    expect(saveMock).not.toHaveBeenCalled()
    expect(out.actions).toEqual([])
  })

  it('MCP 未连接 ⇒ connected=false、ok=false、reason 点名', async () => {
    const call = vi.fn(async () => {
      throw new Error('MCP Server [wechat-local] 未连接')
    })
    const out = await runWechatSelfcheck(call)
    expect(out.connected).toBe(false)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('未连接')
  })

  it('数据目录没找到 ⇒ db.ok=false，reason 指向目录', async () => {
    const call = vi.fn(async (_s: string, tool: string) =>
      tool === 'check_env'
        ? JSON.stringify({ ok: true, reason: '' })
        : JSON.stringify({ found: false, root: null, source: null }),
    )
    const out = await runWechatSelfcheck(call)
    expect(out.db.ok).toBe(false)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('数据目录')
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('环境不可用（窗口最小化）⇒ ok=false，reason 用 check_env 的 reason', async () => {
    const call = vi.fn(async (_s: string, tool: string) =>
      tool === 'check_env'
        ? JSON.stringify({ ok: false, reason: '主窗口已最小化' })
        : JSON.stringify({ found: true, root: ROOT, source: 'ini', wxid: 'wxid_a' }),
    )
    const out = await runWechatSelfcheck(call)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('最小化')
  })
})
