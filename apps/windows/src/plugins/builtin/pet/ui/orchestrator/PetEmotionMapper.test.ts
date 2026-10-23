/**
 * PetEmotionMapper 单元测试
 *
 * 覆盖：流式表情解析、跨 delta 切断标签、相邻去重、清洁文本返回、模型热切换、
 * 表情按朗读位置（atChar）发出（与动作同坐标系），message:end 兜底去重。
 *
 * 表情不再由内部定时器节流，而是同步发出（带 atChar），由编排器按朗读进度对齐触发。
 */
import { describe, it, expect, vi } from 'vitest'
import { PetEmotionMapper } from './PetEmotionMapper'

const emotionMap = { neutral: 0, joy: 3, sad: 1, anger: 2 }

describe('PetEmotionMapper', () => {
  it('单 delta 解析表情并返回清洁文本，带 atChar=0', () => {
    const onExpr = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr)
    const clean = mapper.feed('[joy]你好呀')
    expect(clean).toBe('你好呀')
    expect(onExpr).toHaveBeenCalledWith(3, 'joy', 0)
  })

  it('跨 delta 切断的标签能正确拼接解析', () => {
    const onExpr = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr)
    const c1 = mapper.feed('开心[jo')
    expect(c1).toBe('开心')
    expect(onExpr).not.toHaveBeenCalled()
    const c2 = mapper.feed('y]哈哈')
    expect(c2).toBe('哈哈')
    // "开心" 已输出 2 字 → joy 标注在 atChar=2
    expect(onExpr).toHaveBeenCalledWith(3, 'joy', 2)
  })

  it('相同表情相邻出现只发一次（去重）', () => {
    const onExpr = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr)
    mapper.feed('[joy]啊')
    mapper.feed('[joy]哦')
    expect(onExpr).toHaveBeenCalledTimes(1)
  })

  it('一个 delta 内多个表情各带递增 atChar，最后一个为 sad', () => {
    const onExpr = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr)
    mapper.feed('[joy]开心[sad]难过')
    expect(onExpr).toHaveBeenNthCalledWith(1, 3, 'joy', 0)
    // "开心" 2 字后 → sad 在 atChar=2
    expect(onExpr).toHaveBeenNthCalledWith(2, 1, 'sad', 2)
  })

  it('未知标签被忽略，不触发表情', () => {
    const onExpr = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr)
    const clean = mapper.feed('[unknown]文本')
    expect(clean).toBe('文本')
    expect(onExpr).not.toHaveBeenCalled()
  })

  it('reset 后清空缓冲、去重状态与位置', () => {
    const onExpr = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr)
    mapper.feed('一二三[joy]啊')
    mapper.reset()
    mapper.feed('[joy]哦')
    expect(onExpr).toHaveBeenCalledTimes(2)
    // reset 后偏移归零
    expect(onExpr).toHaveBeenLastCalledWith(3, 'joy', 0)
  })

  it('流式已发出表情后，applyFromFullText 兜底跳过（不重复）', () => {
    const onExpr = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr)
    mapper.feed('[joy]嗨[sad]唉')
    expect(onExpr).toHaveBeenCalledTimes(2)
    mapper.applyFromFullText('[joy]嗨[sad]唉')
    // 兜底跳过，仍为 2 次
    expect(onExpr).toHaveBeenCalledTimes(2)
  })

  it('流式未解析到表情时，applyFromFullText 兜底按均匀位置铺开', () => {
    const onExpr = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr)
    mapper.applyFromFullText('[joy]嗨[neutral]嗯[sad]唉')
    expect(onExpr).toHaveBeenCalledTimes(3)
    expect(onExpr).toHaveBeenNthCalledWith(1, 3, 'joy', expect.any(Number))
    expect(onExpr).toHaveBeenNthCalledWith(2, 0, 'neutral', expect.any(Number))
    expect(onExpr).toHaveBeenNthCalledWith(3, 1, 'sad', expect.any(Number))
    // atChar 单调不减
    const positions = onExpr.mock.calls.map((c) => c[2] as number)
    expect(positions[0]).toBeLessThanOrEqual(positions[1]!)
    expect(positions[1]).toBeLessThanOrEqual(positions[2]!)
  })

  it('表情别名 happy → joy', () => {
    const onExpr = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr)
    mapper.feed('[happy]你好')
    expect(onExpr).toHaveBeenCalledWith(3, 'joy', 0)
  })

  it('setEmotionMap 切换模型后用新映射', () => {
    const onExpr = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr)
    mapper.setEmotionMap({ joy: 9 })
    mapper.feed('[joy]嗨')
    expect(onExpr).toHaveBeenCalledWith(9, 'joy', 0)
  })

  it('解析 [motion:tag] 触发动作回调（含字符偏移），并从清洁文本剥离', () => {
    const onExpr = vi.fn()
    const onMotion = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr, onMotion)
    const clean = mapper.feed('[motion:wave]你好[joy]呀')
    expect(clean).toBe('你好呀')
    // 标签在文本流最前 → 偏移 0
    expect(onMotion).toHaveBeenCalledWith('wave', 0)
    // "你好" 2 字后 → joy 在 atChar=2
    expect(onExpr).toHaveBeenCalledWith(3, 'joy', 2)
  })

  it('跨 delta 切断的 [motion: 标签正确拼接，偏移为已输出清洁字符数', () => {
    const onExpr = vi.fn()
    const onMotion = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr, onMotion)
    const c1 = mapper.feed('嗨[motion:da')
    expect(c1).toBe('嗨')
    expect(onMotion).not.toHaveBeenCalled()
    const c2 = mapper.feed('nce]开始')
    expect(c2).toBe('开始')
    // "嗨" 已输出 1 字 → 偏移 1
    expect(onMotion).toHaveBeenCalledWith('dance', 1)
  })

  it('动作标签偏移随已读清洁文本累加（跨多 delta）', () => {
    const onExpr = vi.fn()
    const onMotion = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr, onMotion)
    mapper.feed('你好呀')          // 累计 3 字
    mapper.feed('今天[motion:nod]很好') // "今天" 2 字 → 偏移 5
    expect(onMotion).toHaveBeenCalledWith('nod', 5)
  })

  it('reset 后动作偏移归零', () => {
    const onExpr = vi.fn()
    const onMotion = vi.fn()
    const mapper = new PetEmotionMapper(emotionMap, onExpr, onMotion)
    mapper.feed('一二三四五')
    mapper.reset()
    mapper.feed('[motion:wave]嗨')
    expect(onMotion).toHaveBeenLastCalledWith('wave', 0)
  })
})
