/**
 * pet-model-resolver 纯函数单元测试
 *
 * 注：loadPetModelRegistry 的文件 IO 部分依赖 Electron app + fs，
 * 在 vitest 下 fs mock 解析不稳定（resolver 侧 'fs' 与测试侧 mock 实例不一致），
 * 故文件读取留给集成/手动验证，这里聚焦可靠的纯逻辑：
 *  - normalizeModelConfig：默认值补全、缺失字段、字段保留
 *  - http/file URL 透传判定
 *
 * mock electron 以允许模块加载（resolver 顶层 import app）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'E:\\fake\\app' },
}))

import { normalizeModelConfig, isExternalUrl } from './pet-model-resolver'

describe('pet-model-resolver / normalizeModelConfig', () => {
  it('补全缺失字段为默认值', () => {
    const m = normalizeModelConfig({ id: 'cat', name: '猫', modelUrl: 'https://x/m.json' })
    expect(m.rendererType).toBe('live2d')
    expect(m.scale).toBe(0.4)
    expect(m.idleMotionGroup).toBe('Idle')
    expect(m.talkMotionGroup).toBe('Talk')
    expect(m.emotionMap).toEqual({})
    expect(m.tapMotions).toEqual({})
    expect(m.defaultExpression).toBe(0)
  })

  it('保留自定义字段', () => {
    const m = normalizeModelConfig({
      id: 'cat',
      name: '猫',
      modelUrl: 'https://x/m.json',
      scale: 0.6,
      idleMotionGroup: 'Rest',
      talkMotionGroup: 'Speak',
      emotionMap: { joy: 1 },
      tapMotions: { Head: { TapHead: 0 } },
      defaultExpression: 2,
    })
    expect(m.scale).toBe(0.6)
    expect(m.idleMotionGroup).toBe('Rest')
    expect(m.talkMotionGroup).toBe('Speak')
    expect(m.emotionMap).toEqual({ joy: 1 })
    expect(m.tapMotions).toEqual({ Head: { TapHead: 0 } })
    expect(m.defaultExpression).toBe(2)
  })

  it('http URL 原样保留', () => {
    const m = normalizeModelConfig({ id: 'cat', name: '猫', modelUrl: 'https://cdn/m.json' })
    expect(m.modelUrl).toBe('https://cdn/m.json')
  })

  it('file URL 原样保留', () => {
    const m = normalizeModelConfig({ id: 'cat', name: '猫', modelUrl: 'file:///C:/m.json' })
    expect(m.modelUrl).toBe('file:///C:/m.json')
  })

  it('相对路径解析为 file:// URL 且含文件名', () => {
    const m = normalizeModelConfig({ id: 'cat', name: '猫', modelUrl: 'cat/model.model3.json' })
    expect(m.modelUrl).toMatch(/^file:\/\//)
    expect(m.modelUrl).toContain('model.model3.json')
  })

  it('thumbnailUrl 缺失时为 undefined', () => {
    const m = normalizeModelConfig({ id: 'cat', name: '猫', modelUrl: 'https://x/m.json' })
    expect(m.thumbnailUrl).toBeUndefined()
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
})
