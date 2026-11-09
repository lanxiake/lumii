/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { normalizeOcrOutput, resolveExecutionProviders } from './ppocr-pipeline.js'

describe('ppocr-pipeline helpers', () => {
  it('forceCpu / cpu 偏好只返回 cpu provider', () => {
    expect(resolveExecutionProviders('auto', true)).toEqual(['cpu'])
    expect(resolveExecutionProviders('cpu')).toEqual(['cpu'])
  })

  it('auto / dml 优先 DirectML 并带 cpu 回退', () => {
    expect(resolveExecutionProviders('auto')).toEqual(['DmlExecutionProvider', 'cpu'])
    expect(resolveExecutionProviders('dml')).toEqual(['DmlExecutionProvider', 'cpu'])
  })

  it('normalizeOcrOutput 汇总段落与置信度', () => {
    const result = normalizeOcrOutput(
      {
        parragraphs: [{ text: '你好' }, { text: '世界' }],
        lines: [
          { text: '你好', score: 0.9, box: [1, 2, 3, 4] },
          { text: '世界', score: 0.7, box: [5, 6, 7, 8] },
        ],
      },
      'cpu',
      42,
    )
    expect(result.text).toContain('你好')
    expect(result.confidence).toBeCloseTo(0.8)
    expect(result.backend).toBe('cpu')
    expect(result.durationMs).toBe(42)
    expect(result.lines).toHaveLength(2)
  })
})
