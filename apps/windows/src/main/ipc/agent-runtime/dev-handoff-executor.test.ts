/**
 * 转交执行器：项目上下文（09-P2）与绑定预检（09-P3）。
 *
 * P2：项目名写入**开发会话**的 dev-context——这是「转交后 cwd 落在项目目录」的唯一通道
 *     （`codingDevProjects` 本身不参与 `resolveDevContext` 解析）。
 * P3：未绑定编码工具时**明确失败**，不静默降级为 pi 内核——pi 路径不消费 `projectPath`，
 *     放行会让任务在错误目录里跑，而用户以为转交成功了。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('./conversation-commands', () => ({
  handleConversationCreate: vi.fn(async () => ({ sessionKey: 'dev-session-1', title: '开发任务' })),
  handleConversationList: vi.fn(() => []),
}))
vi.mock('./user-commands', () => ({
  handleUserSend: vi.fn(async () => ({ runId: 'run-1' })),
}))

import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { getDevContext, setDevContext, setDevContextBaseDir } from '../../coding-dev-dev-context'
import { setCodingDevConfigGetter } from '../../coding-dev-env'
import { handleConversationCreate, handleConversationList } from './conversation-commands'
import { setAcpBackendManagerGetter } from './coding-dev-commands'
import { NO_CLI_BINDING_HINT, runDevHandoff, type DevHandoffReport } from './dev-handoff-executor'
import { handleUserSend } from './user-commands'

/** 会话消息快照：用例可在 runDevHandoff 发起后改写它，模拟「ACP 把结果/错误落库」 */
type MessageSnapshot = { messages: unknown[] }

function makeBridge(snapshot: MessageSnapshot = { messages: [] }): AgentRuntimeBridge {
  return {
    conversationRepo: {
      getConversation: () => ({ title: '开发任务' }),
      loadRecentMessages: () => snapshot.messages,
    },
    hasStreamingMessages: () => false,
  } as unknown as AgentRuntimeBridge
}

/** 已绑定：code-dev → claude CLI */
function bindCli(): void {
  setCodingDevConfigGetter(() => ({
    codingDevProjects: [{ name: 'lumii', realPath: 'C:/work/lumii', isExternal: true }],
    codingDevAgentBindings: [
      { agentId: 'code-dev', backendId: 'claude', workspace: 'C:/work/lumii', enabled: true },
    ],
  }))
}

/** user-global 后端选择（未配 Agent 绑定时的回落值） */
function setUserGlobalBackend(id: string): void {
  setAcpBackendManagerGetter(() => ({ getBackend: () => id }) as never)
}

function newTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('runDevHandoff · 项目上下文（P2）', () => {
  let dir: string

  beforeEach(() => {
    dir = newTempDir('lumii-handoff-')
    setDevContextBaseDir(dir)
    vi.clearAllMocks()
    bindCli()
    setUserGlobalBackend('lumii')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('指定项目时写入开发会话的 dev-context', async () => {
    await runDevHandoff({
      bridge: makeBridge(),
      task: '根据项目代码评审这份方案',
      sessionMode: 'new',
      title: '评审新手指引方案',
      projectName: 'lumii',
      report: () => {},
    })

    expect(getDevContext('dev-session-1')?.projectName).toBe('lumii')
  })

  it('未指定项目时不写 dev-context（不覆盖会话既有选择）', async () => {
    await runDevHandoff({
      bridge: makeBridge(),
      task: 't',
      sessionMode: 'new',
      title: 's',
      report: () => {},
    })

    expect(getDevContext('dev-session-1')).toBeUndefined()
  })

  it('dev-context 在发起任务消息之前写入（首个回合即命中）', async () => {
    const seenAtSend: Array<string | undefined> = []
    vi.mocked(handleUserSend).mockImplementation(async () => {
      seenAtSend.push(getDevContext('dev-session-1')?.projectName)
      return { runId: 'run-1' }
    })

    await runDevHandoff({
      bridge: makeBridge(),
      task: 't',
      sessionMode: 'new',
      title: 's',
      projectName: 'blog',
      report: () => {},
    })

    expect(seenAtSend).toEqual(['blog'])
  })
})

describe('runDevHandoff · 绑定预检（P3）', () => {
  let dir: string

  beforeEach(() => {
    dir = newTempDir('lumii-handoff-precheck-')
    setDevContextBaseDir(dir)
    vi.clearAllMocks()
    setUserGlobalBackend('lumii')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('未绑定（无 Agent 绑定且 user-global 为 lumii）→ 不建会话、不发消息，汇报可操作指引', async () => {
    setCodingDevConfigGetter(() => ({}))

    const reports: DevHandoffReport[] = []
    const res = await runDevHandoff({
      bridge: makeBridge(),
      task: 't',
      sessionMode: 'new',
      title: 's',
      projectName: 'lumii',
      report: (p) => void reports.push(p),
    })

    expect(handleConversationCreate).not.toHaveBeenCalled()
    expect(handleUserSend).not.toHaveBeenCalled()
    expect(reports).toHaveLength(1)
    expect(reports[0]!.ok).toBe(false)
    expect(reports[0]!.text).toBe(NO_CLI_BINDING_HINT)
    expect(res.devSessionKey).toBe('')
  })

  it('user-global 配了 CLI 时放行（不必配 code-dev 的 Agent 绑定）', async () => {
    setCodingDevConfigGetter(() => ({}))
    setUserGlobalBackend('claude')

    await runDevHandoff({
      bridge: makeBridge(),
      task: 't',
      sessionMode: 'new',
      title: 's',
      report: () => {},
    })

    expect(handleUserSend).toHaveBeenCalled()
  })

  it('已绑定时正常发起（回归保护）', async () => {
    bindCli()

    await runDevHandoff({
      bridge: makeBridge(),
      task: 't',
      sessionMode: 'new',
      title: 's',
      report: () => {},
    })

    expect(handleConversationCreate).toHaveBeenCalled()
    expect(handleUserSend).toHaveBeenCalled()
  })

  it('recent 模式下会话级压制为 lumii 时同样拒绝（会话级优先于全局）', async () => {
    setCodingDevConfigGetter(() => ({}))
    setUserGlobalBackend('claude') // 全局有 CLI，但该会话被显式压制
    vi.mocked(handleConversationList).mockReturnValue([
      {
        id: 'dev-conv-1',
        sessionKey: 'dev-conv-1',
        agentId: 'code-dev',
        title: '既有开发会话',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as never,
    ])
    setDevContext('dev-conv-1', { backendId: 'lumii' })

    const reports: DevHandoffReport[] = []
    await runDevHandoff({
      bridge: makeBridge(),
      task: 't',
      sessionMode: 'recent',
      title: 's',
      report: (p) => void reports.push(p),
    })

    expect(handleUserSend).not.toHaveBeenCalled()
    expect(reports[0]?.ok).toBe(false)
  })
})

describe('runDevHandoff · 完成判定（P3b）', () => {
  let dir: string

  beforeEach(() => {
    dir = newTempDir('lumii-handoff-watch-')
    setDevContextBaseDir(dir)
    vi.clearAllMocks()
    bindCli()
    setUserGlobalBackend('lumii')
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** 发起一轮（会话此刻为空）后写入落库消息，再让监听轮询一次 */
  async function runThenLand(
    landedText: string,
    msgId: string,
  ): Promise<DevHandoffReport[]> {
    vi.useFakeTimers()
    const snapshot: MessageSnapshot = { messages: [] }
    const reports: DevHandoffReport[] = []

    await runDevHandoff({
      bridge: makeBridge(snapshot),
      task: 't',
      sessionMode: 'new',
      title: 's',
      report: (p) => void reports.push(p),
    })
    expect(reports).toHaveLength(0) // 刚发起，尚未轮询

    snapshot.messages = [
      {
        id: msgId,
        role: 'assistant',
        is_streaming: 0,
        content_json: JSON.stringify({ type: 'text', text: landedText }),
      },
    ]
    await vi.advanceTimersByTimeAsync(6000)
    return reports
  }

  it('开发会话出现 ACP 失败消息 → 立即汇报失败，不必等到 90 分钟超时', async () => {
    const reports = await runThenLand('❌ ACP 执行失败：spawn claude ENOENT', 'acp-msg-1')

    expect(reports).toHaveLength(1)
    expect(reports[0]!.ok).toBe(false)
    expect(reports[0]!.text).toContain('ACP 执行失败')
  })

  it('用户取消也算失败（不当成完成）', async () => {
    const reports = await runThenLand('已取消 ACP 执行。', 'acp-msg-2')

    expect(reports[0]?.ok).toBe(false)
  })

  it('正常产出仍汇报完成（回归保护）', async () => {
    const reports = await runThenLand('已修复分页边界，改动 2 个文件。', 'acp-msg-3')

    expect(reports).toHaveLength(1)
    expect(reports[0]!.ok).toBe(true)
    expect(reports[0]!.text).toContain('已修复分页边界')
  })
})
