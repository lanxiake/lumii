/**
 * bridge-screen-record-tools 单测
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ToolRegistry, type ToolExecutionContext } from '@mtbot/agent-runtime'
import { registerScreenRecordTools } from './bridge-screen-record-tools'
import { parseJsonToolResultPayload } from './bridge-utils'
import type { ScreenRecordService } from '../screen-record'

/** 最小 ToolExecutionContext stub */
function stubContext(): ToolExecutionContext {
  return {
    executeCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    readFile: async () => '',
    writeFile: async () => {},
    glob: async () => [],
    grep: async () => [],
    fetch: async () => ({ status: 200, body: '' }),
    getCwd: () => '/',
  }
}

describe('registerScreenRecordTools', () => {
  let registry: ToolRegistry
  let svc: {
    listSources: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    pause: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    mark: ReturnType<typeof vi.fn>
    getStatus: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    registry = new ToolRegistry()
    svc = {
      listSources: vi.fn(async () => ({ ok: true, sources: [] })),
      start: vi.fn(async () => ({
        ok: true,
        status: 'recording',
        sessionId: 's1',
        startedAt: 1,
      })),
      stop: vi.fn(async () => ({ ok: false, error: 'no_active_session' })),
      pause: vi.fn(async () => ({ ok: false, error: 'not_recording' })),
      resume: vi.fn(async () => ({ ok: false, error: 'not_paused' })),
      mark: vi.fn(() => ({ ok: false, error: 'not_recording' })),
      getStatus: vi.fn(() => ({ ok: true, status: 'idle' })),
    }
    registerScreenRecordTools(registry, stubContext(), {
      getService: () => svc as unknown as ScreenRecordService,
    })
  })

  it('注册九工具名（含 mark/inspect/narrate）', () => {
    const names = registry.getAll().map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'screen_record_list_sources',
        'screen_record_start',
        'screen_record_stop',
        'screen_record_status',
        'screen_record_pause',
        'screen_record_resume',
        'screen_record_mark',
        'screen_record_inspect',
        'screen_record_narrate',
      ]),
    )
    expect(names).toHaveLength(9)
  })

  it('pause 透传 not_recording', async () => {
    const tool = registry.get('screen_record_pause')!
    const r = await tool.execute('1', {})
    const payload = parseJsonToolResultPayload(r)
    expect(payload).toMatchObject({ ok: false, error: 'not_recording' })
  })

  it('resume 透传 not_paused', async () => {
    const tool = registry.get('screen_record_resume')!
    const r = await tool.execute('1', {})
    const payload = parseJsonToolResultPayload(r)
    expect(payload).toMatchObject({ ok: false, error: 'not_paused' })
  })

  it('mark 透传 not_recording', async () => {
    const tool = registry.get('screen_record_mark')!
    const r = await tool.execute('1', { label: '开场' })
    const payload = parseJsonToolResultPayload(r)
    expect(payload).toMatchObject({ ok: false, error: 'not_recording' })
    expect(svc.mark).toHaveBeenCalledWith({ label: '开场', kind: undefined })
  })

  it('inspect 路径不在 recordings → source_not_in_recordings', async () => {
    const tool = registry.get('screen_record_inspect')!
    const r = await tool.execute('1', { path: 'C:/Windows/Temp/not-in-recordings.webm' })
    const payload = parseJsonToolResultPayload(r)
    expect(payload).toMatchObject({ ok: false, error: 'source_not_in_recordings' })
  })

  it('narrate 描述不再承诺 *-narrated.webm，并说明就地覆盖', () => {
    const tool = registry.get('screen_record_narrate')!
    expect(tool.description).toContain('就地')
    expect(tool.description).not.toContain('*-narrated.webm')
  })

  it('list_sources includeThumbnail 默认 false', async () => {
    const tool = registry.get('screen_record_list_sources')!
    await tool.execute('1', {})
    expect(svc.listSources).toHaveBeenCalledWith(false)
  })

  it('start maxDurationSec 超 7200 截断', async () => {
    const tool = registry.get('screen_record_start')!
    await tool.execute('1', { sourceId: 'x', maxDurationSec: 99999 })
    expect(svc.start).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'x', maxDurationSec: 7200 }),
    )
  })

  it('stop idle 透传 no_active_session', async () => {
    const tool = registry.get('screen_record_stop')!
    const r = await tool.execute('1', {})
    const payload = parseJsonToolResultPayload(r)
    expect(payload).toMatchObject({ ok: false, error: 'no_active_session' })
  })

  it('getService null → disabled', async () => {
    const reg2 = new ToolRegistry()
    registerScreenRecordTools(reg2, stubContext(), { getService: () => null })
    const tool = reg2.get('screen_record_start')!
    const r = await tool.execute('1', { sourceId: 'a' })
    const payload = parseJsonToolResultPayload(r)
    expect(payload).toMatchObject({ ok: false, error: 'disabled' })
  })
})
