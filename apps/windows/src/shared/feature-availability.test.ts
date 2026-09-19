/**
 * @vitest-environment node
 */
/**
 * 能力矩阵的规格（设计 §7）。
 *
 * 纯函数的好处在这里体现：可以**穷举平台组合**而不必真的换系统。
 * 测的是「判定依据」，不是「实现细节」——每条都对应设计里的一个决策号。
 */
import { describe, it, expect } from 'vitest'
import {
  resolveFeatureAvailability,
  getFeatureBlockMessage,
  FEATURE_BLOCK_MESSAGES,
  type FeatureId,
} from './feature-availability'

const ALL_FEATURES: FeatureId[] = [
  'petMode',
  'screenRecord',
  'systemAudioCapture',
  'pythonSkills',
  'codingCliAutoInstall',
  'localTts',
  'voiceCloning',
]

describe('resolveFeatureAvailability — Windows', () => {
  const win = resolveFeatureAvailability({ platform: 'win32' })

  it('除「全平台屏蔽」外都可用的，Windows 上应可用（D13/D14/D15 是 Linux 侧决策）', () => {
    expect(win.petMode.available).toBe(true)
    expect(win.screenRecord.available).toBe(true)
    expect(win.pythonSkills.available).toBe(true)
    expect(win.codingCliAutoInstall.available).toBe(true)
    expect(win.localTts.available).toBe(true)
    expect(win.voiceCloning.available).toBe(true)
  })

  it('systemAudioCapture 在 Windows 上也屏蔽（原实现就没做，不是平台差异）', () => {
    expect(win.systemAudioCapture.available).toBe(false)
    expect(win.systemAudioCapture.reason).toBe('platform-unsupported')
  })
})

describe('resolveFeatureAvailability — Linux', () => {
  const linux = resolveFeatureAvailability({ platform: 'linux', hasSystemPython: true })

  it('D13：宠物模式屏蔽（后续以精灵图重写，不是移植现有实现）', () => {
    expect(linux.petMode.available).toBe(false)
    expect(linux.petMode.reason).toBe('platform-unsupported')
  })

  it('D14：录屏屏蔽', () => {
    expect(linux.screenRecord.available).toBe(false)
  })

  it('D15：本地 TTS 与声纹克隆屏蔽（在线 Edge TTS 不受影响）', () => {
    expect(linux.localTts.available).toBe(false)
    expect(linux.voiceCloning.available).toBe(false)
  })

  it('编码 CLI 只屏蔽「自动安装」，不是整个功能', () => {
    expect(linux.codingCliAutoInstall.available).toBe(false)
    expect(linux.codingCliAutoInstall.reason).toBe('platform-unsupported')
  })

  it('pythonSkills：有 Python 3 时可用', () => {
    const withPy = resolveFeatureAvailability({ platform: 'linux', hasSystemPython: true })

    expect(withPy.pythonSkills.available).toBe(true)
  })

  it('pythonSkills：没有 Python 3 时是 missing-runtime（而非 platform-unsupported）', () => {
    const noPy = resolveFeatureAvailability({ platform: 'linux', hasSystemPython: false })

    expect(noPy.pythonSkills.available).toBe(false)
    // 原因区分很重要：missing-runtime 装了就有，platform-unsupported 怎么试都没用，
    // 两者对用户的引导完全不同
    expect(noPy.pythonSkills.reason).toBe('missing-runtime')
  })

  it('pythonSkills：探测结果缺失时按「不可用」处理（不假设有）', () => {
    const unknown = resolveFeatureAvailability({ platform: 'linux' })

    expect(unknown.pythonSkills.available).toBe(false)
    expect(unknown.pythonSkills.reason).toBe('missing-runtime')
  })
})

describe('resolveFeatureAvailability — Wayland', () => {
  it('Wayland 会话下录屏给出专属原因（便于将来只支持 X11）', () => {
    const wayland = resolveFeatureAvailability({ platform: 'linux', waylandSession: true })

    expect(wayland.screenRecord.reason).toBe('wayland-session')
  })

  it('非 Wayland 的 Linux 上录屏原因是 platform-unsupported', () => {
    const x11 = resolveFeatureAvailability({ platform: 'linux', waylandSession: false })

    expect(x11.screenRecord.reason).toBe('platform-unsupported')
  })

  it('Wayland 只影响录屏，不影响其它功能的判定', () => {
    const a = resolveFeatureAvailability({ platform: 'linux', hasSystemPython: true })
    const b = resolveFeatureAvailability({ platform: 'linux', hasSystemPython: true, waylandSession: true })

    for (const id of ALL_FEATURES) {
      if (id === 'screenRecord') continue
      expect(b[id], id).toEqual(a[id])
    }
  })
})

describe('resolveFeatureAvailability — 无头形态（第二期预留）', () => {
  it('headless 下宠物模式屏蔽', () => {
    const headless = resolveFeatureAvailability({ platform: 'linux', headless: true })

    expect(headless.petMode.available).toBe(false)
  })

  it('headless 不影响 pythonSkills（终端里更依赖它）', () => {
    const headless = resolveFeatureAvailability({
      platform: 'linux',
      headless: true,
      hasSystemPython: true,
    })

    expect(headless.pythonSkills.available).toBe(true)
  })
})

describe('矩阵完整性', () => {
  it('每个 FeatureId 都有判定结果（新增功能忘了加分支会在这里红）', () => {
    const result = resolveFeatureAvailability({ platform: 'linux' })

    for (const id of ALL_FEATURES) {
      expect(result[id], id).toBeDefined()
      expect(typeof result[id]!.available, id).toBe('boolean')
    }
    expect(Object.keys(result).sort()).toEqual([...ALL_FEATURES].sort())
  })

  it('不可用时必有 reason（否则 UI 无法给出说明，违反 D4「禁止静默失败」）', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      const result = resolveFeatureAvailability({ platform })
      for (const id of ALL_FEATURES) {
        if (!result[id]!.available) {
          expect(result[id]!.reason, `${platform}/${id}`).toBeDefined()
        }
      }
    }
  })

  it('可用时不应带 reason（避免 UI 拿到自相矛盾的状态）', () => {
    const result = resolveFeatureAvailability({ platform: 'win32' })

    for (const id of ALL_FEATURES) {
      if (result[id]!.available) {
        expect(result[id]!.reason, id).toBeUndefined()
      }
    }
  })
})

describe('getFeatureBlockMessage', () => {
  it('受屏蔽的功能都有对应文案', () => {
    const linux = resolveFeatureAvailability({ platform: 'linux' })

    for (const id of ALL_FEATURES) {
      const entry = linux[id]!
      if (entry.available) continue
      const msg = getFeatureBlockMessage(id, entry.reason!)
      expect(msg, id).not.toBe('当前环境不支持该功能。')
    }
  })

  it('未登记的「功能+原因」组合回落到通用文案，而不是 undefined', () => {
    const msg = getFeatureBlockMessage('petMode', 'wayland-session')

    expect(msg).toBe('当前环境不支持该功能。')
  })

  it('文案给出下一步而不是只说「不支持」', () => {
    // pythonSkills 缺运行时的时候必须告诉用户装什么
    const msg = getFeatureBlockMessage('pythonSkills', 'missing-runtime')

    expect(msg).toContain('apt install')
  })

  it('每个功能的文案表都存在（新增功能别忘了加文案）', () => {
    for (const id of ALL_FEATURES) {
      expect(FEATURE_BLOCK_MESSAGES[id], id).toBeDefined()
    }
  })
})
