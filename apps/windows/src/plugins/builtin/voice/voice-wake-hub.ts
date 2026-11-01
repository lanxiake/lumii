/**
 * 语音唤醒的主进程编排：「灵栖灵栖」→ 进宠物模式 → 开始对话。
 *
 * ## 三方分工（为什么是这么切的）
 *
 * - **麦克风在渲染进程**（`getUserMedia` + AudioWorklet），主进程拿不到 →
 *   渲染层负责采集并随 `voice:audio:chunk` 推帧。
 * - **判定在主进程**（VAD + 离线 ASR 都在那儿），且要切窗口/切模式 →
 *   主进程做判定与动作。
 * - **唤醒后要"开始对话"**：宠物窗口是新加载的页面，挂载前那次 `voice:event`
 *   它收不到。所以命中先落一个**一次性标记**，宠物挂载后来 `consume`。
 *
 * ## 与通话互斥
 *
 * 唤醒和通话共用同一份 VAD/ASR（`VoiceCallService.ensureWakeEngine` 借用），
 * 两者同时跑会让段缓冲互相踩。所以：
 * - 通话开始 → `pause()`（不再喂帧，渲染层也收到 `wake:state{active:false}` 停流）
 * - 通话结束 → `resume()`（配置开着才恢复）
 */

import type { BrowserWindow } from 'electron'
import { VoiceWakeService, type WakeWordHit } from './voice-wake-service.js'
import type { VoiceCallService } from './voice-service.js'
import type { VoiceEngineConfig } from '../../../shared/voice-events.js'

const log = {
  info: (...args: unknown[]) => console.log('[VoiceWakeHub]', ...args),
  warn: (...args: unknown[]) => console.warn('[VoiceWakeHub]', ...args),
  error: (...args: unknown[]) => console.error('[VoiceWakeHub]', ...args),
}

/** 唤醒命中后保留多久，让宠物窗口来得及 consume（太短会丢，太长会隔很久才触发） */
const PENDING_TTL_MS = 30_000

export class VoiceWakeHub {
  private service: VoiceWakeService
  private active = false
  /** 一次性唤醒标记：宠物窗口挂载后 consume 掉 */
  private pending: { matched: string; rawText: string; at: number } | null = null
  /** 通话进行中时压住唤醒（不 detach 引擎，只是不喂帧） */
  private suppressed = false

  constructor(
    private readonly win: BrowserWindow,
    private readonly voice: VoiceCallService,
    /** 进宠物模式。由插件注入，避免语音插件直接依赖宠物插件实现 */
    private readonly enterPetMode: () => Promise<void>,
  ) {
    this.service = new VoiceWakeService(
      {
        ensureWakeEngine: () => this.voice.ensureWakeEngine(),
        pushVad: (samples) => this.voice.pushVadForWake(samples),
        transcribeSegment: (samples) => this.voice.transcribeForWake(samples),
      },
      (hit) => void this.onWake(hit),
    )
  }

  /** 配置是否允许唤醒（enabled 且不在通话中） */
  private configEnabled(): boolean {
    return this.voice.getConfig().wakeWord?.enabled === true
  }

