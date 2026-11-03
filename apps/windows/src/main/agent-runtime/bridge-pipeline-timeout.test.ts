/**
 * 流水线步骤的 bash **不允许自动续期**。
 *
 * 现场（2026-11-03 真机）：`open-source-eval` 的 test 步写 `timeoutMs: 540000`，
 * journal 里却是 `1095866ms`。查日志才发现 bash 工具在截止前 60s 问了嵌套 LLM
 * 「要不要续期」，答 `{"renew":true,"extendMs":300000}` 把 deadline 往后推了。
 *
 * 这是本轮最容易搞错的诊断：现象像"超时后没杀掉子进程、工具挂住"，实际是
 * **它根本没超时**——续期把时限悄悄延长了一倍，而工具返回、journal、页面全都没有
 * 一行痕迹。确定性执行器里出现这种事，比失败更糟：用户会以为 spec 里写的时限作数。
 *
 * 所以这里钉的不是"实现细节"，而是**spec 声明的时限必须作数**。
 */
import { describe, expect, it } from 'vitest'
import { pipelineStepToolContext } from './bridge'

describe('pipelineStepToolContext', () => {
  it('摘掉 callLLM（续期询问是它触发的）', () => {
    const ctx = { callLLM: async () => '{"renew":true,"extendMs":300000}', executeCommand: () => {} }
    expect(pipelineStepToolContext(ctx).callLLM).toBeUndefined()
  })

  it('其余能力原样保留（摘过头会让 bash 根本跑不了）', () => {
    const marker = { run: () => 'x' }
    const ctx = { callLLM: async () => '', executeCommand: marker, getCwd: () => '/w' }
    const out = pipelineStepToolContext(ctx)
    expect(out.executeCommand).toBe(marker)
    expect(out.getCwd()).toBe('/w')
  })

  it('不改原对象（同一个 toolContext 还被交互会话用着）', () => {
    const original = { callLLM: async () => 'keep-me' }
    pipelineStepToolContext(original)
    expect(typeof original.callLLM).toBe('function')
  })

  it('没有 callLLM 时也不炸（老上下文 / 精简上下文）', () => {
    expect(() => pipelineStepToolContext({})).not.toThrow()
  })
})
