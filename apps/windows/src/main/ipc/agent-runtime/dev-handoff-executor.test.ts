/**
 * 转交执行器（09-P2）：项目名写入**开发会话**的 dev-context。
 *
 * 这是「转交后 cwd 落在项目目录」的唯一通道——`codingDevProjects` 本身不参与
 * `resolveDevContext` 解析，不写这一步，即使项目已注册，开发会话也会退化成全局 workspace。
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
import { getDevContext, setDevContextBaseDir } from '../../coding-dev-dev-context'
import { runDevHandoff } from './dev-handoff-executor'
import { handleUserSend } from './user-commands'

function makeBridge(): AgentRuntimeBridge {
  return {
    conversationRepo: {
      getConversation: () => ({ title: '开发任务' }),
      loadRecentMessages: () => [],
    },
    hasStreamingMessages: () => false,
  } as unknown as AgentRuntimeBridge
}

describe('runDevHandoff · 项目上下文', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-handoff-'))
    setDevContextBaseDir(dir)
    vi.clearAllMocks()
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

    expect(getDevContext('local-user', 'dev-session-1')?.projectName).toBe('lumii')
  })

  it('未指定项目时不写 dev-context（不覆盖会话既有选择）', async () => {
    await runDevHandoff({
      bridge: makeBridge(),
      task: 't',
      sessionMode: 'new',
      title: 's',
      report: () => {},
    })

    expect(getDevContext('local-user', 'dev-session-1')).toBeUndefined()
  })

  it('dev-context 在发起任务消息之前写入（首个回合即命中）', async () => {
    const seenAtSend: Array<string | undefined> = []
    vi.mocked(handleUserSend).mockImplementation(async () => {
      seenAtSend.push(getDevContext('local-user', 'dev-session-1')?.projectName)
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
