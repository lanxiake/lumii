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

import type { VirtualHumanSettingsDTO } from './virtual-human'

export type { VirtualHumanSettingsDTO } from './virtual-human'

/** 应用显示模式：桌面（正常客户端 UI）/ 虚拟人（透明置顶 Live2D 窗口，技术值仍为 pet） */
export type AppMode = 'desktop' | 'pet'

/**
 * 主进程返回给渲染层的模型配置 DTO（已规范化 + URL 解析）。
 * 字段与渲染层 PetModelConfig 对齐，但 modelUrl 已是可加载的 file:///http URL。
 */
export interface PetModelConfigDTO {
  id: string
  name: string
  rendererType: 'live2d' | 'sprite'
  modelUrl: string
  scale: number
  idleMotionGroup: string
  idleMotionFallbackGroup?: string
  idleMotionRandomGroups?: string[]
  talkMotionGroup: string
  emotionMap: Record<string, number>
  tapMotions: Record<string, Record<string, number>>
  defaultExpression: number
  agentId?: string
  personaAddon?: string
  toolPrompts?: { expression?: boolean; thinkTag?: boolean }
  thumbnailUrl?: string
}

/** pet IPC 通道名常量（主进程与 preload 共用，避免散落字符串） */
export const PET_IPC = {
  /** invoke：切换模式 */
  switchMode: 'pet:switch-mode',
  /** invoke：获取当前模式 */
  getMode: 'pet:get-mode',
  /** send：渲染层报告 hover 状态（遗留，降级提示等） */
  reportHover: 'pet:report-hover',
  /** send：渲染层上报可点击区域矩形（setShape 区域穿透，高频单向） */
  updateClickRegion: 'pet:update-click-region',
  /** invoke：切换强制鼠标穿透 */
  toggleForceIgnoreMouse: 'pet:toggle-force-ignore-mouse',
  /** invoke：获取当前是否强制穿透 */
  getForceIgnoreMouse: 'pet:get-force-ignore-mouse',
  /** invoke：渲染层就绪通知（握手第 6 步） */
  rendererReady: 'pet:renderer-ready',
  /** invoke：获取当前模型 ID */
  getCurrentModelId: 'pet:get-current-model-id',
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
  /** event(main→renderer)：请准备切换（opacity 已置 0） */
  evtPrepare: 'pet:mode:prepare',
  /** event(main→renderer)：模式已变更 */
  evtChanged: 'pet:mode:changed',
  /** event(main→renderer)：模型热切换（不重建窗口，仅 Live2D 重载，B-3） */
  evtModelChanged: 'pet:model:changed',
  /** event(main→renderer)：强制穿透状态变更（快捷键切换时同步 UI） */
  evtForceIgnoreChanged: 'pet:force-ignore:changed',
  /** event(main→renderer)：虚拟人设置变更（设置页修改后推送到宠物窗口即时生效） */
  evtVhSettingsChanged: 'pet:vh-settings:changed',
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

/** 主进程 → 渲染进程：强制穿透状态变更 */
export interface PetForceIgnoreChangedEvent {
  readonly type: 'pet:force-ignore:changed'
  forceIgnore: boolean
}

/** 主进程 → 渲染进程：虚拟人设置变更（设置页修改后即时推送宠物窗口） */
export interface PetVhSettingsChangedEvent {
  readonly type: 'pet:vh-settings:changed'
  /** 变更的设置项（只含变化的字段） */
  patch: Partial<VirtualHumanSettingsDTO>
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

/** 渲染进程 → 主进程：可点击区域矩形（窗口坐标，用于 setShape） */
export interface PetClickRegion {
  componentId: 'live2d-model' | 'pet-dock' | 'degrade-notice'
  x: number
  y: number
  width: number
  height: number
  /** false 时主进程移除此组件区域 */
  visible: boolean
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
  /** 上报可点击区域矩形（仅宠物身体 + 控制坞参与穿透计算） */
  updateClickRegion(region: PetClickRegion): void
  /** 切换强制鼠标穿透，返回切换后的强制穿透状态 */
  toggleForceIgnoreMouse(): Promise<boolean>
  /** 获取当前是否强制穿透 */
  getForceIgnoreMouse(): Promise<boolean>
  /** 渲染层就绪通知（握手用，targetMode 为正在切入的模式） */
  notifyRendererReady(targetMode: AppMode): Promise<void>
  /** 获取当前模型 ID */
  getCurrentModelId(): Promise<string>
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
  /** 订阅模式变更事件，返回取消订阅函数 */
  onModeChanged(callback: (event: PetModeChangedEvent) => void): () => void
  /** 订阅准备切换事件，返回取消订阅函数 */
  onModePrepare(callback: (event: PetModePrepareEvent) => void): () => void
  /** 订阅强制穿透状态变更，返回取消订阅函数 */
  onForceIgnoreChanged(callback: (event: PetForceIgnoreChangedEvent) => void): () => void
  /** 订阅模型热切换事件（控制面板/设置页触发，PetCanvas 据此重载模型） */
  onModelChanged(callback: (event: PetModelChangedEvent) => void): () => void
  /** 订阅虚拟人设置变更（设置页修改后主进程推送到宠物窗口即时生效） */
  onVhSettingsChanged(callback: (event: PetVhSettingsChangedEvent) => void): () => void
}

/** 宠物模式默认模型 ID（MVP 阶段硬编码，Phase 1 接 registry 后替换为动态默认值） */
export const PET_DEFAULT_MODEL_ID = 'default-pet'
