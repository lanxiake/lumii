/**
 * 宠物模式 — 共享类型与 IPC 契约
 *
 * 设计依据：.qoder/design/Windows客户端PET宠物模式/00-方案反思与修订版完整设计.md
 *           .qoder/design/Windows客户端PET宠物模式/03-接口与协议设计.md
 *           .qoder/design/Windows客户端PET宠物模式/06-宠物模式设置与Prompt注入设计.md
 *
 * 主进程与渲染进程共享，定义 AppMode 与 pet:* 命名空间的命令/事件契约。
 * 用户可见产品名为「宠物模式」；技术命名空间保留 pet:* 以兼容现有实现。
 */

import type { PetIdleStage } from '@mtbot/pet-core'
import type { VirtualHumanSettingsDTO } from './virtual-human'

export type { VirtualHumanSettingsDTO } from './virtual-human'

/** 应用显示模式：桌面（正常客户端 UI）/ 虚拟人（透明置顶 Live2D 窗口，技术值仍为 pet） */
export type AppMode = 'desktop' | 'pet'

/**
 * 主进程返回给渲染层的模型配置 DTO（已规范化 + URL 解析）。
 * 字段与渲染层 PetModelConfig 对齐，但 modelUrl 已是可加载的 file:///http/lumii-pet:// URL。
 *
 * 两段式扫描产物：`source` 标出模型来自内置还是用户宠物目录，
 * `shadowedBuiltin` 标出这条用户模型覆盖了一个同 id 的内置模型（供「恢复内置版本」用）。
 */
export interface PetModelConfigDTO {
  id: string
  name: string
  rendererType: 'live2d' | 'sprite'
  /**
   * 模型入口 URL：
   * 内置 → dev `/pet-models/<rel>` / 打包 `file://`
   * 用户 → `lumii-pet://model/<rel>`（见 main/pet/pet-asset-protocol.ts）
   */
  modelUrl: string
  scale: number
  idleMotionGroup: string
  idleMotionFallbackGroup?: string
  idleMotionRandomGroups?: string[]
  talkMotionGroup: string
  emotionMap: Record<string, number>
  tapMotions: Record<string, Record<string, number>>
  defaultExpression: number
  /** 作者精选的语义动作：`[motion:tag]` 的 tag → 动作组 */
  actionMotions?: Record<string, { group: string; index?: number; description?: string }>
  agentId?: string
  personaAddon?: string
  toolPrompts?: { expression?: boolean; thinkTag?: boolean }
  thumbnailUrl?: string
  /** 模型来源（两段式扫描写入） */
  source?: 'builtin' | 'user'
  /** true = 该用户模型覆盖了同 id 的内置模型 */
  shadowedBuiltin?: boolean
}

/**
 * 宠物人格 DTO。
 *
 * 宠物是**独立 Agent**（`pet:<模型ID>`，一个模型 = 一只），人格与情绪都不碰 `assistant`。
 * 只给气质标签不给五维数值——用户看到的是「好奇心重，但有点怕生」，不是 0.63。
 */
export interface PetPersonalityDTO {
  /** 内部 agentId，诊断用 */
  agentId: string
  label: string
  /**
   * 五维原始值（第二期起）。
   *
   * **是给渲染层算程序化参数的，不是给用户看的**——§3.6 的禁令「不把数值展示给用户」
   * 仍然成立，设置页只渲染 `label`。它出现在这条 DTO 上是因为渲染层与设置页共用同一个
   * IPC（多开一条只为传五维的通道不值得），**别把它读进任何 UI 组件**。
   */
  traits: {
    openness: number
    conscientiousness: number
    extraversion: number
    agreeableness: number
    neuroticism: number
  }
}

