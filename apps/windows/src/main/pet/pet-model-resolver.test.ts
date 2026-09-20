/**
 * pet-model-resolver 单元测试
 *
 * 注：loadPetModelRegistry 的文件 IO 部分依赖 Electron app + fs，
 * 在 vitest 下 fs mock 解析不稳定（resolver 侧 'fs' 与测试侧 mock 实例不一致），
 * 故两段式扫描的端到端留给手测（P0-a 验收第 1–3 项），这里聚焦可靠的纯逻辑：
 *  - resolveMergedModel：按来源分流 URL 解析、越界条目丢弃
 *  - isExternalUrl：http/file URL 透传判定
 *
 * mock electron 以允许模块加载（resolver 顶层 import app）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { applyModelDefaults, type MergedPetModel } from '@mtbot/pet-core'

const USER_DATA = 'C:\\fake\\userData'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'E:\\fake\\app',
    getPath: (name: string) => {
      if (name === 'userData') return USER_DATA
      throw new Error(`未预期的 getPath: ${name}`)
    },
  },
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))

import { isExternalUrl, resolveMergedModel } from './pet-model-resolver'

/**
 * `toBuiltinUrl` 会看 `ELECTRON_RENDERER_URL` 决定走 dev 中间件还是 file://。
 * 这个变量在开发机 shell 里经常残留（dev server 导出过），曾导致同类测试稳定假失败。
 * 显式清掉，让用例自己说了算；需要 dev 分支的用例自行设置并在结尾还原。
 */
let savedRendererUrl: string | undefined
beforeEach(() => {
  savedRendererUrl = process.env.ELECTRON_RENDERER_URL
  delete process.env.ELECTRON_RENDERER_URL
})
afterEach(() => {
  if (savedRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
  else process.env.ELECTRON_RENDERER_URL = savedRendererUrl
})

const entry = (over: Partial<MergedPetModel>): MergedPetModel =>
  ({
    ...applyModelDefaults({
      id: 'cat',
      name: '猫',
      rendererType: 'live2d',
      modelUrl: 'cat/model.model3.json',
    }),
    source: 'builtin',
    ...over,
  }) as MergedPetModel

describe('pet-model-resolver / resolveMergedModel', () => {
  it('内置 + 相对路径 → file:// 绝对路径', () => {
    const m = resolveMergedModel(entry({ source: 'builtin' }))
    expect(m?.modelUrl).toMatch(/^file:\/\//)
    expect(m?.modelUrl).toContain('pet-models')
    expect(m?.modelUrl).toContain('model.model3.json')
  })

  it('内置 + dev HTTP 渲染层 → /pet-models/ 交给 Vite 中间件（HTTP 页面读不了 file://）', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://127.0.0.1:5174'
    const m = resolveMergedModel(entry({ source: 'builtin' }))
    expect(m?.modelUrl).toBe('/pet-models/cat/model.model3.json')
  })

  it('用户 + 相对路径 → lumii-pet:// URL', () => {
    const m = resolveMergedModel(entry({ source: 'user' }))
    expect(m?.modelUrl).toBe('lumii-pet://model/cat/model.model3.json')
  })

  it('用户模型带空格/中文的路径按段编码，相对引用仍可解析', () => {
    const m = resolveMergedModel(entry({ source: 'user', modelUrl: '我的 猫/manifest.json' }))
    expect(m?.modelUrl).toBe('lumii-pet://model/%E6%88%91%E7%9A%84%20%E7%8C%AB/manifest.json')
    // 渲染层用 new URL('atlas.png', modelUrl) 能得到同级资源
    expect(new URL('atlas.png', m?.modelUrl as string).href).toBe(
      'lumii-pet://model/%E6%88%91%E7%9A%84%20%E7%8C%AB/atlas.png',
    )
  })

  it('用户来源不继承内置的 dev HTTP 分支（两种模式同一个 URL）', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://127.0.0.1:5174'
    try {
      const m = resolveMergedModel(entry({ source: 'user' }))
      expect(String(m?.modelUrl).startsWith('lumii-pet://')).toBe(true)
    } finally {
      delete process.env.ELECTRON_RENDERER_URL
    }
  })

  it('http/file 绝对 URL 两种来源都原样保留', () => {
    for (const source of ['builtin', 'user'] as const) {
      expect(resolveMergedModel(entry({ source, modelUrl: 'https://cdn/m.json' }))?.modelUrl).toBe(
        'https://cdn/m.json',
      )
      expect(resolveMergedModel(entry({ source, modelUrl: 'file:///C:/m.json' }))?.modelUrl).toBe(
        'file:///C:/m.json',
      )
    }
  })

  it('用户来源声明了逃出宠物目录的路径 → 丢弃该条目', () => {
    expect(resolveMergedModel(entry({ source: 'user', modelUrl: '../../../etc/passwd' }))).toBeNull()
  })

  it('内置来源声明同样的越界路径不被丢弃（内置目录是可信的，且行为与改动前一致）', () => {
    // 这里不鼓励越界，只是确认「用户越界要拦」没有误伤内置路径解析
    const m = resolveMergedModel(entry({ source: 'builtin', modelUrl: '../sibling/m.json' }))
    expect(m).not.toBeNull()
  })

  it('thumbnailUrl 与 modelUrl 走同一套解析', () => {
    const m = resolveMergedModel(entry({ source: 'user', thumbnailUrl: 'cat/icon.png' }))
    expect(m?.thumbnailUrl).toBe('lumii-pet://model/cat/icon.png')
  })

  it('thumbnailUrl 越界时只丢缩略图，不丢模型', () => {
    const m = resolveMergedModel(entry({ source: 'user', thumbnailUrl: '../../x.png' }))
    expect(m).not.toBeNull()
    expect(m?.thumbnailUrl).toBeUndefined()
  })

  it('保留来源标记与覆盖标记（控制坞据此显示来源）', () => {
    const m = resolveMergedModel(entry({ source: 'user', shadowedBuiltin: true }))
    expect(m?.source).toBe('user')
    expect(m?.shadowedBuiltin).toBe(true)
  })

  it('空 agentId 归一为 undefined（注册表里用 "" 表示未指定）', () => {
    expect(resolveMergedModel(entry({ agentId: '' }))?.agentId).toBeUndefined()
  })

  it('actionMotions 原样透传（供动作提示词注入）', () => {
    const m = resolveMergedModel(
      entry({ actionMotions: { 挥手: { group: '$unnamed', index: 0 } } }),
    )
    expect(m?.actionMotions).toEqual({ 挥手: { group: '$unnamed', index: 0 } })
  })
})

describe('pet-model-resolver / isExternalUrl', () => {
  it('识别 http/https/file 为外部 URL', () => {
    expect(isExternalUrl('http://x/m.json')).toBe(true)
    expect(isExternalUrl('https://x/m.json')).toBe(true)
    expect(isExternalUrl('file:///C:/m.json')).toBe(true)
  })

  it('相对路径不是外部 URL', () => {
    expect(isExternalUrl('cat/model.model3.json')).toBe(false)
    expect(isExternalUrl('model.model3.json')).toBe(false)
  })

  it('lumii-pet 不算外部 URL（它是用户来源的相对路径解析结果，不该被当作透传）', () => {
    expect(isExternalUrl('lumii-pet://model/cat/manifest.json')).toBe(false)
  })
})
