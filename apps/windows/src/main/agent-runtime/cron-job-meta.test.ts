import { describe, expect, it } from 'vitest'
import { classifyCronJobSource, getCronJobManagedBy, isReseededCronJob } from './cron-job-meta'

describe('classifyCronJobSource', () => {
  it('系统播种任务识别为 system', () => {
    for (const id of [
      'news-pipeline',
      'autonomous-tick',
      'seed-morning-briefing',
      'seed-focus-check',
      'wiki-purge-broken-refs',
      'wiki-purge-invalid-files',
      'companion-tick',
      'companion-memory-fast',
    ]) {
      expect(classifyCronJobSource(id), id).toBe('system')
    }
  })

  it('Agent 自建任务识别为 agent', () => {
    expect(classifyCronJobSource('agent-self:1789222884334-0ikjlow')).toBe('agent')
    expect(classifyCronJobSource('local-cron-1789224893621-kjgd6d')).toBe('agent')
  })

  it('用户任务与未知 id 落 user', () => {
    expect(classifyCronJobSource('5f1c7e2a-3b4d-4c5e-8f90-123456789abc')).toBe('user')
    expect(classifyCronJobSource('我的提醒')).toBe('user')
    // seed / companion 只按前缀匹配，不吞掉相似命名
    expect(classifyCronJobSource('seeder')).toBe('user')
    expect(classifyCronJobSource('companionship')).toBe('user')
  })
})

describe('getCronJobManagedBy', () => {
  it('自主进化托管的任务', () => {
    expect(getCronJobManagedBy('autonomous-tick')).toBe('autonomous')
    expect(getCronJobManagedBy('agent-self:x')).toBe('autonomous')
  })

  it('主动联系托管的只有 companion-tick', () => {
    expect(getCronJobManagedBy('companion-tick')).toBe('companion')
    expect(getCronJobManagedBy('companion-memory-fast')).toBeNull()
  })

  it('其余任务用户自管', () => {
    expect(getCronJobManagedBy('seed-focus-check')).toBeNull()
    expect(getCronJobManagedBy('user-uuid')).toBeNull()
  })
})

describe('isReseededCronJob', () => {
  it('存在性播种的任务删除后会重建，UI 需隐藏删除', () => {
    expect(isReseededCronJob('autonomous-tick')).toBe(true)
    expect(isReseededCronJob('companion-tick')).toBe(true)
    expect(isReseededCronJob('companion-memory-fast')).toBe(true)
    // companion 播种组里的 wiki 清理任务（前缀不叫 companion）
    expect(isReseededCronJob('wiki-purge-broken-refs')).toBe(true)
  })

  it('有种子哨兵或用户创建的任务删除后不重建', () => {
    expect(isReseededCronJob('seed-morning-briefing')).toBe(false)
    expect(isReseededCronJob('wiki-purge-invalid-files')).toBe(false)
    expect(isReseededCronJob('agent-self:x')).toBe(false)
    expect(isReseededCronJob('user-uuid')).toBe(false)
  })
})
