/**
 * VoiceProfileStore 单元测试
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VoiceProfileStore } from './voice-profile-store.js'

describe('VoiceProfileStore', () => {
  let tmp: string
  let store: VoiceProfileStore

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-voice-profile-'))
    store = new VoiceProfileStore(path.join(tmp, 'voice', 'profiles'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  /**
   * 创建临时 wav 文件
   */
  function makeWav(): string {
    const wav = path.join(tmp, `sample-${Date.now()}.wav`)
    fs.writeFileSync(wav, Buffer.from('RIFF____WAVEfmt '))
    return wav
  }

  it('upsert 后可 list/get，并拷贝参考音频', () => {
    const wav = makeWav()
    const profile = store.upsert({
      name: '测试音色',
      refAudioPath: wav,
      refText: '你好世界',
      language: 'Chinese',
      qwen3Variant: '0.6b-base',
    })
    expect(profile.id).toBeTruthy()
    expect(store.list()).toHaveLength(1)
    const got = store.get(profile.id)
    expect(got?.name).toBe('测试音色')
    expect(got?.refText).toBe('你好世界')
    expect(fs.existsSync(store.getRefAudioPath(got!))).toBe(true)
  })

  it('ICL 模式缺少 refText 应抛错', () => {
    const wav = makeWav()
    expect(() =>
      store.upsert({
        name: 'x',
        refAudioPath: wav,
        refText: '   ',
        xVectorOnly: false,
      }),
    ).toThrow(/refText/)
  })

  it('rename 只改名称、不动参考音频', () => {
    const wav = makeWav()
    const profile = store.upsert({
      name: '旧名',
      refAudioPath: wav,
      refText: '一句文本',
    })
    const refPath = store.getRefAudioPath(profile)
    const renamed = store.rename(profile.id, '新名字')
    expect(renamed?.name).toBe('新名字')
    expect(renamed?.updatedAt).toBeGreaterThanOrEqual(profile.updatedAt)
    expect(store.get(profile.id)?.name).toBe('新名字')
    expect(fs.existsSync(refPath)).toBe(true)
  })

  it('rename 空白名回退为未命名音色', () => {
    const wav = makeWav()
    const profile = store.upsert({ name: '原名', refAudioPath: wav, refText: '文本' })
    expect(store.rename(profile.id, '   ')?.name).toBe('未命名音色')
  })

  it('rename 不存在的档案返回 null', () => {
    expect(store.rename('missing-id', '任意')).toBeNull()
  })

  it('delete 移除档案目录', () => {
    const wav = makeWav()
    const profile = store.upsert({
      name: '待删',
      refAudioPath: wav,
      refText: '一句文本',
    })
    expect(store.delete(profile.id)).toBe(true)
    expect(store.get(profile.id)).toBeNull()
    expect(store.list()).toHaveLength(0)
  })
})
