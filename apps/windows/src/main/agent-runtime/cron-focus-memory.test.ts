/**
 * cron focus → 工作记忆边界单测。
 */
import { describe, expect, it } from 'vitest'
import {
  CRON_JOBS_SKIP_FOCUS_MEMORY,
  isCronFocusMemoryNoise,
  purgeCronFocusNoiseMemories,
  shouldSkipCronFocusMemoryWrite,
} from './cron-focus-memory'

describe('cron-focus-memory', () => {
  it('识别定时任务 focus 写入的工作记忆噪声', () => {
    expect(isCronFocusMemoryNoise('每周复盘：汇总本周完成的事项、遗留问题和下周计划，生成一份复盘。')).toBe(true)
    expect(isCronFocusMemoryNoise('早间简报：汇总我今天需要关注的事项，生成一份早间简报。')).toBe(true)
    expect(isCronFocusMemoryNoise('Lumii 使用指南完善：位于 outputs/Lumii使用指南')).toBe(false)
  })

  it('预置简报类任务跳过 focus 写记忆', () => {
    expect(CRON_JOBS_SKIP_FOCUS_MEMORY.has('seed-daily-report')).toBe(true)
    expect(
      shouldSkipCronFocusMemoryWrite({
        jobId: 'seed-daily-report',
        jobName: '工作日报整理',
        taskText: '整理我今天的工作进度，生成一份简短日报。',
        output: '今天完成\n- 修了 bug',
      }),
    ).toBe(true)
  })

  it('产出仍为任务指令时不写记忆', () => {
    expect(
      shouldSkipCronFocusMemoryWrite({
        jobName: '自定义任务',
        taskText: '做点什么',
        output: '做点什么',
      }),
    ).toBe(true)
  })

  it('purgeCronFocusNoiseMemories 删除带任务名前缀的条目', () => {
    const store = [
      { id: 'm1', content: '工作日报整理：整理我今天的工作进度，生成一份简短日报。' },
      { id: 'm2', content: '知识库整理：用户计划将 outputs 目录下的文件整理到知识库' },
    ]
    const removed = purgeCronFocusNoiseMemories({
      listActive: () => store,
      deleteMemory: (id) => {
        const idx = store.findIndex((e) => e.id === id)
        if (idx >= 0) store.splice(idx, 1)
      },
    })
    expect(removed).toBe(1)
    expect(store.map((e) => e.id)).toEqual(['m2'])
  })
})
