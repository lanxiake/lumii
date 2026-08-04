/**
 * PetWindowManager - 宠物模式独立窗口管理
 *
 * 设计依据：.qoder/design/Windows客户端PET宠物模式/00-方案反思与修订版完整设计.md §2.2/§2.3
 *
 * 架构决策（偏离 ADR-01 的"同窗口切换"）：
 *   Electron 的 transparent 属性创建后不可变，无法在运行时把已存在的 mainWindow 改透明。
 *   故采用「独立宠物窗口」：mainWindow 完全不动（仅 hide/show），宠物模式新建一个
 *   transparent:true 的置顶穿透窗口覆盖桌面。这样桌面 UI 零回归，退出即销毁/隐藏，
 *   还原天然完整，无需 snapshot。
 *
 * 唯一职责：窗口生命周期 + 透明/置顶/穿透 + 多显示器覆盖 + 握手时序。
 * 不含任何 IPC 注册（由 pet-mode-ipc.ts 调用本类方法）。
 */

import { BrowserWindow, screen } from 'electron'
import {
  type AppMode,
  type PetClickRegion,
  type PetForceIgnoreChangedEvent,
  type PetHoverUpdate,
  type PetModeChangedEvent,
  type PetModelChangedEvent,
  type PetModePrepareEvent,
  type PetVhSettingsChangedEvent,
  type VirtualHumanSettingsDTO,
  PET_IPC,
  PET_DEFAULT_MODEL_ID,
} from '../../shared/pet-mode'
import { addVoiceEventMirror } from '../voice/voice-service'
import { setStoredModelId, getVirtualHumanSettings, setVirtualHumanSettings } from './pet-mode-store'

const log = {
  info: (...args: unknown[]) => console.log('[PetWindowManager]', ...args),
  warn: (...args: unknown[]) => console.warn('[PetWindowManager]', ...args),
  error: (...args: unknown[]) => console.error('[PetWindowManager]', ...args),
}

/** 依赖注入：本类不直接持有 mainWindow，避免与 index.ts 的单例耦合 */
export interface PetWindowManagerDeps {
  /** 获取主窗口（桌面模式窗口），用于进入宠物模式时隐藏、退出时还原显示 */
  getMainWindow: () => BrowserWindow | null
  /** preload 脚本绝对路径 */
  preloadPath: string
  /** dev 模式下的渲染进程 URL（process.env.ELECTRON_RENDERER_URL），生产为 undefined */
  rendererUrl?: string
  /** 生产模式下 index.html 的绝对路径 */
  indexHtmlPath: string
  /** 强制穿透状态变更时通知（托盘菜单同步） */
  onForceIgnoreChanged?: (forceIgnore: boolean) => void
  /** 模式变更时通知（托盘菜单文案 + 主窗口设置页同步）；所有切换路径统一走此回调 */
  onModeChanged?: (mode: AppMode) => void
}

/** 渲染就绪握手的超时兜底（ms）：渲染层迟迟不回 ready 时强制继续，避免卡死 */
const RENDERER_READY_TIMEOUT_MS = 8000

export class PetWindowManager {
  private petWindow: BrowserWindow | null = null
  private currentMode: AppMode = 'desktop'
  /** 强制穿透：开启后仅宠物身体穿透，控制坞始终可点击 */
  private forceIgnore = false
  /** 各可交互组件 hover 状态（聚合决定穿透，pet-dock 与 live2d-model 互不覆盖） */
  private readonly hoveringComponents = new Set<string>()
  private currentModelId: string = PET_DEFAULT_MODEL_ID
  /** 渲染就绪握手的 resolve 句柄（waitForRendererReady 期间有效） */
  private rendererReadyResolve: (() => void) | null = null
  /** voice:event 镜像注销函数 */
  private voiceMirrorOff: (() => void) | null = null
  /** 当前活跃会话 key（主窗口同步，宠物语音跟随用） */
  private activeSessionKey = ''

  constructor(private readonly deps: PetWindowManagerDeps) {}

  getMode(): AppMode {
    return this.currentMode
  }

  getCurrentModelId(): string {
    return this.currentModelId
  }

