/**
 * 无会话偏好时的压缩参数回退。
 *
 * 定时任务 / 进化 / 子 Agent / 后台渠道会话从不经过 UI 的 `prime`，原先一律落到
 * 硬编码的 `DEFAULT_SESSION_COMPACTION`（200K）。用户把模型窗口配成 256K 后，
 * 这些会话仍按 200K 算可压缩预算 —— 预算偏小会让压缩触发得过早，白丢对话历史。
 * 实测 2026-09-20：同一个 `Qwen3.8-Flash-Next`，UI 打开过的会话解析出 256K，
 * 同期 `cron:agent-self:*` 解析出 200K。
 */

/** @vitest-environment node */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const loadProviderConfig = vi.hoisted(() => vi.fn())
vi.mock('../provider-config.js', () => ({ loadProviderConfig }))

import { BridgeSessionModelCatalog } from './bridge-session-model-catalog.js'

/** 只给被测逻辑用得到的字段 */
function slot(over: Record<string, unknown> = {}): never {
  return { enabled: true, type: 'openai', allowedModelIds: [], modelReasoning: {}, ...over } as never
}

describe('无会话偏好时的压缩窗口回退', () => {
  beforeEach(() => {
    loadProviderConfig.mockReset()
  })

  it('用 chat 槽默认模型的窗口，而不是硬编码 200K', () => {
    loadProviderConfig.mockReturnValue(
      slot({ modelId: 'Qwen3.8-Flash-Next', contextWindowK: { 'Qwen3.8-Flash-Next': 256 } }),
    )
    const catalog = new BridgeSessionModelCatalog()

    expect(catalog.getCompactionForRootSession('cron:agent-self:job').contextWindow).toBe(256_000)
  })

  it('会话级偏好优先于默认模型', () => {
    loadProviderConfig.mockReturnValue(
      slot({
        modelId: 'Qwen3.8-Flash-Next',
        contextWindowK: { 'Qwen3.8-Flash-Next': 256, 'deepseek-v4-flash': 1048 },
      }),
    )
    const catalog = new BridgeSessionModelCatalog()
    catalog.primeSessionModelCompaction('ui-opened-session', 'deepseek-v4-flash')

    expect(catalog.getCompactionForRootSession('ui-opened-session').contextWindow).toBe(1_048_000)
  })

  it('配置里连默认模型都没有时才落到硬编码兜底', () => {
    loadProviderConfig.mockReturnValue(slot())
    const catalog = new BridgeSessionModelCatalog()

    expect(catalog.getCompactionForRootSession('unknown').contextWindow).toBe(200_000)
  })

  it('模型目录刷新后，无偏好的会话跟着新配置重新解析（不吃旧窗口）', () => {
    loadProviderConfig.mockReturnValue(slot({ modelId: 'm1', contextWindowK: { m1: 128 } }))
    const catalog = new BridgeSessionModelCatalog()
    expect(catalog.getCompactionForRootSession('s').contextWindow).toBe(128_000)

    // 用户把窗口调到 256K，随后目录同步
    loadProviderConfig.mockReturnValue(slot({ modelId: 'm1', contextWindowK: { m1: 256 } }))
    catalog.setModelCatalogFromApi([{ id: 'm1', contextWindow: 256_000 }])

    expect(catalog.getCompactionForRootSession('s').contextWindow).toBe(256_000)
  })

  it('模型目录刷新不会动有会话偏好的会话', () => {
    loadProviderConfig.mockReturnValue(slot({ modelId: 'm1', contextWindowK: { m1: 128, m2: 512 } }))
    const catalog = new BridgeSessionModelCatalog()
    catalog.primeSessionModelCompaction('pinned', 'm2')

    loadProviderConfig.mockReturnValue(slot({ modelId: 'm1', contextWindowK: { m1: 999, m2: 512 } }))
    catalog.setModelCatalogFromApi([{ id: 'm1', contextWindow: 999_000 }])

    // 会话自己的选择不受默认模型变化影响
    expect(catalog.getCompactionForRootSession('pinned').contextWindow).toBe(512_000)
  })
})
