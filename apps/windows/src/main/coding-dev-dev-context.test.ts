/**
 * 会话级开发上下文（dev-context.json）与绑定/项目解析的单测。
 * 使用临时目录隔离持久化，不触碰真实 ~/.lumii/config。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearDevContext,
  getDevContext,
  setDevContext,
  setDevContextBaseDir,
} from './coding-dev-dev-context'
import { resolveAgentDevBinding, resolveProjectPathByName } from './coding-dev-env'
import type { AppConfig } from './config/types'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-devctx-'))
  setDevContextBaseDir(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('coding-dev-dev-context', () => {
  it('写入 / 读取 / 合并会话级开发上下文', () => {
    expect(getDevContext('local-user', 'conv-1')).toBeUndefined()
    setDevContext('local-user', 'conv-1', { projectName: 'lumii' })
    expect(getDevContext('local-user', 'conv-1')?.projectName).toBe('lumii')

    setDevContext('local-user', 'conv-1', { backendId: 'claude' })
    const rec = getDevContext('local-user', 'conv-1')
    expect(rec?.projectName).toBe('lumii')
    expect(rec?.backendId).toBe('claude')
  })

  it('补丁传 null 清除单项；两项皆空时删除整条记录', () => {
    setDevContext('local-user', 'conv-2', { projectName: 'a', backendId: 'codex' })
    setDevContext('local-user', 'conv-2', { projectName: null })
    expect(getDevContext('local-user', 'conv-2')?.backendId).toBe('codex')

    const gone = setDevContext('local-user', 'conv-2', { backendId: null })
    expect(gone).toBeUndefined()
    expect(getDevContext('local-user', 'conv-2')).toBeUndefined()
  })

  it('显式写入 lumii 作为退出开发模式的压制值', () => {
    setDevContext('local-user', 'conv-4', { backendId: 'lumii', projectName: 'lumii' })
    expect(getDevContext('local-user', 'conv-4')?.backendId).toBe('lumii')
  })

  it('clearDevContext 返回原记录是否存在', () => {
    expect(clearDevContext('local-user', 'nope')).toBe(false)
    setDevContext('local-user', 'conv-3', { backendId: 'lumii' })
    expect(clearDevContext('local-user', 'conv-3')).toBe(true)
    expect(getDevContext('local-user', 'conv-3')).toBeUndefined()
  })

  it('损坏文件回退为空（不抛错）', () => {
    fs.mkdirSync(path.join(dir, 'coding-dev-backends'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'coding-dev-backends', 'dev-context.json'), '{not json', 'utf-8')
    expect(getDevContext('local-user', 'conv-x')).toBeUndefined()
  })
})

describe('resolveAgentDevBinding / resolveProjectPathByName', () => {
  const appConfig = {
    codingDevProjects: [{ name: 'lumii', realPath: 'E:/proj/lumii', isExternal: true }],
    codingDevAgentBindings: [
      { agentId: 'code-dev', backendId: 'claude', workspace: 'E:/proj/lumii', enabled: true },
      { agentId: 'disabled-agent', backendId: 'codex', enabled: false },
    ],
  } as unknown as AppConfig

  it('命中启用中的绑定；停用 / 未配置 / 无 agentId 返回 undefined', () => {
    expect(resolveAgentDevBinding(appConfig, 'code-dev')?.backendId).toBe('claude')
    expect(resolveAgentDevBinding(appConfig, 'disabled-agent')).toBeUndefined()
    expect(resolveAgentDevBinding(appConfig, 'unknown-agent')).toBeUndefined()
    expect(resolveAgentDevBinding(appConfig, undefined)).toBeUndefined()
  })

  it('按项目名解析 realPath；不存在或空值返回 undefined', () => {
    expect(resolveProjectPathByName(appConfig, 'lumii')).toBe('E:/proj/lumii')
    expect(resolveProjectPathByName(appConfig, 'nope')).toBeUndefined()
    expect(resolveProjectPathByName(appConfig, '  ')).toBeUndefined()
    expect(resolveProjectPathByName(appConfig, undefined)).toBeUndefined()
  })
})
