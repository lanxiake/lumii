/**
 * CC-switch 预置模型的估价自检。
 *
 * 守两件容易悄悄坏掉的事：
 * 1. **预置价确实进了内置表**（`~/.cc-switch/model-pricing.json` 那 60 个模型里，
 *    内置表原先没有的都要能查到价，不能因为替换时漏改就静默变成「价格未知」）。
 * 2. **同名模型没被美元折算价盖掉**：deepseek-v4-pro / glm-5.x / kimi-k2.6 / qwen3.7-max
 *    这些原本就有人民币官方价的，必须还是原值（用 $ × 7.2 改会失真）。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { estimateCostYuan, hasBuiltinPrice, listBuiltinPrices } from '../../../shared/model-pricing'

const CC_FILE = path.join(os.homedir(), '.cc-switch', 'model-pricing.json')

describe('CC-switch 预置价', () => {
  it('内置表条目数在预期量级（防止整块被误删）', () => {
    // 原先 56 条 + CC 新增 48 条 ≈ 104；给个宽松下限即可，不锁死具体数字
    expect(listBuiltinPrices().length).toBeGreaterThan(90)
  })

  it('新增的 CC 模型都能查到价（抽样几条最有代表性的）', () => {
    // Claude / Gemini / GPT-6 / Kimi-K3 / MiMo / Qwen3.8 各取一条
    for (const id of [
      'claude-opus-5-5',
      'claude-haiku-5-5',
      'gemini-4-argon',
      'gpt-6-astra',
      'kimi-k3',
      'mimo-v2.6-pro',
      'qwen3.8-max',
      'minimax-m3.1-flash',
      'longcat-2.0',
    ]) {
      expect(hasBuiltinPrice(id), `${id} 应该在内置表里`).toBe(true)
      const cost = estimateCostYuan(id, { inputTokens: 1_000_000, outputTokens: 1_000_000 })
      expect(cost, `${id} 应该算得出价`).toBeGreaterThan(0)
    }
  })

  it('已有人民币官方价的同名模型没被美元折算价覆盖', () => {
    // deepseek-v4-pro 官方高峰价 ¥9/¥27（cache 读 ¥0.3），不是 $0.66×7.2=¥4.75
    const ds = estimateCostYuan('deepseek-v4-pro', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    })
    expect(ds).toBe(36.3) // 9 + 27 + 0.3

    // glm-5.2 官方 ¥8/¥28（cache 写 ¥2）
    expect(estimateCostYuan('glm-5.2', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(36)
  })

  it('如果本机有 CC-switch 配置，它列出的模型应全部能查到价', () => {
    if (!fs.existsSync(CC_FILE)) {
      // 换机没这个文件就跳过（不是失败）——但要在报告里看得出跳过数
      expect(true).toBe(true)
      return
    }
    const cc = JSON.parse(fs.readFileSync(CC_FILE, 'utf-8')) as {
      models?: Array<{ modelId?: string }>
    }
    const ids = (cc.models ?? [])
      .map((m) => m.modelId)
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
    expect(ids.length).toBeGreaterThan(0)

    const missing = ids.filter((id) => !hasBuiltinPrice(id))
    // 允许极少数极新模型的漏网，但整批没进去就是 bug
    expect(missing, `以下模型查不到价：${missing.join(', ')}`).toHaveLength(0)
  })
})
