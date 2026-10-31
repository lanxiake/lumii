/** @vitest-environment node */
/**
 * 旧配置兼容：单值 commitWindowMs → 双端 commitMinMs/commitMaxMs。
 *
 * 背景（2026-10-31）：提交窗口改成"下限 800 / 上限 2500"双端模型，
 * 老用户磁盘上的 `{"vad":{"commitWindowMs":1200}}` 必须还能读，
 * 否则升级后窗口直接变 0（等于回到"话没说完就发"的老毛病）。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE_ENGINE_CONFIG } from '../../../shared/voice-events'

// voice-config-store 依赖 electron 路径，只测纯函数逻辑时直接复制迁移规则不划算，
// 这里通过模块导入 + 打桩路径解析来跑真实实现。
import { vi } from 'vitest'
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => process.cwd() },
}))
vi.mock('../../../main/paths.js', () => ({ resolveSharedConfigDir: () => '/tmp' }))

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadVoiceEngineConfig } from './voice-config-store'

const CONFIG_PATH = path.join('/tmp', 'voice-engine-config.json')

async function writeConfig(content: unknown) {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(content, null, 2), 'utf-8')
}

describe('提交窗口配置迁移', () => {
  it('新默认值：min=800 / max=2500', () => {
    expect(DEFAULT_VOICE_ENGINE_CONFIG.vad.commitMinMs).toBe(800)
    expect(DEFAULT_VOICE_ENGINE_CONFIG.vad.commitMaxMs).toBe(2500)
  })

  it('旧单值 commitWindowMs 映射成 min=旧值 / max=旧值×2', async () => {
    await writeConfig({ vad: { commitWindowMs: 1200 } })
    const cfg = await loadVoiceEngineConfig()
    expect(cfg.vad.commitMinMs).toBe(1200)
    expect(cfg.vad.commitMaxMs).toBe(2400)
    // 旧字段不留在结果里，否则下次保存又会写回去
    expect((cfg.vad as { commitWindowMs?: number }).commitWindowMs).toBeUndefined()
  })

  it('已显式配置新字段时不覆盖', async () => {
    await writeConfig({ vad: { commitMinMs: 600, commitMaxMs: 2000, commitWindowMs: 999 } })
    const cfg = await loadVoiceEngineConfig()
    expect(cfg.vad.commitMinMs).toBe(600)
    expect(cfg.vad.commitMaxMs).toBe(2000)
  })

  it('没有提交窗口配置时用默认值', async () => {
    await writeConfig({ vad: { threshold: 0.7 } })
    const cfg = await loadVoiceEngineConfig()
    expect(cfg.vad.commitMinMs).toBe(800)
    expect(cfg.vad.commitMaxMs).toBe(2500)
    expect(cfg.vad.threshold).toBe(0.7)
  })
})
