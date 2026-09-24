/**
 * 宠物受理判断的单测。
 *
 * 本模块是纯的（零 IO），所以这里**不建库、不 mock**——如果哪天要 mock，
 * 说明有人在 `pet-task.ts` 里加了副作用，那正是这个文件要守住的东西。
 */

import { describe, expect, it } from 'vitest'

import {
  PET_TASK_ASSUMED_DIFFICULTY,
  PET_TASK_MAX_CHARS,
  PET_TASK_MIN_SAMPLES,
  PET_TASK_RESULT_MAX_CHARS,
  PET_TASK_TOO_LONG_REASON,
  PET_TASK_WEAK_LEVEL,
  PET_TASK_WEAK_REASON,
  buildPetTaskMetadata,
  classifyPetRequest,
  decidePetTask,
  petTaskQuotaReason,
  readPetTaskMetadata,
  withPetTaskResult,
  type PetTaskBoundary,
} from '../pet-task'
import { CapabilityDimension } from '../types'

/** 一只"什么都还没做过"的宠物：`decidePetTask` 的边界参数用 null 表示，不是 0.5 */
const NO_HISTORY: null = null

describe('classifyPetRequest —— 判不出就不判', () => {
  it('命中单一维度时给出它', () => {
    expect(classifyPetRequest('看看测试挂了没')).toBe(CapabilityDimension.CODE_GENERATION)
    expect(classifyPetRequest('帮我搜一下这个库怎么用')).toBe(CapabilityDimension.WEB_SEARCH)
    expect(classifyPetRequest('这个文档讲了啥')).toBe(CapabilityDimension.DOCUMENT_ANALYSIS)
    expect(classifyPetRequest('这批日志里有多少条报错')).toBeNull()
    expect(classifyPetRequest('这批数据统计一下')).toBe(CapabilityDimension.DATA_PROCESSING)
    expect(classifyPetRequest('这个 api 的鉴权怎么配')).toBe(CapabilityDimension.API_INTEGRATION)
    expect(classifyPetRequest('帮我起名，要三个')).toBe(CapabilityDimension.CREATIVE_WRITING)
    expect(classifyPetRequest('为什么这里要这么写')).toBe(CapabilityDimension.LOGICAL_REASONING)
    expect(classifyPetRequest('帮我安排一下这周的步骤')).toBe(CapabilityDimension.MULTI_STEP_PLANNING)
  })

  it('并列时返回 null —— 宁可判不出，不要判错', () => {
    // 「文档」→ document_analysis，「接口」→ api_integration，各 1 分
    expect(classifyPetRequest('看看这个接口的文档')).toBeNull()
    /**
     * 这条是**真实的并列**，不是构造的：`日志` 属 data_processing、`报错` 属
     * code_generation，各 1 分。它确实两边都像——一边是"翻日志"这件事，
     * 一边是"错误"这个内容。
     *
     * ⚠ **别为了让这句话分类成功去调词表**。判不出只是"这次不做能力判断"，
     * 而随手把 `报错` 挪进 data_processing 会让"看看测试为什么报错"也跟着挪过去——
     * 用一个已知的错换掉一个已知的漏，而错的代价更大（见 pet-task.ts 文件头）。
     */
    expect(classifyPetRequest('这批日志里有多少条报错')).toBeNull()
  })

  it('零命中返回 null', () => {
    expect(classifyPetRequest('在吗')).toBeNull()
    expect(classifyPetRequest('   ')).toBeNull()
    expect(classifyPetRequest('')).toBeNull()
  })

  it('按出现次数计分，不按"有没有"', () => {
    // 「文档」1 次（document），「测试」2 次（code）→ code 胜
    expect(classifyPetRequest('测试没通过，顺便看看文档里的测试说明')).toBe(
      CapabilityDimension.CODE_GENERATION,
    )
  })

  it('大小写不敏感（api / API / Api 都算）', () => {
    expect(classifyPetRequest('这个 API 怎么调')).toBe(CapabilityDimension.API_INTEGRATION)
    expect(classifyPetRequest('这个 Api 怎么调')).toBe(CapabilityDimension.API_INTEGRATION)
  })

  it('同一关键词重复出现按多次计', () => {
    // 只有 code_generation 有分，重复不改变归属（这条钉的是"计数"而非"去重"）
    expect(classifyPetRequest('测试测试测试')).toBe(CapabilityDimension.CODE_GENERATION)
  })
})

