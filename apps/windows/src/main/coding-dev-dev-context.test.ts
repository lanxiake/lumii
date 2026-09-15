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
    expect(getDevContext('conv-1')).toBeUndefined()
    setDevContext('conv-1', { projectName: 'lumii' })
    expect(getDevContext('conv-1')?.projectName).toBe('lumii')

    setDevContext('conv-1', { backendId: 'claude' })
    const rec = getDevContext('conv-1')
    expect(rec?.projectName).toBe('lumii')
    expect(rec?.backendId).toBe('claude')
  })

  it('补丁传 null 清除单项；两项皆空时删除整条记录', () => {
    setDevContext('conv-2', { projectName: 'a', backendId: 'codex' })
    setDevContext('conv-2', { projectName: null })
    expect(getDevContext('conv-2')?.backendId).toBe('codex')

    const gone = setDevContext('conv-2', { backendId: null })
    expect(gone).toBeUndefined()
    expect(getDevContext('conv-2')).toBeUndefined()
  })

  it('显式写入 lumii 作为退出开发模式的压制值', () => {
    setDevContext('conv-4', { backendId: 'lumii', projectName: 'lumii' })
    expect(getDevContext('conv-4')?.backendId).toBe('lumii')
  })

  it('clearDevContext 返回原记录是否存在', () => {
    expect(clearDevContext('nope')).toBe(false)
    setDevContext('conv-3', { backendId: 'lumii' })
    expect(clearDevContext('conv-3')).toBe(true)
    expect(getDevContext('conv-3')).toBeUndefined()
  })

  it('损坏文件回退为空（不抛错）', () => {
    fs.mkdirSync(path.join(dir, 'coding-dev-backends'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'coding-dev-backends', 'dev-context.json'), '{not json', 'utf-8')
    expect(getDevContext('conv-x')).toBeUndefined()
  })
})

/**
 * 10-S3b：键从 `${accountId}:${会话id}` 改成**会话 id**。
 *
 * 起因：同一条会话被别的渠道续聊时（用户可以跨渠道接着聊），项目与工具选择会"丢"——
 * 因为算成了两个键。会话是全局唯一的，项目跟会话走，与谁在说话无关。
 */
describe('coding-dev-dev-context · 会话维度（10-S3b）', () => {
  /** 直接写文件，构造 S3b 之前的旧格式（`{accountId}:{会话id}`） */
  function writeLegacyFile(contexts: Record<string, unknown>): void {
    fs.mkdirSync(path.join(dir, 'coding-dev-backends'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'coding-dev-backends', 'dev-context.json'),
      JSON.stringify({ version: 1, contexts }),
      'utf-8',
    )
  }

  it('旧格式（渠道键）仍能读出：同一会话换个渠道继续聊，项目不丢', () => {
    writeLegacyFile({
      'o9cq801:weixin:o9cq801': {
        projectName: 'lumii',
        updatedAt: '2026-09-14T00:00:00.000Z',
      },
    })

    expect(getDevContext('weixin:o9cq801')?.projectName).toBe('lumii')
  })

  it('多个旧键指向同一会话时取最新的一条', () => {
    writeLegacyFile({
      'o9cq801:qbot:964A': { projectName: 'old', updatedAt: '2026-09-10T00:00:00.000Z' },
      'local-user:qbot:964A': { projectName: 'new', updatedAt: '2026-09-14T00:00:00.000Z' },
    })

    expect(getDevContext('qbot:964A')?.projectName).toBe('new')
  })

  it('新键优先于旧键（用户在新格式下改过就以新的为准）', () => {
    writeLegacyFile({
      'local-user:conv-9': { projectName: 'legacy', updatedAt: '2026-09-14T00:00:00.000Z' },
      'conv-9': { projectName: 'current', updatedAt: '2026-09-01T00:00:00.000Z' },
    })

    expect(getDevContext('conv-9')?.projectName).toBe('current')
  })

  it('写入新键时清掉旧键（不留两条互相矛盾的记录）', () => {
    writeLegacyFile({
      'o9cq801:weixin:o9cq801': { projectName: 'lumii', updatedAt: '2026-09-14T00:00:00.000Z' },
    })
    setDevContext('weixin:o9cq801', { projectName: 'blog' })

    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, 'coding-dev-backends', 'dev-context.json'), 'utf-8'),
    ) as { contexts: Record<string, unknown> }
    expect(Object.keys(raw.contexts)).toEqual(['weixin:o9cq801'])
    expect(getDevContext('weixin:o9cq801')?.projectName).toBe('blog')
  })

  it('写入者只作诊断记录，不参与索引', () => {
    setDevContext('conv-10', { projectName: 'lumii' }, 'o9cq801')
    expect(getDevContext('conv-10')?.accountId).toBe('o9cq801')
    // 换个人读同一会话，读到的还是同一份
    expect(getDevContext('conv-10')?.projectName).toBe('lumii')
  })

  it('clearDevContext 同时清掉新键与旧键', () => {
    writeLegacyFile({
      'o9cq801:weixin:o9cq801': { projectName: 'lumii', updatedAt: '2026-09-14T00:00:00.000Z' },
    })

    expect(clearDevContext('weixin:o9cq801')).toBe(true)
    expect(getDevContext('weixin:o9cq801')).toBeUndefined()
  })

  it('账号段必须不含冒号：含冒号会话 id 不会被更短的会话 id 误配', () => {
    writeLegacyFile({
      // 账号 'a' × 会话 'b:964A' —— 合法旧键
      'a:b:964A': { projectName: '属于 b:964A', updatedAt: '2026-09-14T00:00:00.000Z' },
    })

    // 会话 '964A' 不能读到它（否则账号段会变成 'a:b'，那不是一个账号）
    expect(getDevContext('964A')).toBeUndefined()
    // 真正的归属会话读得到
    expect(getDevContext('b:964A')?.projectName).toBe('属于 b:964A')
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
      sessionKey,
      agentId: 'code-dev',
      fallbackBackendId: 'lumii',
    })

  it('会话级项目优先于 Agent 绑定的 workspace，且 source=session', () => {
    setDevContext('dev-conv-1', { projectName: 'blog' })
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
