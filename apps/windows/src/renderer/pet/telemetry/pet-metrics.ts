/**
 * pet-metrics - 宠物模式可观测性指标
 *
 * 设计依据：01-实施计划 §6 可观测性验收指标
 *
 * 轻量内存指标采集 + 控制台输出（dev）。供 PetDebugOverlay 与日志使用。
 * 指标：
 *  - pet_mode_switch_duration_ms（主进程已打日志）
 *  - pet_model_load_duration_ms
 *  - pet_lipsync_latency_ms
 *  - pet_render_fps
 */

const log = {
  info: (...args: unknown[]) => console.log('[pet-metrics]', ...args),
}

export interface PetMetricsSnapshot {
  modelLoadDurationMs: number
  lipSyncLatencyMs: number
  renderFps: number
  /** 当前模式切换耗时（最近一次） */
  modeSwitchDurationMs: number
}

class PetMetrics {
  private modelLoadDurationMs = 0
  private lipSyncLatencyMs = 0
  private renderFps = 0
  private modeSwitchDurationMs = 0

  recordModelLoad(durationMs: number): void {
    this.modelLoadDurationMs = Math.round(durationMs)
    log.info(`pet_model_load_duration_ms=${this.modelLoadDurationMs}`)
  }

  recordLipSyncLatency(ms: number): void {
    this.lipSyncLatencyMs = Math.round(ms)
  }

  recordRenderFps(fps: number): void {
    this.renderFps = Math.round(fps)
  }

  recordModeSwitch(durationMs: number): void {
    this.modeSwitchDurationMs = Math.round(durationMs)
  }

  snapshot(): PetMetricsSnapshot {
    return {
      modelLoadDurationMs: this.modelLoadDurationMs,
      lipSyncLatencyMs: this.lipSyncLatencyMs,
      renderFps: this.renderFps,
      modeSwitchDurationMs: this.modeSwitchDurationMs,
    }
  }
}

/** 渲染进程内单例 */
export const petMetrics = new PetMetrics()
