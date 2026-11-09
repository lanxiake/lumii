import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isValidVoiceName, VoiceAnchorStore } from './voice-anchor-store'

describe('命名音色锚点', () => {
  let dir: string
  let src: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-'))
    src = path.join(dir, 'src.wav')
    fs.writeFileSync(src, 'RIFF-fake')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('存入后按名字取回；源文件删了也不影响', () => {
    const store = new VoiceAnchorStore(path.join(dir, 'lib'))
    store.save('旁白_男', 'breeze', { audioPath: src, text: '第一句' }, '沉稳男声')
    fs.rmSync(src)
    const got = store.get('旁白_男', 'breeze')
    expect(got?.text).toBe('第一句')
    expect(got?.instruction).toBe('沉稳男声')
    expect(fs.readFileSync(got!.audioPath, 'utf8')).toBe('RIFF-fake')
  })

  it('换引擎不适用', () => {
    const store = new VoiceAnchorStore(path.join(dir, 'lib'))
    store.save('a', 'breeze', { audioPath: src, text: 't' })
    expect(store.get('a', 'qwen3')).toBeNull()
    expect(store.list('qwen3')).toEqual([])
    expect(store.list('breeze').map((x) => x.name)).toEqual(['a'])
  })

  it('不存在 / 删除后返回 null', () => {
    const store = new VoiceAnchorStore(path.join(dir, 'lib'))
    expect(store.get('none', 'breeze')).toBeNull()
    store.save('x', 'breeze', { audioPath: src, text: 't' })
    store.remove('x')
    expect(store.get('x', 'breeze')).toBeNull()
  })

  it('拒绝带路径的名字', () => {
    expect(isValidVoiceName('../evil')).toBe(false)
    expect(isValidVoiceName('a/b')).toBe(false)
    expect(isValidVoiceName('')).toBe(false)
    expect(isValidVoiceName('主角-小明_01')).toBe(true)
    const store = new VoiceAnchorStore(dir)
    expect(() => store.get('../x', 'breeze')).toThrow(/不合法/)
  })
})
