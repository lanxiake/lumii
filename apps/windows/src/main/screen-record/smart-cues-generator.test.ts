/**
 * smart-cues-generator 单测
 */
import { describe, expect, it } from 'vitest'
import { generateSmartCues, alignCuesWithActualDuration } from './smart-cues-generator'
import type { ScreenRecordMarker } from '../../shared/screen-record'

describe('generateSmartCues', () => {
  it('自动合并过短间隔(<800ms)', () => {
    const timeline: ScreenRecordMarker[] = [
      { id: 'm1', atMs: 1000, label: '步骤1', kind: 'beat', entryType: 'marker' },
      { id: 'm2', atMs: 1500, label: '步骤2', kind: 'beat', entryType: 'marker' }, // 间隔500ms < 800
      { id: 'm3', atMs: 3000, label: '步骤3', kind: 'beat', entryType: 'marker' },
    ]

    const result = generateSmartCues(timeline, { durationMs: 10000 })

    expect(result.length).toBe(2) // 步骤1+2合并
    expect(result[0]!.merged).toBe(true)
    expect(result[0]!.label).toContain('步骤1')
    expect(result[0]!.label).toContain('步骤2')
  })

  it('添加缓冲时间避免截断', () => {
    const timeline: ScreenRecordMarker[] = [
      { id: 'm1', atMs: 1000, label: '开始', kind: 'beat', entryType: 'marker' },
      { id: 'm2', atMs: 5000, label: '结束', kind: 'beat', entryType: 'marker' },
    ]

    const result = generateSmartCues(timeline, { durationMs: 10000, bufferMs: 500 })

    expect(result[0]!.endMs).toBe(4500) // 5000 - 500
  })

  it('首段超过阈值时补开场白', () => {
    const timeline: ScreenRecordMarker[] = [
      { id: 'm1', atMs: 3000, label: '第一步', kind: 'beat', entryType: 'marker' },
    ]

    const result = generateSmartCues(timeline, {
      durationMs: 10000,
      addOpeningThresholdMs: 2000,
      generateOpeningText: () => '欢迎观看教程',
    })

    expect(result.length).toBe(2)
    expect(result[0]!.startMs).toBe(0)
    expect(result[0]!.text).toBe('欢迎观看教程')
  })

  it('最后一段对齐视频结尾', () => {
    const timeline: ScreenRecordMarker[] = [
      { id: 'm1', atMs: 1000, label: '开始', kind: 'beat', entryType: 'marker' },
      { id: 'm2', atMs: 5000, label: '结束', kind: 'beat', entryType: 'marker' },
    ]

    const result = generateSmartCues(timeline, { durationMs: 10000 })

    expect(result[result.length - 1]!.endMs).toBe(10000)
  })
})

describe('alignCuesWithActualDuration', () => {
  it('检测重叠并自动调整', () => {
    const cues = [
      { startMs: 1000, text: '第一段', audioPath: '/tmp/1.wav' },
      { startMs: 3000, text: '第二段', audioPath: '/tmp/2.wav' },
      { startMs: 5000, text: '第三段', audioPath: '/tmp/3.wav' },
    ]

    const actualDurations = new Map([
      ['/tmp/1.wav', 2500], // 实际播放到3500，与第二段(3000)冲突
      ['/tmp/2.wav', 1800],
      ['/tmp/3.wav', 1500],
    ])

    const { aligned, adjustments } = alignCuesWithActualDuration(cues, actualDurations)

    expect(aligned[0]!.endMs).toBe(3500) // 1000 + 2500
    expect(adjustments.length).toBeGreaterThan(0)
    expect(adjustments[0]!.reason).toContain('重叠')
    // 第二段被延迟
    expect(aligned[1]!.startMs).toBeGreaterThan(3500)
  })

  it('无冲突时保持原时间', () => {
    const cues = [
      { startMs: 1000, text: '第一段', audioPath: '/tmp/1.wav' },
      { startMs: 5000, text: '第二段', audioPath: '/tmp/2.wav' },
    ]

    const actualDurations = new Map([
      ['/tmp/1.wav', 2000], // 结束于3000，不与5000冲突
      ['/tmp/2.wav', 1500],
    ])

    const { aligned, adjustments } = alignCuesWithActualDuration(cues, actualDurations)

    expect(aligned[1]!.startMs).toBe(5000) // 保持原时间
    expect(adjustments.length).toBe(0)
  })
})
