/**
 * PetCoreRenderer — 宠物渲染后端的**语义子集**接口（pet-core，DOM 无关）
 *
 * pet-core 只驱动"语义渲染指令"：表情 / 动作 / 口型 / 视口尺寸。
 * 真实后端（Windows pixi 直渲、kids-mobile/浏览器 WebView）在各端私有层实现，
 * 各端接口可在此基础上**扩展** DOM 专属能力（init(canvas)/hitTest/setPosition/fps 等）。
 *
 * 约束：本接口禁止出现 DOM 类型（HTMLCanvasElement 等）。宿主端接口用
 * `extends PetCoreRenderer` 再补齐 DOM 能力，共享 PetMotionPlayedInfo 类型。
 *
 * 设计：.qoder/design/pet-core-shared-package/pet-core-公共包设计.md §5
 */

/** 动作实际播放反馈（用于控制坞展示真实动作名） */
export interface PetMotionPlayedInfo {
  readonly group: string;
  readonly index: number;
  /** motion3 文件名，如 motion/04.motion3.json */
  readonly fileName?: string;
}

/**
 * 宠物渲染后端语义接口（pet-core 逻辑层依赖此接口，不关心实现细节）。
 *
 * pet-core 的 expression policy / lipsync 只通过这些方法驱动渲染，
 * 因此本接口刻意最小化，且完全 DOM 无关，可被 Windows 与 WebView 两端复用。
 */
export interface PetCoreRenderer {
  /** 设置表情（expressionIndex 来自 emotionMap），无表情后端可空实现 */
  setExpression(expressionIndex: number): void;

  /** 播放动作（motionGroup 如 'Idle' / 'Talk'，index 可选，省略随机） */
  playMotion(motionGroup: string, index?: number): void;

  /** 随机播放动作组内一个动作（组内多动作随机选 index，否则退化为 playMotion(group)） */
  playRandomMotion(motionGroup: string): void;

  /** 读取动作组内动作数量（用于随机播放，读不到返回 0） */
  getMotionCount(motionGroup: string): number;

  /** 设置嘴部张开度（0~1），驱动 ParamMouthOpenY。由口型驱动每帧调用 */
  setMouthOpen(value: number): void;

  /**
   * 结束口型接管：清除口型激活标志并归零嘴部，之后嘴部参数交还动作驱动。
   * 无口型接管概念的后端可空实现。
   */
  releaseLipSync?(): void;

  /** 视口尺寸变化时调整（CSS 像素） */
  resize(width: number, height: number): void;
}