describe('decidePetTask —— 两张拦网', () => {
  it('没有历史时一律接受（第 0 天不该张口就说不会）', () => {
    const decision = decidePetTask('看看测试挂了没', NO_HISTORY)
    expect(decision.accept).toBe(true)
    expect(decision.accept && decision.dimension).toBe(CapabilityDimension.CODE_GENERATION)
  })

  it('判不出维度也照收 —— 只是这笔账不记在任何维度上', () => {
    const decision = decidePetTask('在吗', NO_HISTORY)
    expect(decision.accept).toBe(true)
    expect(decision.accept && decision.dimension).toBeNull()
  })

  it('样本不够时不拒 —— 哪怕 level 已经很低', () => {
    const boundary: PetTaskBoundary = { level: 0.1, testCount: PET_TASK_MIN_SAMPLES - 1 }
    expect(decidePetTask('看看测试挂了没', boundary).accept).toBe(true)
  })

  it('样本够了且 level 低于线 → 拒，并说设计原话那句', () => {
    const boundary: PetTaskBoundary = { level: PET_TASK_WEAK_LEVEL - 0.01, testCount: PET_TASK_MIN_SAMPLES }
    const decision = decidePetTask('看看测试挂了没', boundary)
    expect(decision.accept).toBe(false)
    expect(decision.accept === false && decision.reason).toBe(PET_TASK_WEAK_REASON)
  })

  it('边界正好压线不拒（`<` 不是 `<=`）', () => {
    const boundary: PetTaskBoundary = { level: PET_TASK_WEAK_LEVEL, testCount: PET_TASK_MIN_SAMPLES }
    expect(decidePetTask('看看测试挂了没', boundary).accept).toBe(true)
  })

  it('样本够了且 level 高 → 接受', () => {
    const boundary: PetTaskBoundary = { level: 0.8, testCount: 30 }
    expect(decidePetTask('看看测试挂了没', boundary).accept).toBe(true)
  })

  it('太长先拦，且拒的是**范围**不是长度', () => {
    const long = '看看测试'.repeat(PET_TASK_MAX_CHARS)
    const decision = decidePetTask(long, NO_HISTORY)
    expect(decision.accept).toBe(false)
    expect(decision.accept === false && decision.reason).toBe(PET_TASK_TOO_LONG_REASON)
    // 即使在能力上完全够格，长度这一条也先拦——两条判断的顺序是刻意的
    expect(decidePetTask(long, { level: 0.9, testCount: 99 }).accept).toBe(false)
  })

  it('长度按**码点**算，emoji 不会被算成两个字', () => {
    // 200 个 emoji = 200 码点（`String.length` 会是 400）
    const emojis = '🐾'.repeat(PET_TASK_MAX_CHARS)
    expect([...emojis].length).toBe(PET_TASK_MAX_CHARS)
    expect(decidePetTask(emojis, NO_HISTORY).accept).toBe(true)
    // 多一个码点就越线
    expect(decidePetTask(emojis + '🐾', NO_HISTORY).accept).toBe(false)
  })

  it('首尾空白不参与长度判定', () => {
    const padded = `   ${'看'.repeat(PET_TASK_MAX_CHARS)}   `
    expect(decidePetTask(padded, NO_HISTORY).accept).toBe(true)
  })

  it('难度口径是"不知道"（0.5），不是"中等偏上"', () => {
    // 这条钉的是那个常量的**含义**：它是 Logistic 的中点，改它会静默改变
    // `PET_TASK_WEAK_LEVEL` 对应的成功率（见 pet-task.ts 的注释）
    expect(PET_TASK_ASSUMED_DIFFICULTY).toBe(0.5)
  })
})

describe('petTaskQuotaReason —— 早退时的说法与派发侧同义', () => {
  it('带上"几次"和"上限"，且是可读的中文', () => {
    const reason = petTaskQuotaReason(5, 5)
    expect(reason).toContain('5')
    expect(reason).toContain('上限 5')
  })
})

describe('PetTaskMetadata —— 落库载荷', () => {
  it('受理时写下的只有 source 与 dimension', () => {
    const raw = buildPetTaskMetadata(CapabilityDimension.WEB_SEARCH)
    expect(JSON.parse(raw)).toEqual({ source: 'pet-task', dimension: 'web_search' })
  })

  it('判不出维度时照写（null 是有意义的值，不是缺字段）', () => {
    const parsed = readPetTaskMetadata(buildPetTaskMetadata(null))
    expect(parsed?.dimension).toBeNull()
  })

  it('回执写上去之后，dimension 还在', () => {
    const created = buildPetTaskMetadata(CapabilityDimension.CODE_GENERATION)
    const finished = withPetTaskResult(created, false, '今日目标已用满（5/5）', '2026-09-24T10:00:00.000Z')
    const parsed = readPetTaskMetadata(finished)
    expect(parsed?.dimension).toBe(CapabilityDimension.CODE_GENERATION)
    expect(parsed?.result).toEqual({
      ok: false,
      text: '今日目标已用满（5/5）',
      at: '2026-09-24T10:00:00.000Z',
    })
  })

  it('metadata 坏了也照写回执 —— 回执比维度重要', () => {
    const finished = withPetTaskResult('{ 这不是 JSON', true, '测试全过', '2026-09-24T10:00:00.000Z')
    const parsed = readPetTaskMetadata(finished)
    expect(parsed?.result?.text).toBe('测试全过')
    expect(parsed?.dimension).toBeNull()
  })

  it('不是宠物任务的 metadata 一律读成 null（别把别人的行当成自己的回执）', () => {
    expect(readPetTaskMetadata('{"source":"reflection-suggestion"}')).toBeNull()
    expect(readPetTaskMetadata('{"plannedBy":"planner"}')).toBeNull()
    expect(readPetTaskMetadata('{}')).toBeNull()
    expect(readPetTaskMetadata(null)).toBeNull()
    expect(readPetTaskMetadata(undefined)).toBeNull()
  })

  it('别人写进来的维度名不认识时归零，不原样透传', () => {
    const parsed = readPetTaskMetadata('{"source":"pet-task","dimension":"telepathy"}')
    expect(parsed?.dimension).toBeNull()
  })

  it('回执正文按码点截断到上限', () => {
    const long = '报'.repeat(PET_TASK_RESULT_MAX_CHARS + 500)
    const parsed = readPetTaskMetadata(withPetTaskResult(null, true, long, '2026-09-24T10:00:00.000Z'))
    expect([...(parsed?.result?.text ?? '')].length).toBe(PET_TASK_RESULT_MAX_CHARS)
  })

  it('ok 只认真正的 true（缺字段 = 没做成，不是"默认成功"）', () => {
    const parsed = readPetTaskMetadata(
      '{"source":"pet-task","dimension":null,"result":{"text":"x","at":"t"}}',
    )
    expect(parsed?.result?.ok).toBe(false)
  })
})
