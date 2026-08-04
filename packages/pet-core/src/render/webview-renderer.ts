/**
 * webview-renderer — PetCoreRenderer 的 WebView 适配实现（DOM 无关）
 *
 * 把 PetCoreRenderer 的语义调用序列化为 WebViewCommand，经注入的 post 回调送进
 * WebView。post 的实现由宿主提供：浏览器预览用 iframe.contentWindow.postMessage，
 * kids-mobile 用 react-native-webview 的 injectJavaScript / postMessage。因此本类
 * 不 import 任何 DOM / RN 类型，符合 pet-core 约束。
 *
 * 参数钳制在此统一：mouth 钳到 [0,1]（NaN→0），resize 向下取整且 ≥0，
 * 避免脏值进 WebView。
 */

import type { PetCoreRenderer } from "./pet-renderer.js";
import { serializeWebViewCommand, type WebViewCommand } from "./webview-command.js";

/** 指令投递回调：宿主把序列化后的指令送进 WebView */
export type WebViewPostFn = (serialized: string) => void;

/** 钳制口型值到 [0,1]，非有限数归 0 */
function clampMouth(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** 尺寸向下取整且不小于 0 */
function normalizeSize(n: number): number {
  return Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
}

/**
 * 基于 postMessage 的 PetCoreRenderer 实现。
 * getMotionCount 在宿主侧无法同步获知（模型在 WebView 内），返回 0，
 * 随机播放交由 WebView runtime 依据模型真实动作数决定（random_motion 指令）。
 */
export class WebViewPetRenderer implements PetCoreRenderer {
  constructor(private readonly post: WebViewPostFn) {}

  private send(cmd: WebViewCommand): void {
    this.post(serializeWebViewCommand(cmd));
  }

  setExpression(expressionIndex: number): void {
    this.send({ type: "expression", index: expressionIndex });
  }

  playMotion(motionGroup: string, index?: number): void {
    this.send({ type: "motion", group: motionGroup, index });
  }

  playRandomMotion(motionGroup: string): void {
    this.send({ type: "random_motion", group: motionGroup });
  }

  getMotionCount(_motionGroup: string): number {
    return 0;
  }

  setMouthOpen(value: number): void {
    this.send({ type: "mouth", value: clampMouth(value) });
  }

  releaseLipSync(): void {
    this.send({ type: "release_lipsync" });
  }

  resize(width: number, height: number): void {
    this.send({ type: "resize", width: normalizeSize(width), height: normalizeSize(height) });
  }
}
