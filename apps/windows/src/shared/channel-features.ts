/**
 * 渠道实验性功能开关的形状（10-S6 · E3）
 *
 * 这份接口此前被抄了四遍：main 的 channel-feature-store、preload 的 channel-api、
 * 渲染层的 useChannelFeatures、以及 preload/index.ts 里 declare global 的手写字面量。
 * 四份靠人肉同步——加一个开关要改四处，漏一处就是「类型说没有、运行时其实有」。
 *
 * 现在三端（main 存储 / preload 桥 / renderer 展示）都从这里取。
 * 存储位置与读写语义见 `main/channel/channel-feature-store.ts`。
 */

export interface ChannelFeatureSettings {
  /**
   * 跨渠道会话接续提示（§5.4）。
   *
   * 默认**关**：开启后会在渠道会话里主动发一条提示（「检测到你在【X】有进行中的对话…」），
   * 属于会打扰用户的实验特性，因此默认不启用。
   */
  crossChannelContinuityEnabled: boolean
}

export const DEFAULT_CHANNEL_FEATURES: ChannelFeatureSettings = {
  crossChannelContinuityEnabled: false,
}
