/**
 * pet-status-labels 单元测试
 */
import { describe, it, expect } from 'vitest'
import {
  formatExpressionLabel,
  formatMotionLabel,
  formatAvatarStatusLine,
  resolveEmotionKeyByIndex,
} from './pet-status-labels'
import { PET_MOTION_GROUP_UNNAMED } from '../config/pet-model-types'

describe('pet-status-labels', () => {
  it('表情 key 转中文，无则「无」', () => {
    expect(formatExpressionLabel('joy')).toBe('开心')
    expect(formatExpressionLabel('neutral')).toBe('平静')
    expect(formatExpressionLabel(undefined)).toBe('无')
  })

  it('动作类型转中文，无则「无」', () => {
    expect(formatMotionLabel({ phase: 'text-reply', motionKind: 'none' })).toBe('文字回复中')
    expect(formatMotionLabel({ phase: 'speaking', motionKind: 'talk', motionGroup: 'Idle' })).toBe(
      '语音说话中',
    )
    expect(formatMotionLabel({ phase: 'idle', motionKind: 'idle-random', motionGroup: PET_MOTION_GROUP_UNNAMED })).toBe(
      '随机扩展动作',
    )
    expect(
      formatMotionLabel({
        phase: 'idle',
        motionKind: 'idle-random',
        motionGroup: 'Idle',
        motionDetail: 'motion/04.motion3.json',
      }),
    ).toBe('打哈欠')
    expect(formatMotionLabel({ phase: 'idle', motionKind: 'none' })).toBe('无')
    expect(formatMotionLabel(null)).toBe('无')
  })

  it('resolveEmotionKeyByIndex 反查 key', () => {
    expect(resolveEmotionKeyByIndex({ neutral: 0, joy: 3 }, 3)).toBe('joy')
  })

  it('formatAvatarStatusLine 拼装完整行', () => {
    const line = formatAvatarStatusLine(
      {
        statusSeq: 1,
        phase: 'idle',
        expressionKey: 'joy',
        motionKind: 'idle-random',
        motionGroup: PET_MOTION_GROUP_UNNAMED,
        idleMotionEnabled: true,
      },
      { idleMotionEnabled: true },
    )
    expect(line).toContain('表情: 开心')
    expect(line).toContain('动作: 随机扩展动作')
  })
})
