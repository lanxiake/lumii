import { describe, expect, it, vi } from 'vitest'
import {
  followComfyJob,
  parseEnqueuedPromptId,
  parseHistoryOutputs,
  resolveComfyBaseUrl,
} from './comfyui-job-follower'

const HISTORY_OK = [
  '## Execution: p-1',
  '**Status**: success | Completed: true',
  '**Duration**: 312.40s',
  '',
  '### Outputs (2 nodes)',
  '- Node 9: videos → **video/Wan_00001.mp4 (type=output)**',
  '- Node 12:',
  '  - images → **preview_0001.png (type=temp), b.png (type=output)**',
  '  - animated: true',
].join('\n')

/** 立即返回的 sleep：测试里不真等轮询间隔 */
const noSleep = async (): Promise<void> => {}

describe('parseEnqueuedPromptId', () => {
  it('认出 enqueue_workflow / generate_image 的「已入队」回执', () => {
    const text = JSON.stringify({ status: 'enqueued', prompt_id: 'abc-123', queue_remaining: 1 }, null, 2)
    expect(parseEnqueuedPromptId(text)).toBe('abc-123')
  })

  it('已带产出的结果（wait:true）、非 JSON、缺 prompt_id 都不算入队回执', () => {
    expect(parseEnqueuedPromptId(JSON.stringify({ prompt_id: 'x', outputs: {} }))).toBeNull()
    expect(parseEnqueuedPromptId('已完成，见 ComfyUI_0001.png')).toBeNull()
    expect(parseEnqueuedPromptId(JSON.stringify({ status: 'enqueued' }))).toBeNull()
    expect(parseEnqueuedPromptId('')).toBeNull()
  })
})

describe('parseHistoryOutputs', () => {
  it('解析视频/图片产出：原始地址给人点，代理地址给 img/video 加载', () => {
    const outputs = parseHistoryOutputs(HISTORY_OK, 'https://cfui.example.com/')
    // ComfyUI /view 需要 Basic Auth，<img>/<video> 带不上头 —— 预览必须走 lumii-remote 代理，
    // 否则渲染层拿到 401、预览区一片空白（2026-10-24 用户实测）
    const unwrap = (url?: string): string | null => (url ? new URL(url).searchParams.get('src') : null)
    expect(outputs.map((o) => ({ name: o.name, path: o.path, kind: o.kind, url: o.url, src: unwrap(o.previewUrl) }))).toEqual([
      {
        name: 'Wan_00001.mp4',
        path: 'video/Wan_00001.mp4',
        kind: 'video',
        url: 'https://cfui.example.com/view?filename=Wan_00001.mp4&subfolder=video&type=output',
        src: 'https://cfui.example.com/view?filename=Wan_00001.mp4&subfolder=video&type=output',
      },
      {
        name: 'preview_0001.png',
        path: 'preview_0001.png',
        kind: 'image',
        url: 'https://cfui.example.com/view?filename=preview_0001.png&subfolder=&type=temp',
        src: 'https://cfui.example.com/view?filename=preview_0001.png&subfolder=&type=temp',
      },
      {
        name: 'b.png',
        path: 'b.png',
        kind: 'image',
        url: 'https://cfui.example.com/view?filename=b.png&subfolder=&type=output',
        src: 'https://cfui.example.com/view?filename=b.png&subfolder=&type=output',
      },
    ])
    for (const output of outputs) {
      expect(output.previewUrl?.startsWith('lumii-remote://media/?src=')).toBe(true)
    }
  })

  it('没有服务地址时只给文件名，不编造链接', () => {
    const [first] = parseHistoryOutputs(HISTORY_OK)
    expect(first).toEqual({ name: 'Wan_00001.mp4', path: 'video/Wan_00001.mp4', kind: 'video' })
  })

  it('images 键下的 mp4/webm 按扩展名归为视频', () => {
    const [first] = parseHistoryOutputs('- Node 3: images → **clip.webm (type=output)**')
    expect(first?.kind).toBe('video')
  })
})

