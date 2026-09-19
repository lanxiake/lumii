/**
 * 功能可用性能力矩阵（设计 §7，D16）。
 *
 * **为什么需要统一的矩阵**：设计 D4 要求「屏蔽入口 + 文案说明，禁止静默失败」。
 * 没有矩阵时只能到处散落 `if (process.platform !== 'win32')`，第二期加无头形态
 * 还要再加一维——判定逻辑散在各处，必然漏改。
 *
 * **纯函数**：`resolveFeatureAvailability` 的输入是探测结果（平台、是否 Wayland、
 * 运行时是否存在），不读 `process` / `fs`。这样：
 * - main 侧在 `platform/` 内探测后调用；
 * - renderer 侧通过 preload 拿只读快照；
 * - 单测可以穷举各平台组合，不需要真的换系统。
 *
 * **这是渲染层与未来客户端的契约**（D19）：第二期的无头形态、将来的精灵图桌宠、
 * 系统 Python，都往同一张表扩展，不各自发明一套。
 */

/** 功能标识（与 UI 展示一一对应） */
export type FeatureId =
  | 'petMode'
  | 'screenRecord'
  | 'systemAudioCapture'
  | 'pythonSkills'
  | 'codingCliAutoInstall'
  | 'localTts'
  | 'voiceCloning'

/**
 * 不可用原因。
 *
 * 决定 UI 文案与「是否值得重试」：`missing-runtime` 装了就有，
 * `platform-unsupported` 则怎么试都没用——两者对用户的引导完全不同。
 */
export type BlockReason =
  | 'platform-unsupported'
  | 'headless'
  | 'wayland-session'
  | 'missing-runtime'
  | 'not-implemented'

export interface FeatureAvailability {
  available: boolean
  reason?: BlockReason
}

/** 探测输入（由 main 侧收集，见 platform/feature-probe.ts） */
export interface FeatureProbeInput {
  platform: NodeJS.Platform
  /** 无图形会话（第二期的无头形态；第一期恒为 false） */
  headless?: boolean
  /** Wayland 会话（录屏/系统音频受影响） */
  waylandSession?: boolean
  /** 系统 Python 3 是否可用 */
  hasSystemPython?: boolean
}

/**
 * 屏蔽原因对应的用户文案（设计 §7.1：集中在表里，UI 直接取，避免散落）。
 *
 * 每条都给出**下一步**而不是只说「不支持」——用户看到「暂不支持」时最想知道的是
 * 「那我该怎么办」。
 */
export const FEATURE_BLOCK_MESSAGES: Record<FeatureId, Partial<Record<BlockReason, string>>> = {
  petMode: {
    'platform-unsupported': 'Linux 版暂不支持宠物模式，后续将以精灵图形态回归。',
  },
  screenRecord: {
    'platform-unsupported': 'Linux 版暂不支持录屏，可使用系统自带录屏工具。',
    'wayland-session': 'Wayland 会话下录屏需要额外授权，当前版本暂不支持。',
  },
  systemAudioCapture: {
    'platform-unsupported': '系统音频采集当前版本暂不支持，可使用麦克风录制。',
  },
  pythonSkills: {
    'missing-runtime': '需要 Python 3。请先安装：sudo apt install python3 python3-venv python3-pip',
  },
  codingCliAutoInstall: {
    'platform-unsupported': '当前平台不支持自动安装，请参考文档手动安装。',
  },
  localTts: {
    'platform-unsupported': '本地语音合成当前版本暂不支持，可使用在线语音（Edge TTS）。',
  },
  voiceCloning: {
    'platform-unsupported': '声纹克隆依赖本地语音合成，当前版本暂不支持。',
  },
}

/** 取某功能被屏蔽时的展示文案 */
export function getFeatureBlockMessage(id: FeatureId, reason: BlockReason): string {
  return FEATURE_BLOCK_MESSAGES[id]?.[reason] ?? '当前环境不支持该功能。'
}

const WIN_ONLY: FeatureAvailability = { available: true }
const blocked = (reason: BlockReason): FeatureAvailability => ({ available: false, reason })

function isLinux(platform: NodeJS.Platform): boolean {
  return platform === 'linux'
}

/**
 * 解析能力矩阵（纯函数）。
 *
 * 各功能的判定依据（设计 §7.2 的表 + D13/D14/D15 的决策）：
 *
 * | 功能 | 判定 |
 * |------|------|
 * | `petMode` | D13：Linux 屏蔽，后续以**精灵图**形态重写（不是移植现有实现） |
 * | `screenRecord` | D14：Linux 屏蔽；Wayland 会话另有单独原因（便于将来只支持 X11） |
 * | `systemAudioCapture` | **全平台**屏蔽（Windows 侧也没实现） |
 * | `pythonSkills` | Linux 上看**运行时是否存在**——装了 Python 3 就能用 |
 * | `codingCliAutoInstall` | Linux 屏蔽**自动安装**，手动指引保留 |
 * | `localTts` / `voiceCloning` | D15：屏蔽本地 TTS（依赖 sherpa-onnx 模型与 Windows 内嵌运行时） |
 */
export function resolveFeatureAvailability(
  input: FeatureProbeInput,
): Record<FeatureId, FeatureAvailability> {
  const linux = isLinux(input.platform)
  const headless = input.headless === true

  return {
    // D13：宠物模式在 Linux 上屏蔽。将来以精灵图重写后，这里改为「探测精灵图资源」。
    petMode: linux || headless ? blocked('platform-unsupported') : WIN_ONLY,

    // D14：录屏屏蔽。Wayland 单列一个原因——将来若只支持 X11，文案不用改结构。
    screenRecord: linux
      ? blocked(input.waylandSession ? 'wayland-session' : 'platform-unsupported')
      : WIN_ONLY,

    // 全平台屏蔽：Windows 侧也没有实现，不是平台差异问题。
    systemAudioCapture: blocked('platform-unsupported'),

    // Linux 上是「缺运行时」而非「不支持」——装了 Python 3 即可用，所以文案给出安装命令。
    pythonSkills: linux && input.hasSystemPython !== true ? blocked('missing-runtime') : WIN_ONLY,

    // 只屏蔽「自动安装」这一环；手动安装指引在 UI 里保留。
    codingCliAutoInstall: linux ? blocked('platform-unsupported') : WIN_ONLY,

    // D15：本地 TTS 与声纹克隆依赖本地语音合成运行时，本期在 Linux 上屏蔽。
    localTts: linux ? blocked('platform-unsupported') : WIN_ONLY,
    voiceCloning: linux ? blocked('platform-unsupported') : WIN_ONLY,
  }
}