  setCurrentModelId(modelId: string, persist = false): void {
    if (modelId && modelId !== this.currentModelId) {
      log.info(`[setCurrentModelId] 模型切换 ${this.currentModelId} → ${modelId}`)
      this.currentModelId = modelId
      if (persist) setStoredModelId(modelId)
      // 若宠物窗口已存在，广播热切换事件（Live2D 重载，B-3）
      const win = this.getPetBrowserWindow()
      if (win) this.sendModelChanged(win, modelId)
      // 已有活跃会话时，刷新其 VH 上下文，使表情列表/persona 跟随新模型（环4）
      if (this.activeSessionKey) {
        void import('./virtual-human-context')
          .then(({ activateVirtualHumanContextForSession }) =>
            activateVirtualHumanContextForSession(this.activeSessionKey),
          )
          .catch(() => {})
      }
    }
  }

  isForceIgnore(): boolean {
    return this.forceIgnore
  }

  setActiveSessionKey(sessionKey: string): void {
    if (sessionKey) this.activeSessionKey = sessionKey
  }

  getActiveSessionKey(): string {
    return this.activeSessionKey
  }

  /** 获取宠物模式 BrowserWindow（用于镜像 agent-runtime 事件等） */
  getPetBrowserWindow(): BrowserWindow | null {
    if (!this.petWindow || this.petWindow.isDestroyed()) return null
    return this.petWindow
  }

