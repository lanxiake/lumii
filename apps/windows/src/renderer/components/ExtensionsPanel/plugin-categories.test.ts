import { describe, it, expect } from 'vitest'
import { categoryOfPlugin, PLUGIN_CATEGORIES } from './plugin-categories'

describe('插件功能分类', () => {
  it('TTS 引擎优先归到语音，不被更宽的前缀抢走', () => {
    expect(categoryOfPlugin('com.lumii.tts.edge')).toBe('voice')
    expect(categoryOfPlugin('com.lumii.tts.melo')).toBe('voice')
    expect(categoryOfPlugin('com.lumii.tts.qwen3')).toBe('voice')
    expect(categoryOfPlugin('com.lumii.tts.breeze')).toBe('voice')
    expect(categoryOfPlugin('com.lumii.voice')).toBe('voice')
  })

  it('消息渠道', () => {
    expect(categoryOfPlugin('com.lumii.channel-feishu')).toBe('channel')
    expect(categoryOfPlugin('com.lumii.channel-weixin')).toBe('channel')
    expect(categoryOfPlugin('com.lumii.pcwechat')).toBe('channel')
  })

  it('媒体、开发、系统各归其位', () => {
    expect(categoryOfPlugin('com.lumii.screen-record')).toBe('media')
    expect(categoryOfPlugin('com.lumii.file-preview')).toBe('media')
    expect(categoryOfPlugin('com.lumii.browser')).toBe('develop')
    expect(categoryOfPlugin('com.lumii.updater')).toBe('system')
  })

  it('未知的外部插件归其他，不会消失', () => {
    expect(categoryOfPlugin('com.example.something')).toBe('other')
    expect(categoryOfPlugin('')).toBe('other')
  })

  it('每个分类都有唯一 id 与顺序', () => {
    const ids = PLUGIN_CATEGORIES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    const orders = PLUGIN_CATEGORIES.map((c) => c.order)
    expect(new Set(orders).size).toBe(orders.length)
  })
})