/** pet IPC 通道名常量（主进程与 preload 共用，避免散落字符串） */
export const PET_IPC = {
  /** invoke：切换模式 */
  switchMode: 'pet:switch-mode',
  /** invoke：获取当前模式 */
  getMode: 'pet:get-mode',
  /** send：渲染层报告 hover 状态（遗留，降级提示等） */
  reportHover: 'pet:report-hover',
  /** invoke：切换强制鼠标穿透 */
  toggleForceIgnoreMouse: 'pet:toggle-force-ignore-mouse',
  /** invoke：渲染层就绪通知（握手第 6 步） */
  rendererReady: 'pet:renderer-ready',
  /** invoke：获取当前模型 ID */
  getCurrentModelId: 'pet:get-current-model-id',
  /**
   * invoke：获取当前闲置阶段。
   *
   * 渲染层挂载时要主动问一次：进宠物模式时主进程那条初始阶段是在页面加载完之前
   * 发出的（`webContents.send` 直接丢掉），用户那一刻已经闲置很久的话，
   * 宠物会一直醒着——因为主进程只在**阶段变化**时才推。
   */
  getIdleStage: 'pet:get-idle-stage',
  /**
   * invoke：获取当前可攀附的矩形。
   *
   * 与 `getIdleStage` 同一族问题，而且这里**必现**：进宠物模式是「先把窗口 show 出来、
   * 紧接着就推一次矩形」，而渲染层那一刻还没加载完，`webContents.send` 直接丢掉；
   * 此后主进程只在**矩形变化**时才推（窗口静止时零流量），于是只要用户不动主窗口，
   * 宠物就永远不知道有东西可爬。渲染层挂载时补问一次即可闭合。
   */
  getPerchRect: 'pet:get-perch-rect',
  /** invoke：设置当前模型 ID */
  setCurrentModelId: 'pet:set-current-model-id',
  /** invoke：获取模型列表（含规范化 URL） */
  listModels: 'pet:list-models',
  /** invoke：获取指定模型配置 */
  getModelConfig: 'pet:get-model-config',
  /** invoke：主窗口同步当前会话 key（会话跟随） */
  setActiveSessionKey: 'pet:set-active-session-key',
  /** invoke：宠物窗口获取当前会话 key */
  getActiveSessionKey: 'pet:get-active-session-key',
  /**
   * invoke：宠物窗口请主窗口**切到某个会话**（并把它带到前台）。
   *
   * 用在多会话清单上：控制坞里列出"另有 N 个会话在跑"，点一条就跳过去。
   * 宠物窗自己切不了会话（会话状态在主窗口的 agent-runtime 里），
   * 所以这条是"宠物窗 → 主进程 → 主窗口"的转发，主进程只负责把窗口带到前台 +
   * 把 `app-ui:goto`（带 sessionKey）发给主窗。
   */
  focusSession: 'pet:focus-session',
  /** event(main→renderer)：主窗口焦点变化（见 {@link PET_IPC.evtMainWindowFocus}）。invoke 可补问一次 */
  getMainWindowFocus: 'pet:get-main-window-focus',
  /**
   * invoke：宠物窗口请主窗口**聚焦到某条待办**（通知气泡 / 控制坞条目上的按钮）。
   *
   * 与 `focusSession` 的区别只有一个：多带一个 `requestId`，主窗会把**那张审批卡**
   * 滚进视野并高亮。之所以要分开而不是给 `focusSession` 加个可选参数：
   * `focusSession` 的使用者是多会话清单（它只知道会话），而这条是"有人把我叫过来办事"。
   */
  focusNotice: 'pet:focus-notice',
  /**
   * invoke：读**当前实际生效的穿透状态**。
   *
   * 存在的理由：「桌面点不动了」那个缺陷的表现是"窗口一直不可穿透"，而
   * `setIgnoreMouseEvents` **没有 getter**——要么读日志（`[mouse] 窗口 可点/穿透`，
   * 但日志经管道落盘有块缓冲，可能压几十秒），要么靠推理。有了这条，
   * 验证脚本能直接问出事实（`check-pet-passthrough.mjs` 就用它）。
   */
  getMouseIgnoreState: 'pet:get-mouse-ignore-state',
  /** invoke：获取 Cubism Core 脚本可加载 URL */
  getCubismCoreUrl: 'pet:get-cubism-core-url',
  /** invoke：获取虚拟人设置 */
  getVirtualHumanSettings: 'pet:get-virtual-human-settings',
  /** invoke：合并写入虚拟人设置 */
  setVirtualHumanSettings: 'pet:set-virtual-human-settings',
  /** invoke：临时设置宠物窗口可聚焦（文字输入聚焦时 true，失焦恢复 false） */
  setFocusable: 'pet:set-focusable',
  /** invoke：激活指定会话的虚拟人 Prompt 上下文（文字/语音发送前调用，确保表情/persona 注入） */
  activateVirtualHumanContext: 'pet:activate-virtual-human-context',
  /** invoke：获取指定模型可触发动作映射（tag → 动作组/index），渲染层据此播放 [motion:tag] */
  getModelMotionActions: 'pet:get-model-motion-actions',
  /** invoke：读宠物人格标签（首次读即出生抽签，此后不再重掷） */
  getPetPersonality: 'pet:get-personality',
  /** event(main→renderer)：请准备切换（opacity 已置 0） */
  evtPrepare: 'pet:mode:prepare',
  /** event(main→renderer)：模式已变更 */
  evtChanged: 'pet:mode:changed',
  /** event(main→renderer)：模型热切换（不重建窗口，仅 Live2D 重载，B-3） */
  evtModelChanged: 'pet:model:changed',
  /** event(main→renderer)：虚拟人设置变更（设置页修改后推送到宠物窗口即时生效） */
  evtVhSettingsChanged: 'pet:vh-settings:changed',
  /**
   * event(main→renderer)：用户闲置阶段（打盹/睡着/醒着）。
   * 1Hz 轮询系统闲置，但**阶段没变时不发**——一天也就几条。
   */
  evtIdle: 'pet:idle',
  /**
   * event(main→renderer)：程序主窗口在宠物窗口坐标下的矩形（攀附用）。
   *
   * 用**窗口事件**驱动而不是轮询：用户拖动主窗口时宠物要跟手，
   * 低频轮询会让它一跳一跳地追。`rect` 为 null 表示当前没有可攀附的目标
   * （主窗口隐藏或最小化）——宠物在那块屏幕上没有东西可爬。
   */
  evtPerch: 'pet:perch',
  /**
   * event(main→renderer)：程序**主窗口**是否聚焦。
   *
   * 宠物窗口问不到这件事——它自己是常驻置顶的透明窗，`document.hasFocus()` 回答的是
   * **它自己**的焦点，与"用户有没有在看会话"无关。所以由主进程听主窗的 focus/blur 转过来。
   *
   * 用途是通知（R6）的两条判据：`turn:end` 的「用户发起后走开了」升级为 `report`、
   * `file-changes` 的「主窗失焦且用户没参与」才补一句。拿不到时（未广播）两条都不触发，
   * **保守方向是少打扰**。
   */
  evtMainWindowFocus: 'pet:main-window-focus',
} as const

