import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileMemoryHandler } from './file-memory-handler'

describe('FileMemoryHandler', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  /** 创建临时 workspace 与可注入的 handler 依赖 */
  function createHarness() {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-fmh-'))
    tempDirs.push(cwd)
    const outputsDir = path.join(cwd, 'outputs')
    fs.mkdirSync(outputsDir, { recursive: true })

    const registered: Array<{ fileName: string; localPath: string }> = []
    const events: unknown[] = []
    const fileRepo = {
      registerOrUpdate: vi.fn((input: { fileName: string; localPath: string }) => {
        registered.push({ fileName: input.fileName, localPath: input.localPath })
        return `file-${registered.length}`
      }),
    }

    const instanceToConversation = new Map<string, string>([['inst-1', 'conv-1']])
    const instanceStates = new Map([
      ['inst-1', { ctx: { sessionKey: 'agent-1' }, streamingAssistantMsgId: 'msg-1' }],
    ])

    const handler = new FileMemoryHandler({
      getFileRepo: () => fileRepo as never,
      getCwd: () => cwd,
      instanceToConversation,
      instanceStates: instanceStates as never,
      forwardIpcEvent: (event) => {
        events.push(event)
      },
    })

    return { cwd, outputsDir, handler, registered, events, fileRepo }
  }

  it('scanAndRegisterOutputs 扫描 cwd/outputs 而非 cwd/workspace/outputs', async () => {
    const { outputsDir, handler, registered, events } = createHarness()
    const pdfPath = path.join(outputsDir, '合并_同意函+户口本.pdf')
    fs.writeFileSync(pdfPath, '%PDF-1.4')

    await handler.scanAndRegisterOutputs('inst-1', Date.now() - 60_000)

    expect(registered).toEqual([
      { fileName: '合并_同意函+户口本.pdf', localPath: 'outputs/合并_同意函+户口本.pdf' },
    ])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'agent:file:created',
      fileName: '合并_同意函+户口本.pdf',
      localPath: 'outputs/合并_同意函+户口本.pdf',
      category: 'output',
    })
  })

  it('handleFileWritten 将相对路径锚定到 agent cwd', async () => {
    const { cwd, outputsDir, handler, registered } = createHarness()
    const pdfPath = path.join(outputsDir, 'out.pdf')
    fs.writeFileSync(pdfPath, '%PDF-1.4')

    await handler.handleFileWritten('inst-1', { filePath: 'outputs/out.pdf' })

    expect(registered).toEqual([{ fileName: 'out.pdf', localPath: 'outputs/out.pdf' }])
    // 确认未误用 process.cwd() 拼出错误绝对路径
    expect(path.isAbsolute(path.join(cwd, 'outputs', 'out.pdf'))).toBe(true)
  })

  it('handleFileWritten 拒绝越出 workspace 的路径', async () => {
    const { handler, registered } = createHarness()
    await handler.handleFileWritten('inst-1', { filePath: '../outside.txt' })
    expect(registered).toEqual([])
  })
})
