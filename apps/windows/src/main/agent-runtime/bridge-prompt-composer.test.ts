import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SystemPromptResult } from '@mtbot/agent-runtime'
import { BridgePromptComposer, type BridgePromptComposerDeps } from './bridge-prompt-composer'
import { _resetWindowsClientDataRootCacheForTest } from '../client-data-root'
import { registerProject, resolveSceneFilePath, writeSceneMemory } from './scene-memory-store'

describe('BridgePromptComposer 场景记忆注入', () => {
  const tempDirs: string[] = []
  const originalEnv = process.env.LUMII_CLIENT_DATA_DIR
  let dataRoot: string
  let cwd: string

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-composer-data-'))
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-composer-cwd-'))
    tempDirs.push(dataRoot, cwd)
    process.env.LUMII_CLIENT_DATA_DIR = dataRoot
    _resetWindowsClientDataRootCacheForTest()
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LUMII_CLIENT_DATA_DIR
    } else {
      process.env.LUMII_CLIENT_DATA_DIR = originalEnv
    }
    _resetWindowsClientDataRootCacheForTest()
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  const baseResult = {
    staticPrompt: 'STATIC-PROMPT',
    dynamicPrompt: '\nDYNAMIC-PROMPT',
  } as unknown as SystemPromptResult

  function makeComposer(
    sessionKey: string,
    extraDeps: Partial<BridgePromptComposerDeps> = {},
  ): BridgePromptComposer {
    return new BridgePromptComposer({
      getCwd: () => cwd,
      loadUserMemory: async () => ({ content: '## 基本信息\n\n- 用户是程序员' }),
      getMemoryInjectionSettings: async () => ({
        injectPersonalMemory: true,
        injectWorkMemory: true,
      }),
      getTaskRepo: () => null,
      instanceToConversation: new Map([['inst-1', sessionKey]]),
      instanceStates: new Map() as never,
      ...extraDeps,
    })
  }

  it('消息命中项目时注入项目段；未命中不注入', async () => {
    const repoPath = path.join(dataRoot, 'fake-repo')
    await registerProject(dataRoot, { name: 'Lumii', path: repoPath })
    await writeSceneMemory(
      resolveSceneFilePath(dataRoot, 'project', 'lumii', repoPath),
      '## 项目约定\n\n- 用 pnpm 不用 npm',
    )

    const composer = makeComposer('conv-abc')

    const hit = await composer.buildPromptWithMemory(
      'inst-1',
      baseResult,
      undefined,
      '帮我改一下 lumii 的构建脚本',
    )
    expect(hit).toContain('## 关于用户（个人记忆）')
    expect(hit).toContain('## 项目记忆：Lumii（仅适用于本项目）')
    expect(hit).toContain('用 pnpm 不用 npm')

    const miss = await composer.buildPromptWithMemory(
      'inst-1',
      baseResult,
      undefined,
      '今天天气怎么样',
    )
    expect(miss).not.toContain('## 项目记忆')
    expect(miss).toContain('## 关于用户（个人记忆）')
  })

  it('渠道会话注入渠道段（含中文渠道名）', async () => {
    await writeSceneMemory(
      resolveSceneFilePath(dataRoot, 'channel', 'weixin'),
      '## 渠道偏好\n\n- 回复要简短',
    )

    const composer = makeComposer('weixin:user-1')
    const prompt = await composer.buildPromptWithMemory('inst-1', baseResult, undefined, '你好')

    expect(prompt).toContain('## 渠道偏好：微信（仅在微信渠道生效）')
    expect(prompt).toContain('回复要简短')
  })

  it('创建实例（无消息）时只可能注入渠道段', async () => {
    const repoPath = path.join(dataRoot, 'fake-repo')
    await registerProject(dataRoot, { name: 'Lumii', path: repoPath })
    await writeSceneMemory(
      resolveSceneFilePath(dataRoot, 'project', 'lumii', repoPath),
      '## 项目约定\n\n- 用 pnpm',
    )
    await writeSceneMemory(
      resolveSceneFilePath(dataRoot, 'channel', 'weixin'),
      '## 渠道偏好\n\n- 简短',
    )

    const composer = makeComposer('weixin:user-1')
    const prompt = await composer.buildPromptWithMemory('inst-1', baseResult)

    expect(prompt).toContain('## 渠道偏好：微信')
    expect(prompt).not.toContain('## 项目记忆')
  })

  it('关闭个人记忆开关时场景段一并跳过', async () => {
    const repoPath = path.join(dataRoot, 'fake-repo')
    await registerProject(dataRoot, { name: 'Lumii', path: repoPath })
    await writeSceneMemory(
      resolveSceneFilePath(dataRoot, 'project', 'lumii', repoPath),
      '## 项目约定\n\n- 用 pnpm',
    )

    const composer = makeComposer('conv-abc')
    const prompt = await composer.buildPromptWithMemory(
      'inst-1',
      baseResult,
      { injectPersonalMemory: false, injectWorkMemory: true },
      'lumii 的构建脚本',
    )

    expect(prompt).not.toContain('## 项目记忆')
    expect(prompt).not.toContain('## 关于用户（个人记忆）')
  })

  it('场景文件不存在时静默跳过（不产生空段）', async () => {
    await registerProject(dataRoot, { name: 'Lumii', path: path.join(dataRoot, 'fake-repo') })

    const composer = makeComposer('conv-abc')
    const prompt = await composer.buildPromptWithMemory(
      'inst-1',
      baseResult,
      undefined,
      'lumii 的构建脚本',
    )

    expect(prompt).not.toContain('## 项目记忆')
    expect(prompt).toContain('STATIC-PROMPT')
  })

  describe('工作记忆填充（占位符）', () => {
    const withPlaceholder = {
      staticPrompt: 'STATIC\n{{LUMII_MEMORY_BLOCK}}',
      dynamicPrompt: '\nDYNAMIC-PROMPT',
    } as unknown as SystemPromptResult

    it('开关开启时调用填充回调：query 透传、占位符被替换', async () => {
      const calls: Array<{ query?: string }> = []
      const composer = makeComposer('conv-abc', {
        fillWorkMemoryPlaceholder: (prompt, query) => {
          calls.push({ query })
          return { prompt: prompt.replace('{{LUMII_MEMORY_BLOCK}}', '### 工作记忆\n- 探针'), injected: 1 }
        },
      })
      const prompt = await composer.buildPromptWithMemory('inst-1', withPlaceholder, undefined, '蓝鲸计划')
      expect(calls).toHaveLength(1)
      expect(calls[0].query).toBe('蓝鲸计划')
      expect(prompt).toContain('- 探针')
      expect(prompt).not.toContain('{{LUMII_MEMORY_BLOCK}}')
    })

    it('开关关闭时不调用回调，占位符出清', async () => {
      let called = false
      const composer = makeComposer('conv-abc', {
        fillWorkMemoryPlaceholder: (prompt) => {
          called = true
          return { prompt, injected: 0 }
        },
      })
      const prompt = await composer.buildPromptWithMemory(
        'inst-1',
        withPlaceholder,
        { injectPersonalMemory: true, injectWorkMemory: false },
        '你好',
      )
      expect(called).toBe(false)
      expect(prompt).not.toContain('{{LUMII_MEMORY_BLOCK}}')
    })

    it('未配置填充回调时占位符出清（防字面量泄漏）', async () => {
      const composer = makeComposer('conv-abc')
      const prompt = await composer.buildPromptWithMemory('inst-1', withPlaceholder, undefined, '你好')
      expect(prompt).not.toContain('{{LUMII_MEMORY_BLOCK}}')
      expect(prompt).toContain('STATIC')
    })
  })
})