describe('resolveComfyBaseUrl', () => {
  it('只认字面量 http(s) 地址，去掉末尾斜杠', () => {
    expect(resolveComfyBaseUrl({ COMFYUI_URL: 'https://cfui.cpolar.top/' })).toBe('https://cfui.cpolar.top')
    expect(resolveComfyBaseUrl({ COMFYUI_URL: '${COMFY_HOST}' })).toBeUndefined()
    expect(resolveComfyBaseUrl({ COMFYUI_URL: 'cfui.cpolar.top' })).toBeUndefined()
    expect(resolveComfyBaseUrl(undefined)).toBeUndefined()
  })
})

describe('followComfyJob', () => {
  it('排队 → 渲染 → 完成：返回历史文本与产出，并上报进度', async () => {
    const statuses = [
      { running: false, pending: true, done: false },
      { running: true, pending: false, done: false },
      { running: false, pending: false, done: true, status_str: 'success' },
    ]
    const callTool = vi.fn(async (tool: string) => {
      if (tool === 'queue') return JSON.stringify(statuses.shift())
      if (tool === 'get_history') return HISTORY_OK
      throw new Error(`unexpected ${tool}`)
    })
    const progress: string[] = []

    const outcome = await followComfyJob({
      promptId: 'p-1',
      callTool,
      signal: new AbortController().signal,
      baseUrl: 'https://cfui.example.com',
      sleep: noSleep,
      onProgress: (note) => progress.push(note),
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.text).toContain('Wan_00001.mp4')
    expect(outcome.outputs.map((o) => o.name)).toEqual(['Wan_00001.mp4', 'preview_0001.png', 'b.png'])
    expect(callTool).toHaveBeenCalledWith('queue', { action: 'status', prompt_id: 'p-1' })
    expect(callTool).toHaveBeenCalledWith('get_history', { action: 'list', prompt_id: 'p-1' })
    expect(progress).toEqual(['ComfyUI 排队中', 'ComfyUI 渲染中'])
  })

  it('执行报错：判失败，带上错误详情', async () => {
    const callTool = vi.fn(async (tool: string) => {
      if (tool === 'queue') {
        return JSON.stringify({ done: true, status_str: 'error', error: { message: 'OOM' } })
      }
      return '## Execution: p-2\n**Status**: error | Completed: false\n**Exception**: CUDA out of memory'
    })
    const outcome = await followComfyJob({
      promptId: 'p-2',
      callTool,
      signal: new AbortController().signal,
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('CUDA out of memory')
  })

  it('ComfyUI 查无此任务（重启丢失）：判失败而不是一直等', async () => {
    const callTool = vi.fn(async () =>
      JSON.stringify({ running: false, pending: false, done: false, found: false, message: 'no record' }),
    )
    const outcome = await followComfyJob({
      promptId: 'p-3',
      callTool,
      signal: new AbortController().signal,
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('no record')
  })

  it('偶发查询失败可容忍，连续失败超过上限才判失败', async () => {
    let calls = 0
    const callTool = vi.fn(async (tool: string) => {
      if (tool === 'get_history') return HISTORY_OK
      calls += 1
      if (calls <= 2) throw new Error('timeout')
      return JSON.stringify({ done: true, status_str: 'success' })
    })
    const ok = await followComfyJob({
      promptId: 'p-4',
      callTool,
      signal: new AbortController().signal,
      sleep: noSleep,
      maxConsecutiveErrors: 3,
    })
    expect(ok.ok).toBe(true)

    const alwaysFail = vi.fn(async () => {
      throw new Error('MCP Server [comfyui-remote] 未连接')
    })
    const failed = await followComfyJob({
      promptId: 'p-5',
      callTool: alwaysFail,
      signal: new AbortController().signal,
      sleep: noSleep,
      maxConsecutiveErrors: 3,
    })
    expect(failed.ok).toBe(false)
    expect(failed.text).toContain('未连接')
    expect(alwaysFail).toHaveBeenCalledTimes(3)
  })

  it('中断信号：立即停止轮询并抛出', async () => {
    const controller = new AbortController()
    const callTool = vi.fn(async () => {
      controller.abort()
      return JSON.stringify({ running: true, pending: false, done: false })
    })
    await expect(
      followComfyJob({ promptId: 'p-6', callTool, signal: controller.signal, sleep: noSleep }),
    ).rejects.toThrow(/中断/)
    expect(callTool).toHaveBeenCalledTimes(1)
  })
})