  /**
   * 计算宠物窗口覆盖范围（覆盖全部显示器的工作区）。
   *
   * 关键：用 display.workArea 而非 bounds，workArea 已排除任务栏/托盘区。
   * 这样宠物窗口物理上不覆盖系统托盘，托盘/音量调节等始终可点击，
   * 从根上避免整窗穿透翻转时误吃托盘点击（见 [applyMouseIgnoreState] 次保险）。
   *
   * 多显示器时取所有 workArea 的最小外接矩形，原点可能为负（副屏在主屏左侧/上方）。
   */
  private computeWorkAreaBounds(): Electron.Rectangle {
    const displays = screen.getAllDisplays()
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const d of displays) {
      const { x, y, width, height } = d.workArea
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + width)
      maxY = Math.max(maxY, y + height)
    }
    if (!Number.isFinite(minX)) {
      // 兜底：取主显示器工作区
      const primary = screen.getPrimaryDisplay().workArea
      return { ...primary }
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }

  /**
   * 光标是否落在任一显示器的"保留区"（bounds 与 workArea 的差集，即任务栏/托盘带）。
   * 次保险：多显示器并集矩形仍可能覆盖某屏任务栏，此时即便 hover 到模型也强制穿透，
   * 保证托盘/任务栏点击不被宠物窗口拦截。
   */
  private isCursorInReservedArea(): boolean {
    const pt = screen.getCursorScreenPoint()
    for (const d of screen.getAllDisplays()) {
      const b = d.bounds
      const w = d.workArea
      // 光标在该显示器物理范围内，但落在 workArea 之外 → 任务栏/托盘带
      const inDisplay = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height
      if (!inDisplay) continue
      const inWorkArea = pt.x >= w.x && pt.x < w.x + w.width && pt.y >= w.y && pt.y < w.y + w.height
      return !inWorkArea
    }
    return false
  }

  /** 创建透明置顶穿透宠物窗口（初始隐藏 + opacity 0，等待握手后再显示） */
  private createPetWindow(): BrowserWindow {
    const bounds = this.computeWorkAreaBounds()
    log.info(
      `[createPetWindow] 创建宠物窗口, 覆盖工作区(排除任务栏) bounds=${bounds.width}x${bounds.height}@(${bounds.x},${bounds.y})`,
    )

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      opacity: 0,
      // 透明穿透窗口默认不抢焦点；控制面板交互时再按需恢复
      focusable: true,
      webPreferences: {
        preload: this.deps.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false,
      },
    })

    // 置于最高层，覆盖普通窗口
    win.setAlwaysOnTop(true, 'screen-saver')
    // 在所有工作区可见（多虚拟桌面）
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // 默认全窗穿透；勿用 setShape（会裁剪绘制区域导致 Live2D 不可见）
    this.clearWindowShape(win)
    win.setIgnoreMouseEvents(true, { forward: true })

    win.on('closed', () => {
      log.info('[createPetWindow] 宠物窗口已关闭')
      this.voiceMirrorOff?.()
      this.voiceMirrorOff = null
      this.petWindow = null
    })

    win.webContents.on('render-process-gone', (_evt, details) => {
      log.error(
        `[createPetWindow] 渲染进程崩溃 reason=${details.reason} exitCode=${details.exitCode}`,
      )
    })
    win.webContents.on('console-message', (_evt, level, message, line, sourceId) => {
      const tag = `[pet:renderer] ${message}`
      if (level >= 3) log.error(tag, `(${sourceId}:${line})`)
      else if (level === 2) log.warn(tag)
      else log.info(tag)
    })
    win.webContents.on('preload-error', (_evt, preloadPath, error) => {
      log.error(`[createPetWindow] preload 错误 path=${preloadPath} error=${error?.message}`)
    })
    win.webContents.on('did-fail-load', (_evt, code, desc, url) => {
      log.error(`[createPetWindow] 宠物页面加载失败 code=${code} desc=${desc} url=${url}`)
    })
    win.webContents.on('unresponsive', () => {
      log.error('[createPetWindow] 宠物窗口无响应')
    })
    win.webContents.on('responsive', () => {
      log.info('[createPetWindow] 宠物窗口恢复响应')
    })

    // 注册为 voice:event 镜像接收者，使宠物窗口能收到 TTS chunk / 语音状态做口型与动画
    this.voiceMirrorOff = addVoiceEventMirror(win.webContents)

    this.loadPetRenderer(win)
    return win
  }

  /** 加载渲染进程，附加 ?mode=pet，使 main.tsx 仅挂载 PetModeShell */
  private loadPetRenderer(win: BrowserWindow): void {
    if (this.deps.rendererUrl) {
      const sep = this.deps.rendererUrl.includes('?') ? '&' : '?'
      win.loadURL(`${this.deps.rendererUrl}${sep}mode=pet`)
    } else {
      win.loadFile(this.deps.indexHtmlPath, { query: { mode: 'pet' } })
    }
  }

  /** 等待渲染层 ready（notifyRendererReady 触发），带超时兜底 */
  private waitForRendererReady(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        this.rendererReadyResolve = null
        resolve()
      }
      this.rendererReadyResolve = finish
      setTimeout(() => {
        if (!settled) {
          log.warn('[waitForRendererReady] 渲染就绪握手超时，强制继续')
          finish()
        }
      }, RENDERER_READY_TIMEOUT_MS)
    })
  }

  /** 渲染层就绪回调（由 IPC 层在收到 pet:renderer-ready 时调用） */
  notifyRendererReady(targetMode: AppMode): void {
    log.info(`[notifyRendererReady] 渲染层就绪, targetMode=${targetMode}`)
    this.rendererReadyResolve?.()
  }

  /**
   * 进入宠物模式（握手时序）：
   *   1. 创建宠物窗口（隐藏 + opacity 0）
   *   2. 发送 prepare 事件
   *   3. 等待渲染层 ready
   *   4. 应用穿透/置顶属性
   *   5. 显示宠物窗口 + opacity 1
   *   6. 隐藏主窗口（在宠物窗口可见后，避免桌面闪烁）
   *   7. 广播 changed 事件
   */
  async enterPetMode(modelId?: string): Promise<void> {
    if (this.currentMode === 'pet') {
      log.warn('[enterPetMode] 已处于宠物模式，忽略')
      return
    }
    if (modelId) this.setCurrentModelId(modelId)

    // 复用已存在的隐藏窗口（快速再进入），否则新建
    if (!this.petWindow || this.petWindow.isDestroyed()) {
      this.petWindow = this.createPetWindow()
      const readyPromise = this.waitForRendererReady()
      this.sendPrepare(this.petWindow, 'pet')
      await readyPromise
    } else {
      // 复用路径：窗口仍在，刷新覆盖范围即可
      this.petWindow.setBounds(this.computeWorkAreaBounds())
    }

    const win = this.petWindow
    if (!win || win.isDestroyed()) {
      throw new Error('宠物窗口创建失败')
    }

    this.clearWindowShape(win)
    win.setIgnoreMouseEvents(true, { forward: true })
    this.hoveringComponents.clear()
    // 应用持久化的强制穿透默认值（设置页可配置，见需求3）
    this.forceIgnore = getVirtualHumanSettings().forceIgnoreMouse
    win.setAlwaysOnTop(true, 'screen-saver')
    win.showInactive()
    win.setOpacity(1)

    // 宠物窗口已可见，再隐藏主窗口，避免中间帧露出空桌面
    this.deps.getMainWindow()?.hide()

    this.currentMode = 'pet'
    // 广播当前完整 VH 设置，确保宠物窗口拿到最新的持久化配置（设置页在桌面模式修
    // 改后不会实时广播；此处兜底推送完整快照，覆盖 idleMotion/tap/voice 等所有开关）
    this.broadcastVhSettingsChanged(getVirtualHumanSettings())
    this.sendChanged(win, 'pet')
    this.deps.onModeChanged?.('pet')
    log.info('[enterPetMode] 已进入宠物模式')
  }

  /**
   * 退出宠物模式：还原主窗口显示，隐藏宠物窗口（保留实例以加速再进入）。
   * 主窗口属性自始至终未被修改，无需 snapshot 还原。
   */
  async exitPetMode(): Promise<void> {
    if (this.currentMode === 'desktop') {
      log.warn('[exitPetMode] 已处于桌面模式，忽略')
      return
    }

    const main = this.deps.getMainWindow()
    if (main && !main.isDestroyed()) {
      main.show()
      main.focus()
    } else {
      log.warn('[exitPetMode] 主窗口不可用，无法还原桌面')
    }

    const win = this.petWindow
    if (win && !win.isDestroyed()) {
      win.setOpacity(0)
      win.hide()
      // 隐藏后通知渲染层暂停高频渲染（Phase 2+ 生效）
      this.sendChanged(win, 'desktop')
    }

    this.currentMode = 'desktop'
    this.forceIgnore = false
    this.hoveringComponents.clear()
    this.clearWindowShape(win ?? undefined)
    // 同步通知主窗口当前模式（供 App 状态/托盘联动）
    this.sendChanged(main, 'desktop')
    this.deps.onModeChanged?.('desktop')
    log.info('[exitPetMode] 已退出宠物模式，桌面已还原')
  }

  /**
   * hover 穿透控制：按组件聚合。
   * - pet-dock / degrade-notice：悬停时恢复点击（控制坞始终可操作）
   * - live2d-model：非强制穿透时悬停恢复点击（宠物身体可拖/可点）
   * - 其余区域保持穿透（forward mousemove 仍可用于 hitTest）
   */
  reportHover(update: PetHoverUpdate): void {
    if (this.currentMode !== 'pet') return

    if (update.isHovering) {
      this.hoveringComponents.add(update.componentId)
    } else {
      this.hoveringComponents.delete(update.componentId)
    }
    this.applyMouseIgnoreState()
  }

  /** 遗留 API：setShape 会裁剪绘制，不再使用 */
  updateClickRegion(_region: PetClickRegion): void {
    // no-op
  }

  /** 清除 setShape，恢复全窗口绘制（setShape 会裁剪像素导致模型不可见） */
  private clearWindowShape(win?: BrowserWindow): void {
    const target = win ?? this.petWindow
    if (!target || target.isDestroyed()) return
    try {
      target.setShape([])
    } catch {
      // 忽略
    }
  }

  /** 根据聚合 hover 应用窗口鼠标穿透（不使用 setShape） */
  private applyMouseIgnoreState(): void {
    const win = this.petWindow
    if (!win || win.isDestroyed() || this.currentMode !== 'pet') return

    const uiHover =
      this.hoveringComponents.has('pet-dock') || this.hoveringComponents.has('degrade-notice')
    const bodyHover = this.hoveringComponents.has('live2d-model') && !this.forceIgnore

    // 次保险：即便 hover 到模型/控制坞，若光标落在任务栏/托盘带（保留区），
    // 强制穿透，避免宠物窗口拦截托盘/音量点击（多显示器并集矩形残余覆盖）。
    // 控制坞真实位于工作区内，不会落入保留区，故不受影响。
    if ((uiHover || bodyHover) && !this.isCursorInReservedArea()) {
      win.setIgnoreMouseEvents(false)
    } else {
      win.setIgnoreMouseEvents(true, { forward: true })
    }
  }

  /**
   * 显式设置强制穿透状态（设置页开关用），可选是否持久化。
   * @param persist true 时写入 pet-mode-store 作为默认值（见需求3）
   */
  setForceIgnoreMouse(forceIgnore: boolean, persist = true): boolean {
    this.forceIgnore = forceIgnore
    this.applyMouseIgnoreState()
    this.broadcastForceIgnoreChanged()
    this.deps.onForceIgnoreChanged?.(forceIgnore)
    if (persist) setVirtualHumanSettings({ forceIgnoreMouse: forceIgnore })
    log.info(`[setForceIgnoreMouse] 强制穿透=${forceIgnore} persist=${persist}`)
    return forceIgnore
  }

  /** 切换强制穿透，返回切换后的状态（同时持久化为默认值，见需求3） */
  toggleForceIgnoreMouse(): boolean {
    return this.setForceIgnoreMouse(!this.forceIgnore)
  }

  /** 关闭强制穿透（托盘「退出穿透」专用，已是关闭状态时 no-op） */
  disableForceIgnoreMouse(): boolean {
    if (!this.forceIgnore) return false
    this.forceIgnore = false
    this.applyMouseIgnoreState()
    this.broadcastForceIgnoreChanged()
    this.deps.onForceIgnoreChanged?.(false)
    log.info('[disableForceIgnoreMouse] 已关闭强制穿透')
    return false
  }

  /** 向宠物窗口广播强制穿透状态（快捷键切换时同步控制面板 UI） */
  private broadcastForceIgnoreChanged(): void {
    const win = this.petWindow
    if (!win || win.isDestroyed()) return
    const evt: PetForceIgnoreChangedEvent = {
      type: 'pet:force-ignore:changed',
      forceIgnore: this.forceIgnore,
    }
    win.webContents.send(PET_IPC.evtForceIgnoreChanged, evt)
  }

  /** 向宠物窗口广播虚拟人设置变更（设置页修改后即时生效，无需重启宠物模式） */
  broadcastVhSettingsChanged(patch: Partial<VirtualHumanSettingsDTO>): void {
    const win = this.petWindow
    if (!win || win.isDestroyed()) return
    const evt: PetVhSettingsChangedEvent = {
      type: 'pet:vh-settings:changed',
      patch,
    }
    win.webContents.send(PET_IPC.evtVhSettingsChanged, evt)
    log.info(`[broadcastVhSettingsChanged] 已推送设置变更: ${JSON.stringify(patch)}`)
  }

  /** 应用退出时销毁宠物窗口，释放 GPU/WebGL 资源 */
  dispose(): void {
    if (this.petWindow && !this.petWindow.isDestroyed()) {
      this.petWindow.destroy()
    }
    this.petWindow = null
    this.rendererReadyResolve = null
  }

  /**
   * 临时设置宠物窗口键盘焦点（文字输入用）。
   * 透明窗口以 showInactive 创建不抢焦点，输入框聚焦时需 focus() 才能接收键盘；
   * 失焦时 blur() 归还焦点，避免遮挡其他应用。穿透由 hover/region 机制另行控制。
   */
  setFocusable(focusable: boolean): void {
    const win = this.petWindow
    if (!win || win.isDestroyed() || this.currentMode !== 'pet') return
    if (focusable) {
      win.setIgnoreMouseEvents(false)
      win.focus()
    } else {
      win.blur()
      this.applyMouseIgnoreState()
    }
  }

  private sendPrepare(win: BrowserWindow | null, targetMode: AppMode): void {
    if (!win || win.isDestroyed()) return
    const evt: PetModePrepareEvent = { type: 'pet:mode:prepare', targetMode }
    win.webContents.send(PET_IPC.evtPrepare, evt)
  }

  private sendChanged(win: BrowserWindow | null, mode: AppMode): void {
    if (!win || win.isDestroyed()) return
    const evt: PetModeChangedEvent = {
      type: 'pet:mode:changed',
      mode,
      modelId: this.currentModelId,
      timestamp: Date.now(),
    }
    win.webContents.send(PET_IPC.evtChanged, evt)
  }

  private sendModelChanged(win: BrowserWindow, modelId: string): void {
    if (win.isDestroyed()) return
    const evt: PetModelChangedEvent = {
      type: 'pet:model:changed',
      modelId,
      timestamp: Date.now(),
    }
    win.webContents.send(PET_IPC.evtModelChanged, evt)
    log.info(`[sendModelChanged] 模型热切换事件已发送 modelId=${modelId}`)
  }
}
