/**
 * 内置 Agent 定义镜像的单测。
 *
 * 两条红线：
 * 1. 定义详情必须嵌在 `record.definition` 里 —— 铺平到顶层会被
 *    `mapApiRecordToAgentDefinition` 当成运行时字段读走（tools 当工具白名单）；
 * 2. fork 出的用户 Agent 不得携带 `definition`，否则用户 Agent 会顶着系统 Agent 的定义。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _resetWindowsClientDataRootCacheForTest } from './client-data-root'
import { forkAgentRecord, listAgents } from './agents-repo'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-agents-repo-'))
  process.env.LUMII_CLIENT_DATA_DIR = dir
  _resetWindowsClientDataRootCacheForTest()
})

afterEach(() => {
  delete process.env.LUMII_CLIENT_DATA_DIR
  _resetWindowsClientDataRootCacheForTest()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('agents-repo 系统 Agent 定义镜像', () => {
  it('系统 Agent 带只读 definition 详情', () => {
    const agents = listAgents().agents
    const codeDev = agents.find((a) => a.id === 'code-dev')
    expect(codeDev).toBeDefined()
    expect(codeDev?.definition?.tools).toContain('bash')
    expect(codeDev?.definition?.maxTurns).toBe(80)
    expect(codeDev?.definition?.memoryScope).toBe('user')

    const keeper = agents.find((a) => a.id === 'system-keeper')
    expect(keeper?.definition?.tools).toContain('app_screenshot')
    expect(keeper?.definition?.canSpawnSubAgents).toBe(false)

    // 只读子 Agent 的禁用工具面（permissionMode=readOnly）
    const explore = agents.find((a) => a.id === 'builtin:explore')
    expect(explore?.definition?.permissionMode).toBe('readOnly')
    expect(explore?.definition?.disallowedTools).toContain('file_write')
  })

  it('definition 不得铺平到顶层（会被 mapApiRecordToAgentDefinition 误读成运行时字段）', () => {
    const records = listAgents().agents
    for (const record of records) {
      const raw = record as unknown as Record<string, unknown>
      expect(raw.tools).toBeUndefined()
      expect(raw.disallowedTools).toBeUndefined()
      expect(raw.maxTurns).toBeUndefined()
      expect(raw.permissionMode).toBeUndefined()
      expect(raw.memoryConfig).toBeUndefined()
    }
  })

  it('fork 出的用户 Agent 不携带 definition', () => {
    const forked = forkAgentRecord('code-dev', { name: '我的开发 Agent' })
    expect(forked.userId).toBe('local-user')
    expect(forked.definition).toBeUndefined()
    expect(forked.systemPrompt).toBeTruthy()

    // 落盘后再读一遍，确认没有从其它路径漏回来
    const reloaded = listAgents().agents.find((a) => a.id === forked.id)
    expect(reloaded?.definition).toBeUndefined()
  })
})
