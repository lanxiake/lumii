/**
 * 关键交互计时（渲染层核心侧）
 *
 * 为什么在核心而不是 perf 插件里：要打点的地方是 ChatPage / switch-session，
 * 而渲染层核心不允许 import 插件实现（守卫 ⑭）。这里只依赖 preload 暴露的
 * `performance.recordEvent`——插件停用时该通道不存在，调用静默失败，业务零感知。
 *
 * 只在超过阈值时上报：交互慢是「用户能感觉到卡」的那种慢，几百毫秒的抖动记了也没用。
 */

export type InteractionName =
  | 'send-message'
  | 'switch-session'
  | 'open-workspace-panel'
  | 'first-token'

/** 用户能感知到的本地卡顿门槛 */
const INTERACTION_THRESHOLD_MS = 500

/**
 * `first-token` 的门槛比其他交互高一个量级。
 *
 * 它量的是「发出 → 模型出第一个字」，**大头是模型往返而不是本地耗时**。
 * 实测一次普通回合就有 5.8 秒，用 500ms 判它只会得到一条永远为真的噪音。
 * 只在这个量级才说明「这事不对劲」（超时、排队、上游卡住）。
 */
const FIRST_TOKEN_THRESHOLD_MS = 10_000

const THRESHOLDS: Record<InteractionName, number> = {
  'send-message': INTERACTION_THRESHOLD_MS,
  'switch-session': INTERACTION_THRESHOLD_MS,
  'open-workspace-panel': INTERACTION_THRESHOLD_MS,
  'first-token': FIRST_TOKEN_THRESHOLD_MS,
}

const starts = new Map<InteractionName, number>()

function report(name: InteractionName, duration: number): void {
  const api = window.electronAPI?.performance
  if (!api?.recordEvent) return
  void api
    .recordEvent({ kind: 'renderer.interaction', name, duration: Math.round(duration) })
    .catch(() => {
      // 扩展停用 / preload 版本不匹配：静默
    })
}

/** 记下交互起点。同名重复调用只保留最早那个，避免嵌套把起点推后。 */
export function markInteractionStart(name: InteractionName): void {
  if (starts.has(name)) return
  starts.set(name, performance.now())
}

/** 交互结束：超过该交互自己的阈值才上报，无论是否上报都会清掉起点 */
export function markInteractionEnd(name: InteractionName): void {
  const start = starts.get(name)
  if (start === undefined) return
  starts.delete(name)
  const duration = performance.now() - start
  if (duration < THRESHOLDS[name]) return
  report(name, duration)
}

/** 丢掉起点，不上报（交互被取消时用） */
export function abortInteraction(name: InteractionName): void {
  starts.delete(name)
}

/**
 * 等两帧再结束计时。
 *
 * 用两帧：第一帧是本次更新的提交，第二帧才真正画出去。只等一帧会把渲染耗时漏掉。
 * 起点由调用方在前面 `markInteractionStart` 打，这里只负责收尾。
 */
export function markInteractionEndOnNextPaint(name: InteractionName): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => markInteractionEnd(name))
  })
}
