/**
 * `voice:event` 的**额外接收者**登记处。
 *
 * 语音事件默认只推主窗口；宠物窗是独立渲染上下文，要收口型/动画事件就得单独登记。
 * 这条登记从前放在语音插件里，宠物插件反向 import 它（守卫 ⑫ 的跨插件依赖）；
 * 现在归核心：语音插件负责推、宠物插件负责登记，谁都不用认识谁。
 */
export interface VoiceEventMirrorTarget {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
  once(event: 'destroyed', listener: () => void): unknown
}

const mirrors = new Set<VoiceEventMirrorTarget>()

/** 登记一个额外接收者（如宠物窗口），返回注销函数 */
export function addVoiceEventMirror(target: VoiceEventMirrorTarget): () => void {
  mirrors.add(target)
  target.once('destroyed', () => mirrors.delete(target))
  return () => mirrors.delete(target)
}

/** 现取的镜像集合（推事件方遍历用；已销毁的顺手摘掉） */
export function getVoiceEventMirrors(): ReadonlySet<VoiceEventMirrorTarget> {
  for (const target of mirrors) {
    if (target.isDestroyed()) mirrors.delete(target)
  }
  return mirrors
}
