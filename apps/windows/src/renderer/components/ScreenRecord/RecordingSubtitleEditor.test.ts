/**
 * 字幕导入解析单测
 */
import { describe, expect, it } from 'vitest'
import { parseImportLines } from './RecordingSubtitleEditor'

describe('parseImportLines', () => {
  it('解析秒|文本行', () => {
    expect(parseImportLines('0|开场\n1.5|下一句\nbad\n')).toEqual([
      { startMs: 0, text: '开场' },
      { startMs: 1500, text: '下一句' },
    ])
  })
})