/** 切换模式的结果 */
export interface PetModeSwitchResult {
  success: boolean
  mode: AppMode
  error?: string
  /** 切换耗时（ms），用于可观测性指标 pet_mode_switch_duration_ms */
  durationMs: number
}

/** 主进程 → 渲染进程：请准备切换（opacity 已置 0，渲染层应挂载/卸载对应视图） */
export interface PetModePrepareEvent {
  readonly type: 'pet:mode:prepare'
  targetMode: AppMode
}

/** 主进程 → 渲染进程：模式已变更（窗口属性已应用，可加载模型） */
export interface PetModeChangedEvent {
  readonly type: 'pet:mode:changed'
  mode: AppMode
  modelId: string
  timestamp: number
}

/** 主进程 → 渲染进程：虚拟人设置变更（设置页修改后即时推送宠物窗口） */
export interface PetVhSettingsChangedEvent {
  readonly type: 'pet:vh-settings:changed'
  /** 变更的设置项（只含变化的字段） */
  patch: Partial<VirtualHumanSettingsDTO>
}

/**
 * 主进程 → 渲染进程：用户闲置阶段（P2-c）。
 *
 * 只推**阶段**不推秒数：秒数每秒都在变，推它等于每秒一条 IPC。
 * 换算在 pet-core 的 `idleStage` 纯函数里，主进程只在阶段变化时发。
 */