  /** 渲染层请求开始听唤醒 */
  async attach(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.configEnabled()) {
      return { ok: false, reason: '唤醒词未启用' }
    }
    // 通话中不抢：VAD/ASR 与通话共用，两边同时推帧会互相踩。
    // 这里用"通话是否真的在跑"判断，而不是只看 suppressed 标志——
    // 挂断路径有很多条（用户点挂断 / micless 自动结束 / 插件卸载），标志可能漏同步。
    if (this.voice.hasActiveCall()) {
      this.suppressed = true
      return { ok: false, reason: '通话进行中' }
    }
    this.suppressed = false
    if (this.active) return { ok: true }
    try {
      await this.service.attach()
      this.active = true
      this.pushState(true)
      return { ok: true }
    } catch (e) {
      const message = (e as Error).message
      log.error(`[attach] 唤醒启动失败: ${message}`)
      this.pushState(false, message)
      return { ok: false, reason: message }
    }
  }

  detach(): void {
    this.service.detach()
    this.active = false
    this.pushState(false, '用户关闭')
  }

  /** 通话开始：压住唤醒（引擎共用，不能真 detach 掉） */
  suppress(reason: string): void {
    // 即使此刻没在听也要记下：通话结束后 unsuppress 才知道该不该恢复
    this.suppressed = true
    if (!this.active) return
    this.service.detach()
    this.active = false
    this.pushState(false, reason)
    log.info(`[suppress] 唤醒已暂停: ${reason}`)
  }

  /** 通话结束：按配置恢复 */
  unsuppress(): void {
    this.suppressed = false
    if (!this.configEnabled()) return
    if (this.voice.hasActiveCall()) return
    void this.attach()
  }

  /** 配置变更后调用：开→启动，关→停止 */
  syncWithConfig(): void {
    if (this.voice.hasActiveCall()) return
    this.suppressed = false
    if (this.configEnabled()) {
      if (!this.active) void this.attach()
    } else if (this.active) {
      this.detach()
    }
  }

  /** 渲染层推帧（走 voice:audio:chunk 的唤醒分支） */
  feed(samples: Float32Array): void {
    if (!this.active) return
    this.service.feed(samples)
  }

  isActive(): boolean {
    return this.active
  }

  /**
   * 取走一次性唤醒标记。
   * 宠物窗口挂载后调用；返回 null 表示"不是被唤醒进来的"。
   */
  consumePending(): { matched: string; rawText: string } | null {
    const p = this.pending
    this.pending = null
    if (!p) return null
    if (Date.now() - p.at > PENDING_TTL_MS) {
      log.info('[consumePending] 标记已过期，丢弃')
      return null
    }
    return { matched: p.matched, rawText: p.rawText }
  }

  private async onWake(hit: WakeWordHit): Promise<void> {
    const now = Date.now()
    this.pending = { matched: hit.matched, rawText: hit.rawText, at: now }

    this.pushEvent({
      type: 'voice:wake:detected',
      matched: hit.matched,
      rawText: hit.rawText,
      timestamp: now,
    })
    // 已经在宠物模式时，宠物窗口早就挂载好了——它收不到上面那条（那是发给主窗的），
    // 所以单独再推一份，由宠物窗口自己决定要不要再开一轮对话。
    // 推成功就把一次性标记清掉：否则用户 30s 内退出再进宠物模式，会莫名其妙
    // 自动起一次通话（标记是给「窗口还没创建」那条路径用的）。
    if (await this.pushToPetWindow({
      type: 'voice:wake:detected',
      matched: hit.matched,
      rawText: hit.rawText,
      timestamp: now,
    })) {
      this.pending = null
    }

    log.info(`[onWake] 唤醒命中 "${hit.matched}"`)

    // 抑制自己：接下来麦克风要交给宠物通话，唤醒不该继续抢同一份引擎
    this.suppress('唤醒后进入对话')

    try {
      await this.enterPetMode()
    } catch (e) {
      log.error(`[onWake] 进入宠物模式失败: ${(e as Error).message}`)
    }
  }

  /** 只推给宠物窗口（与主窗同一份 preload，订阅同一套 voice:event）；true = 确实推到了 */
  private async pushToPetWindow(event: unknown): Promise<boolean> {
    try {
      const { getPetWindowManager } = await import('../pet/pet-mode-ipc')
      const petWin = getPetWindowManager()?.getPetBrowserWindow()
      if (!petWin || petWin.isDestroyed()) return false
      petWin.webContents.send('voice:event', event)
      return true
    } catch {
      /* 宠物插件停用：没有窗口可推 */
      return false
    }
  }

  private pushState(active: boolean, reason?: string): void {
    const event = { type: 'voice:wake:state', active, ...(reason ? { reason } : {}) }
    this.pushEvent(event)
    void this.pushToPetWindow(event)
  }

  private pushEvent(event: unknown): void {
    if (this.win.isDestroyed()) return
    try {
      this.win.webContents.send('voice:event', event)
    } catch (e) {
      log.error(`[pushEvent] 推送失败: ${(e as Error).message}`)
    }
  }
}
