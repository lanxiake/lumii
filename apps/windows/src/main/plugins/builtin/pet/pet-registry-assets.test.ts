/**
 * 随包模型注册表的资源守卫
 *
 * 内置资源是**直接落盘**的（脚本写进 `resources/pet-models/`），绕过了 `pet-asset install`
 * 那套「目录名 = id、清单与图集交叉校验、越界检查」。于是这里补一道事后校验：
 * 注册表里写的东西，磁盘上必须真的存在。
 *
 * 实测踩过一次：生成脚本把目录写成 `demo-pixel-cat`（连字符），而注册表 `modelUrl` 用的是
 * 清单 id `demo_pixel_cat/manifest.json`（下划线）。两者不一致时客户端只在运行时报
 * 「读取失败 HTTP 404」，界面上就是一片空白 —— 这类问题必须在 CI 上就红。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RESOURCES = join(dirname(fileURLToPath(import.meta.url)), '../../../resources/pet-models')

interface RawModel {
  id: string
  rendererType?: string
  modelUrl: string
  thumbnailUrl?: string
}

const registry = JSON.parse(readFileSync(join(RESOURCES, 'registry.json'), 'utf-8')) as {
  models: RawModel[]
  defaultModelId: string
}

/** 需要走磁盘解析的（http/file/lumii-pet 由运行时处理，不在此校验） */
const isRelative = (url: string) => !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('/')

describe('随包注册表', () => {
  it('注册表非空且 defaultModelId 指向真实存在的模型', () => {
    expect(registry.models.length).toBeGreaterThan(0)
    expect(registry.models.map((m) => m.id)).toContain(registry.defaultModelId)
  })

  it.each(registry.models.map((m) => [m.id, m] as const))(
    '%s 的 modelUrl 指向真实存在的文件',
    (_id, m) => {
      if (!isRelative(m.modelUrl)) return
      const abs = join(RESOURCES, m.modelUrl)
      if (!existsSync(abs)) {
        throw new Error(`注册表引用了不存在的文件：${m.modelUrl}（解析为 ${abs}）`)
      }
      expect(existsSync(abs)).toBe(true)
    },
  )

  it.each(registry.models.map((m) => [m.id, m] as const))(
    '%s 的 thumbnailUrl（若声明）指向真实存在的文件',
    (_id, m) => {
      if (!m.thumbnailUrl || !isRelative(m.thumbnailUrl)) return
      expect(existsSync(join(RESOURCES, m.thumbnailUrl))).toBe(true)
    },
  )

  it.each(registry.models.map((m) => [m.id, m] as const))(
    '%s 的资源目录名与其 id 一致（pet-asset install 也是这么落盘的）',
    (id, m) => {
      if (!isRelative(m.modelUrl)) return
      const firstSegment = m.modelUrl.replace(/\\/g, '/').split('/')[0]
      expect(firstSegment).toBe(id)
    },
  )

  it.each(registry.models.map((m) => [m.id, m] as const))(
    '%s 的 rendererType 是已知取值',
    (_id, m) => {
      expect(['live2d', 'sprite']).toContain(m.rendererType ?? 'live2d')
    },
  )
})