export interface PetIdleEvent {
  readonly type: 'pet:idle'
  stage: PetIdleStage
}

/**
 * 主进程 → 渲染进程：程序主窗口的矩形（攀附目标）。
 *
 * 坐标是**宠物窗口局部坐标**（屏幕坐标已减去宠物窗口原点），与渲染层的 canvas 同一坐标系——
 * 换算留在主进程做，否则"宠物窗口在哪"这个知识要同时存在于两处。
 *
 * `rect` 为 null = 当前没有可攀附的目标（主窗口隐藏或最小化）。
 */
export interface PetPerchEvent {
  readonly type: 'pet:perch'
  rect: { x: number; y: number; width: number; height: number } | null
}

/** 主进程 → 渲染进程：程序主窗口是否聚焦（见 {@link PET_IPC.evtMainWindowFocus}） */
export interface PetMainWindowFocusEvent {
  readonly type: 'pet:main-window-focus'
  focused: boolean
}

/** 主进程 → 渲染进程：模型热切换（窗口不变，仅 Live2D 重载，B-3） */
export interface PetModelChangedEvent {
  readonly type: 'pet:model:changed'
  modelId: string
  timestamp: number
}

/** 单个可触发动作的渲染层映射（tag → 动作组/index） */
export interface PetMotionActionDTO {
  tag: string
  group: string
  index?: number
}

/** 渲染进程 → 主进程：hover 状态报告（遗留） */
export interface PetHoverUpdate {
  /** 命中的组件标识（如 'live2d-model' / 'control-panel'） */
  componentId: string
  /** 是否正悬停在可交互区域 */
  isHovering: boolean
  /** 鼠标屏幕坐标（可选，用于多显示器换算调试） */
  screenX?: number
  screenY?: number
}

/**
 * Preload 暴露给渲染进程的宠物模式 API（window.electronAPI.pet）
 */
