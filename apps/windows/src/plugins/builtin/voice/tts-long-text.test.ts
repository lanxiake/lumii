import { describe, expect, it } from 'vitest'
import { packTtsSegments } from './tts-long-text'
import { splitTextForTtsCache } from './tts-preview-cache'

describe('长文分段打包', () => {
  it('句子合并到上限内，首段更短', () => {
    const s = ['一二三四五。', '六七八九十。', '甲乙丙丁戊。', '己庚辛壬癸。']
    expect(packTtsSegments(s, 12, 6)).toEqual(['一二三四五。', '六七八九十。甲乙丙丁戊。', '己庚辛壬癸。'])
  })

  it('不丢字、不超上限（用真实切句器跑一篇长文）', () => {
    const article = '春天来了，万物复苏。'.repeat(80) + '最后一句没有句号'
    const segs = packTtsSegments(splitTextForTtsCache(article, 200), 200)
    expect(segs.join('')).toBe(article.replace(/\s+/g, ' ').trim())
    expect(segs[0]!.length).toBeLessThanOrEqual(80)
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(200)
  })

  it('空输入返回空', () => {
    expect(packTtsSegments(['', '  '], 100)).toEqual([])
  })
})
