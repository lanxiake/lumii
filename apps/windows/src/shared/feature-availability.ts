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
  /** 无图形会话（第二期无头形态：`--headless` 启动，或 Linux 上没有 DISPLAY） */
  headless?: boolean
  /** Wayland 会话（录屏/系统音频受影响） */
  waylandSession?: boolean
  /** 系统 Python 3 是否可用 */
  hasSystemPython?: boolean
  /** 应用 Python venv 是否就绪（Linux 运行时对等：Qwen3/声纹克隆等宿主级 Python 能力的前提） */
  pythonVenvReady?: boolean
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
    'headless': '无头模式没有图形界面，宠物模式不可用；需要它请以桌面模式启动。',
  },
  screenRecord: {
    'wayland-session': 'Wayland 会话下录屏需要额外授权，当前版本暂不支持。',
    'headless': '无头模式没有屏幕可录；需要录屏请以桌面模式启动。',
  },
  systemAudioCapture: {
    'platform-unsupported': '系统音频采集当前版本暂不支持，可使用麦克风录制。',
  },
  pythonSkills: {
    'missing-runtime': '需要 Python 3。请先安装：sudo apt install python3 python3-venv python3-pip',
  },
  // D26（二期运行时对等）：自动安装已有 Linux 配方（`platform/shell-command` +
  // 各工具官方命令），不再有平台屏蔽。条目保留以维持「每功能都有文案表」的约定。
  codingCliAutoInstall: {
    'platform-unsupported': '当前平台不支持自动安装，请参考文档手动安装。',
  },
  // D26：sherpa-onnx 在打包产物中实测可加载（含 asar），本地 TTS（MeloTTS/local-vits）
  // 在 Linux 上可用，不再有平台屏蔽。条目保留以维持约定。
  localTts: {
    'platform-unsupported': '本地语音合成当前版本暂不支持，可使用在线语音（Edge TTS）。',
  },
  // D15 → D26：声纹克隆（Qwen3）依赖宿主级 Python 运行链路。
  // Windows 走内置运行时（始终可用）；Linux 在应用 venv 就绪前按 missing-runtime 屏蔽。
  voiceCloning: {
    'missing-runtime': '声纹克隆需要本地 Python 运行环境（Qwen3 引擎），当前环境尚未就绪。',
  },
}

/** 取某功能被屏蔽时的展示文案 */
export function getFeatureBlockMessage(id: FeatureId, reason: BlockReason): string {
  return FEATURE_BLOCK_MESSAGES[id]?.[reason] ?? '当前环境不支持该功能。'
}

const AVAILABLE: FeatureAvailability = { available: true }
const blocked = (reason: BlockReason): FeatureAvailability => ({ available: false, reason })

function isLinux(platform: NodeJS.Platform): boolean {
  return platform === 'linux'
}

/**
 * 解析能力矩阵（纯函数）。
 *
 * 各功能的判定依据（设计 §7.2 的表 + D13/D14/D15/D26 的决策）：
 *
 * | 功能 | 判定 |
 * |------|------|
 * | `petMode` | D13：Linux 屏蔽，后续以**精灵图**形态重写（不是移植现有实现）；**无头形态下也屏蔽**（没有窗口可挂，理由单列） |
 * | `screenRecord` | D14 **修订**（2026-09-20）：X11 实测可用 → 改为**按会话类型**判定，仅 Wayland 屏蔽；**无头形态下屏蔽**（没有屏幕可录） |
 * | `systemAudioCapture` | **全平台**屏蔽（Windows 侧也没实现） |
 * | `pythonSkills` | Linux 上看**运行时是否存在**——装了 Python 3 就能用 |
 * | `codingCliAutoInstall` | D26：Linux 配方已落地（官方脚本 / npm），**全平台可用** |
 * | `localTts` | D26：sherpa-onnx 打包实测可加载，**全平台可用**（MeloTTS/local-vits） |
 * | `voiceCloning` | D15 → D26：依赖宿主级 Python（Windows 内置运行时 / Linux 应用 venv 就绪） |
 */
export function resolveFeatureAvailability(
  input: FeatureProbeInput,
): Record<FeatureId, FeatureAvailability> {
  const linux = isLinux(input.platform)
  const headless = input.headless === true

  return {
    // D13：宠物模式在 Linux 上屏蔽。将来以精灵图重写后，这里改为「探测精灵图资源」。
    // 无头形态下没有窗口可挂，理由单列（与平台无关，所以先判 headless）。
    petMode: headless ? blocked('headless') : linux ? blocked('platform-unsupported') : AVAILABLE,

    // D14 修订（2026-09-20）：X11 下实测跑通（捕获 + 音频 + 成片 + 中文烧字幕），
    // 由「Linux 全屏蔽」改为「**按会话类型**判定」——只有 Wayland 仍屏蔽
    // （桌面捕获的授权模型不同，第一期不接；原因单列，将来只支持 X11 时文案不用改结构）。
    screenRecord: !linux
      ? AVAILABLE
      : headless
        ? blocked('headless')
        : input.waylandSession === true
          ? blocked('wayland-session')
          : AVAILABLE,

    // 全平台屏蔽：Windows 侧也没有实现，不是平台差异问题。
    systemAudioCapture: blocked('platform-unsupported'),

    // Linux 上是「缺运行时」而非「不支持」——装了 Python 3 即可用，所以文案给出安装命令。
    pythonSkills: linux && input.hasSystemPython !== true ? blocked('missing-runtime') : AVAILABLE,

    // D26：Linux 配方已落地（platform/shell-command + 各工具官方命令）。
    codingCliAutoInstall: AVAILABLE,

    // D26：sherpa-onnx 在打包产物（含 asar）中实测可加载，本地 TTS 全平台可用。
    localTts: AVAILABLE,

    // D15 → D26：Qwen3/克隆依赖宿主级 Python 链路。Windows 走内置运行时（始终可用）；
    // Linux 看应用 venv 是否就绪（首次触发语音下载/合成时会自动创建）。
    voiceCloning: linux
      ? input.pythonVenvReady === true
        ? AVAILABLE
        : blocked('missing-runtime')
      : AVAILABLE,
  }
}