export interface PetElectronAPI {
  /** 切换应用模式 */
  switchMode(mode: AppMode, modelId?: string): Promise<PetModeSwitchResult>
  /** 获取当前模式 */
  getMode(): Promise<AppMode>
  /** 报告组件 hover 状态（遗留） */
  reportHover(update: PetHoverUpdate): void
  /** 切换强制鼠标穿透，返回切换后的强制穿透状态 */
  toggleForceIgnoreMouse(): Promise<boolean>
  /** 渲染层就绪通知（握手用，targetMode 为正在切入的模式） */
  notifyRendererReady(targetMode: AppMode): Promise<void>
  /** 获取当前模型 ID */
  getCurrentModelId(): Promise<string>
  /** 获取当前闲置阶段（挂载时问一次；没在轮询时返回 awake） */
  getIdleStage(): Promise<PetIdleStage>
  /** 设置当前模型 ID */
  setCurrentModelId(modelId: string): Promise<void>
  /** 获取模型列表（主进程规范化后的配置，含可加载 URL） */
  listModels(): Promise<PetModelConfigDTO[]>
  /** 获取指定模型配置（modelId 为空取默认） */
  getModelConfig(modelId: string): Promise<PetModelConfigDTO | null>
  /** 主窗口同步当前会话 key（会话跟随，宠物语音用） */
  setActiveSessionKey(sessionKey: string): Promise<void>
  /** 宠物窗口获取当前会话 key（空则回退默认） */
  getActiveSessionKey(): Promise<string>
  /**
   * 请主窗口切到指定会话（并把主窗口带到前台）。
   *
   * 用在控制坞的多会话清单上。接口不可用（屏蔽平台）时静默——调用点是个可选入口。
   */
  focusSession(sessionKey: string): Promise<void>
  /**
   * 请主窗**聚焦到某条待办**：带窗口到前台 + 切会话 +（有 `requestId` 时）把那张审批卡
   * 滚进视野并高亮。
   *
   * 用在通知气泡和控制坞待办条目的按钮上。`requestId` 缺省时退化成 `focusSession`
   * ——`report` 档的通知（任务做完了）没有卡可聚焦，只需要跳到会话。
   */
  focusNotice(payload: { sessionKey: string; requestId?: string }): Promise<void>
  /**
   * 读当前实际生效的穿透状态（诊断/验证用，见 {@link PET_IPC.getMouseIgnoreState}）。
   *
   * `clickable` = 窗口此刻在**吃掉整个屏幕的点击**；`components` 是把它顶起来的
   * hover 来源（`pet-dock` / `live2d-model` / …），空数组表示没有来源、本该穿透。
   */
  getMouseIgnoreState(): Promise<{ clickable: boolean; components: string[] }>
  /** 获取 Cubism Core 脚本 URL（dev 为 /live2d/...，打包为 file://） */
  getCubismCoreUrl(): Promise<string>
  /** 获取虚拟人设置 */
  getVirtualHumanSettings(): Promise<VirtualHumanSettingsDTO>
  /** 合并写入虚拟人设置 */
  setVirtualHumanSettings(patch: Partial<VirtualHumanSettingsDTO>): Promise<VirtualHumanSettingsDTO>
  /** 临时设置宠物窗口可聚焦（文字输入聚焦时 true，失焦恢复 false） */
  setFocusable(focusable: boolean): Promise<void>
  /** 激活指定会话的虚拟人 Prompt 上下文（文字/语音发送前调用，确保表情/persona 注入） */
  activateVirtualHumanContext(sessionKey: string): Promise<void>
  /** 获取指定模型可触发动作映射（tag → 动作组/index），渲染层据此播放 [motion:tag] */
  getModelMotionActions(modelId: string): Promise<PetMotionActionDTO[]>
  /** 读宠物人格标签（首次读即出生抽签）；bridge 未就绪时为 null */
  getPetPersonality(configId: string): Promise<PetPersonalityDTO | null>
  /** 订阅模式变更事件，返回取消订阅函数 */
  onModeChanged(callback: (event: PetModeChangedEvent) => void): () => void
  /** 订阅准备切换事件，返回取消订阅函数 */
  onModePrepare(callback: (event: PetModePrepareEvent) => void): () => void
  /** 订阅模型热切换事件（控制面板/设置页触发，PetCanvas 据此重载模型） */
  onModelChanged(callback: (event: PetModelChangedEvent) => void): () => void
  /** 订阅虚拟人设置变更（设置页修改后主进程推送到宠物窗口即时生效） */
  onVhSettingsChanged(callback: (event: PetVhSettingsChangedEvent) => void): () => void
  /** 订阅用户闲置阶段（打盹/睡着）。主进程只在宠物模式且设置开启时推送 */
  onIdle(callback: (event: PetIdleEvent) => void): () => void
  /** 订阅程序主窗口矩形（攀附用）。拖动主窗口时会连续推送——那是期望的，宠物要跟手 */
  onPerch(callback: (event: PetPerchEvent) => void): () => void
  /**
   * 订阅**主窗口是否聚焦**（通知判据用，见 {@link PET_IPC.evtMainWindowFocus}）。
   *
   * ⚠️ 与 `onIdle` / `onPerch` 同一个坑：主进程只在**变化时**推，渲染层挂载时已经
   * 处于某个状态的话那次推送是丢的。所以它带一个 `getMainWindowFocus()` 补问一次——
   * 不补的话，进宠物模式前主窗就失焦的场景会一直按"聚焦"算。
   */
  onMainWindowFocus(callback: (event: PetMainWindowFocusEvent) => void): () => void
  /** 问一次主窗口当前是否聚焦（挂载时补问，理由见上） */
  getMainWindowFocus(): Promise<boolean>
  /**
   * 获取当前可攀附的矩形（挂载时问一次）。
   *
   * 必须**先订阅 `onPerch` 再问**：反过来的话，两步之间主窗口动了那次推送会丢。
   * 没在宠物模式、或主窗口隐藏时返回 null。
   */
  getPerchRect(): Promise<PetPerchEvent['rect']>
}

/** 宠物模式默认模型 ID（MVP 阶段硬编码，Phase 1 接 registry 后替换为动态默认值） */
export const PET_DEFAULT_MODEL_ID = 'default-pet'
