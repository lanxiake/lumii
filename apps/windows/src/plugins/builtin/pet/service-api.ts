import type { PetWindowManager } from './pet-window-manager'
import type {
  disablePetForceIgnore,
  disposePetModeIpc,
  isPetForceIgnore,
  isPetMode,
  onVirtualHumanSettingsChanged,
  switchPetMode,
} from './pet-mode-ipc'
import type {
  getStoredModelId,
  getVirtualHumanSettings,
  setVirtualHumanSettings,
} from './pet-mode-store'
import type { currentPetAgentId } from './pet-subject'
import type { getVirtualHumanContext } from './virtual-human-activation'
import type { renderVirtualHumanPromptSection } from './virtual-human-context'
import type { describeRoots, isPetAssetOp, runPetAssetOp } from './pet-asset-ipc'
import type { loadPetModelRegistry } from './pet-model-resolver'

/**
 * 桌宠插件对核心暴露的能力。
 *
 * 核心用到它的地方分五块：窗口（事件镜像/控制口/托盘）、模式（开关与穿透）、
 * 虚拟人（设置与提示词段）、身份（`pet:<模型>` 的 agentId）、资产（协议与模型运维）。
 *
 * 插件停用 ⇒ 服务消失 ⇒ 这些路径全部按「没有桌宠」处理：
 * 没有窗口可推、提示词段不注入、托盘项不出现、资产协议不注册。
 *
 * 签名一律用 `typeof` 指向插件内的实现，避免两处手抄漂移。
 */
export interface PetService {
  // ── 窗口 / 模式 ────────────────────────────────────────────────
  getWindowManager(): PetWindowManager | null
  isPetMode: typeof isPetMode
  isForceIgnoreMouse: typeof isPetForceIgnore
  disableForceIgnoreMouse: typeof disablePetForceIgnore
  switchMode: typeof switchPetMode
  disposeIpc: typeof disposePetModeIpc

  // ── 虚拟人（提示词与设置） ──────────────────────────────────────
  onVirtualHumanSettingsChanged: typeof onVirtualHumanSettingsChanged
  getStoredModelId: typeof getStoredModelId
  getVirtualHumanSettings: typeof getVirtualHumanSettings
  setVirtualHumanSettings: typeof setVirtualHumanSettings
  getVirtualHumanContext: typeof getVirtualHumanContext
  renderVirtualHumanPromptSection: typeof renderVirtualHumanPromptSection

  // ── 身份 ──────────────────────────────────────────────────────
  currentAgentId: typeof currentPetAgentId

  // ── 资产协议（主进程注册 + 控制口运维） ─────────────────────────
  assetScheme: string
  registerAssetProtocol(): void
  loadModelRegistry: typeof loadPetModelRegistry
  isAssetOp: typeof isPetAssetOp
  runAssetOp: typeof runPetAssetOp
  describeAssetRoots: typeof describeRoots
}
