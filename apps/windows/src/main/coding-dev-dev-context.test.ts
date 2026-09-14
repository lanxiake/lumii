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
import { resolveAgentDevBinding, resolveDevContext, resolveProjectPathByName } from './coding-dev-env'
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

/**
 * 09-P2 的核心链路：runDevHandoff 把提案项目写进开发会话的 dev-context，
 * resolveDevContext 随即命中会话级来源、把 cwd 解析到项目目录。
 * 最后一例同时钉住 P3 的拦截判据（无绑定 → 后端回落 lumii → 应拒绝执行）。
 */
describe('resolveDevContext · 转交写入项目后的解析（09-P2 链路）', () => {
  const appConfig = {
    codingDevProjects: [
      { name: 'lumii', realPath: 'E:/proj/lumii', isExternal: true },
      { name: 'blog', realPath: 'E:/proj/blog', isExternal: false },
    ],
    codingDevAgentBindings: [
      { agentId: 'code-dev', backendId: 'claude', workspace: 'E:/proj/binding-ws', enabled: true },
    ],
  } as unknown as AppConfig

  const resolve = (sessionKey: string, cfg: unknown = appConfig) =>
    resolveDevContext({
      appConfig: cfg as AppConfig,
      accountId: 'local-user',
      sessionKey,
      agentId: 'code-dev',
      fallbackBackendId: 'lumii',
    })

  it('会话级项目优先于 Agent 绑定的 workspace，且 source=session', () => {
    setDevContext('local-user', 'dev-conv-1', { projectName: 'blog' })
    const ctx = resolve('dev-conv-1')
    expect(ctx.source).toBe('session')
    expect(ctx.projectName).toBe('blog')
    expect(ctx.projectPath).toBe('E:/proj/blog') // 而非 binding.workspace
    expect(ctx.backendId).toBe('claude') // 后端仍取自绑定
  })

  it('未写 dev-context 时回落到绑定的 workspace（P2 之前的行为，回归保护）', () => {
    const ctx = resolve('dev-conv-2')
    expect(ctx.source).toBe('binding')
    expect(ctx.projectPath).toBe('E:/proj/binding-ws')
  })

  it('无 dev-context 也无绑定时后端回落 fallback=lumii（P3 据此拒绝静默降级）', () => {
    const ctx = resolve('dev-conv-3', { codingDevProjects: appConfig.codingDevProjects })
    expect(ctx.backendId).toBe('lumii')
    expect(ctx.projectPath).toBeUndefined()
  })
})
