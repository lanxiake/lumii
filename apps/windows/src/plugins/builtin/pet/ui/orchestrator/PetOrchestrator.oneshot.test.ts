/**
 * PetOrchestrator 的**一次性动作**接线（2026-09-24）。
 *
 * 这一组钉的是三件事，缺一件都会静默退化：
 *
 * 1. **触发对不对**：drowsy → 打哈欠、从 asleep 醒来 → 伸懒腰、Agent 卡住 → 挠头。
 * 2. **让位出口必须挂在前面**：`playOneShotMotion` 在没有让位出口时**什么都不播**
 *    （宁可不播，也不播成"一边平移一边打哈欠"）。少了这条断言，"忘了接出口"
 *    会表现成"动作全都没有"，而日志里只有一行 info。
 * 3. **克制**：张望有冷却，鼠标扫过不会每帧都触发。
 *
 * ⚠ 单独一个文件、不去改 `PetOrchestrator.test.ts`：那是并行会话也在动的文件，
 * 两边同时 `Edit` 同一个文件就是在赌谁先写。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PetOrchestrator } from './PetOrchestrator'
import type { PetRendererProvider } from '../renderer/types'
import type { PetModelConfig } from '../config/pet-model-types'

function createMockRenderer(groups: readonly string[] = ['Yawn', 'Stretch', 'Scratch', 'Look']) {
  const motions: string[] = []
  const renderer = {
    motions,
    init: vi.fn(),
    loadModel: vi.fn(),
    playMotion: vi.fn((g: string) => motions.push(g)),
    // 只有清单里那几个组"存在"——模型没声明的组必须被静默跳过
    getMotionCount: vi.fn((g: string) => (groups.includes(g) ? 16 : 0)),
    playRandomMotion: vi.fn((g: string) => motions.push(g)),
    setExpression: vi.fn(),
    setMouthOpen: vi.fn(),
    hitTest: vi.fn(() => null),
    isPointerOverModel: vi.fn(() => false),
    resize: vi.fn(),
    setPosition: vi.fn(),
    getPosition: vi.fn(() => ({ x: 0, y: 0 })),
    getModelScreenBounds: vi.fn(() => null),
    setFpsCap: vi.fn(),
    getCurrentFps: vi.fn(() => 60),
    isModelLoaded: vi.fn(() => true),
    setMotionPlayedListener: vi.fn(),
    destroy: vi.fn(),
  } as unknown as PetRendererProvider & { motions: string[] }
  return renderer
}

const testConfig: PetModelConfig = {
  id: 'test',
  name: 'Test',
  rendererType: 'sprite',
  modelUrl: 'x',
  scale: 0.2437,
  idleMotionGroup: 'Idle',
  talkMotionGroup: 'Talk',
  emotionMap: {},
  tapMotions: {},
  defaultExpression: 0,
}

/** 可控时钟：张望的冷却要能被推过去 */
let now = 1000

function makeOrch(groups?: readonly string[]) {
  const renderer = createMockRenderer(groups)
  const orch = new PetOrchestrator(renderer)
  orch.setModelConfig(testConfig)
  const holds: number[] = []
  orch.setOneShotAmbientHold((ms) => holds.push(ms))
  orch.start()
  renderer.motions.length = 0 // start 会播一次待机，不算数
  return { renderer, orch, holds }
}

describe('PetOrchestrator — 一次性动作的触发', () => {
  beforeEach(() => {
    now = 1000
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('window', { electronAPI: undefined })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('进入 drowsy → 打哈欠，并且**先按住宿主再播**', () => {
    const { renderer, orch, holds } = makeOrch()
    orch.setIdleStage('drowsy')

    expect(renderer.motions).toContain('Yawn')
    // 让位时长必须是正数且覆盖得住动作本身（2.0s）
    expect(holds).toHaveLength(1)
    expect(holds[0]).toBeGreaterThanOrEqual(2000)
    orch.dispose()
  })

  it('从 asleep 醒来 → 伸懒腰', () => {
    const { renderer, orch } = makeOrch()
    orch.setIdleStage('asleep')
    renderer.motions.length = 0

    orch.setIdleStage('awake')
    expect(renderer.motions).toContain('Stretch')
    orch.dispose()
  })

  it('drowsy → awake **不是**醒来（没睡过），不播伸懒腰', () => {
    const { renderer, orch } = makeOrch()
    orch.setIdleStage('drowsy')
    renderer.motions.length = 0

    orch.setIdleStage('awake')
    expect(renderer.motions).not.toContain('Stretch')
    orch.dispose()
  })

  it('Agent 卡住 → 挠头；同一档位重复推送只播一次', () => {
    const { renderer, orch } = makeOrch()
    orch.pushAgentActivity({ type: 'error' })
    expect(renderer.motions.filter((m) => m === 'Scratch')).toHaveLength(1)

    // 再推一次 error：档位没变，`changed` 会挡住——否则每帧重播一次挠头
    orch.pushAgentActivity({ type: 'error' })
    expect(renderer.motions.filter((m) => m === 'Scratch')).toHaveLength(1)
    orch.dispose()
  })

  it('**没有让位出口就一个都不播**——宁可不播，也不播成边走边演', () => {
    const renderer = createMockRenderer()
    const orch = new PetOrchestrator(renderer)
    orch.setModelConfig(testConfig)
    orch.start()
    renderer.motions.length = 0

    orch.setIdleStage('drowsy')
    orch.pushAgentActivity({ type: 'error' })
    expect(renderer.motions).not.toContain('Yawn')
    expect(renderer.motions).not.toContain('Scratch')
    orch.dispose()
  })

  it('模型没声明这一组时静默跳过（Live2D 一条都没有）', () => {
    const { renderer, orch, holds } = makeOrch([])
    orch.setIdleStage('drowsy')
    orch.pushAgentActivity({ type: 'error' })

    expect(renderer.motions).not.toContain('Yawn')
    expect(renderer.motions).not.toContain('Scratch')
    // 关键：**连让位都不该按**——按了却什么都不播，就是白按住宠物 2.6 秒
    expect(holds).toHaveLength(0)
    orch.dispose()
  })

  it('张望有冷却：同一秒内靠近多次只播一次，过了冷却才再播', () => {
    const { renderer, orch } = makeOrch()
    orch.playLookMotion()
    orch.playLookMotion()
    orch.playLookMotion()
    expect(renderer.motions.filter((m) => m === 'Look')).toHaveLength(1)

    now += 19_000
    orch.playLookMotion()
    expect(renderer.motions.filter((m) => m === 'Look')).toHaveLength(1)

    now += 2_000 // 累计 21s > 20s 冷却
    orch.playLookMotion()
    expect(renderer.motions.filter((m) => m === 'Look')).toHaveLength(2)
    orch.dispose()
  })
})
