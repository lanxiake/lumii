/**
 * webview-command — pet-core ↔ Live2D WebView 指令协议（DOM 无关）
 *
 * PetCoreRenderer 的语义调用（表情/动作/口型/尺寸）序列化为本协议，通过
 * postMessage 送进 WebView（浏览器预览 / kids-mobile RN WebView）。指令字段
 * 与 pixi-live2d-display 的 model API 对齐（motion(group,index) / expression(index)），
 * 因此 WebView runtime 可直接派发，无需二次翻译。
 *
 * 与 kids-mobile 早期 live2dBridge（name-based）区别：本协议用 group+index，
 * 与 PetCoreRenderer / Windows Live2dPetRenderer 完全一致，作为公共包统一协议。
 *
 * 健壮性：出站序列化对未知类型抛错（脏指令不进 WebView）；入站解析对脏数据返回
 * null（不抛错，避免 WebView 异常打断宿主渲染）。
 */

/** pet-core → WebView 指令 */
export type WebViewCommand =
  | { readonly type: "motion"; readonly group: string; readonly index?: number }
  | { readonly type: "random_motion"; readonly group: string }
  | { readonly type: "expression"; readonly index: number }
  | { readonly type: "mouth"; readonly value: number }
  | { readonly type: "release_lipsync" }
  | { readonly type: "resize"; readonly width: number; readonly height: number };

/** WebView → pet-core 回传（模型就绪 / 加载失败 / 动作真正播放反馈 / 拖拽 / 点击） */
export type WebViewInbound =
  | { readonly type: "ready" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "motion_played"; readonly group: string; readonly index: number; readonly fileName?: string }
  | { readonly type: "drag_start"; readonly x: number; readonly y: number }
  | { readonly type: "drag_move"; readonly dx: number; readonly dy: number }
  | { readonly type: "drag_end" }
  | { readonly type: "tap_hit"; readonly area: string; readonly x: number; readonly y: number };

const COMMAND_TYPES: ReadonlySet<WebViewCommand["type"]> = new Set([
  "motion",
  "random_motion",
  "expression",
  "mouth",
  "release_lipsync",
  "resize",
]);

/** 出站序列化。未知指令类型抛错，防止脏指令进 WebView。 */
export function serializeWebViewCommand(cmd: WebViewCommand): string {
  if (!cmd || !COMMAND_TYPES.has(cmd.type)) {
    throw new Error(`未知的 WebView 指令类型：${(cmd as { type?: unknown })?.type}`);
  }
  return JSON.stringify(cmd);
}

/** 入站解析。脏数据 / 未知类型返回 null（不抛错）。 */
export function parseWebViewInbound(raw: string): WebViewInbound | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const type = (obj as { type?: unknown }).type;
  if (type === "ready") return { type: "ready" };
  if (type === "error") {
    const message = (obj as { message?: unknown }).message;
    return { type: "error", message: typeof message === "string" ? message : "" };
  }
  if (type === "motion_played") {
    const o = obj as { group?: unknown; index?: unknown; fileName?: unknown };
    if (typeof o.group !== "string" || typeof o.index !== "number") return null;
    return {
      type: "motion_played",
      group: o.group,
      index: o.index,
      fileName: typeof o.fileName === "string" ? o.fileName : undefined,
    };
  }
  if (type === "drag_start") {
    const o = obj as { x?: unknown; y?: unknown };
    if (typeof o.x !== "number" || typeof o.y !== "number") return null;
    return { type: "drag_start", x: o.x, y: o.y };
  }
  if (type === "drag_move") {
    const o = obj as { dx?: unknown; dy?: unknown };
    if (typeof o.dx !== "number" || typeof o.dy !== "number") return null;
    return { type: "drag_move", dx: o.dx, dy: o.dy };
  }
  if (type === "drag_end") {
    return { type: "drag_end" };
  }
  if (type === "tap_hit") {
    const o = obj as { area?: unknown; x?: unknown; y?: unknown };
    return {
      type: "tap_hit",
      area: typeof o.area === "string" ? o.area : "",
      x: typeof o.x === "number" ? o.x : 0,
      y: typeof o.y === "number" ? o.y : 0,
    };
  }
  return null;
}
