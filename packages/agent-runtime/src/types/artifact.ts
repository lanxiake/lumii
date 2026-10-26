/**
 * 产物声明契约（工具结果 → 工作台）
 *
 * 只放**形状**，不放规则：路径是否算中间产物、扩展名映射哪种 kind，
 * 仍由 `apps/windows/src/shared/artifact-rules.ts` 唯一实现。
 *
 * 传输方式：`MtBotToolResult.details.artifacts`。details 已随 tool part
 * 完整持久化（content_json），所以不需要新增事件或数据表。
 */

export type ArtifactKind =
  | "image"
  | "image-set"
  | "video"
  | "audio"
  | "doc"
  | "slides"
  | "sheet"
  | "site"
  | "code"
  | "archive"
  | "other";

export interface ArtifactMeta {
  width?: number;
  height?: number;
  durationSec?: number;
  pages?: number;
  words?: number;
  bytes?: number;
  model?: string;
  prompt?: string;
  params?: Record<string, string | number | boolean>;
}

export interface ArtifactDeclaration {
  kind: ArtifactKind;
  /** 工作区相对路径（posix）。与 remoteUrl 二选一 */
  path?: string;
  /** 远端产物（ComfyUI 等）：只展示，不参与打开/清理 */
  remoteUrl?: string;
  role?: "deliverable" | "intermediate";
  title?: string;
  /** 封面路径（工作区相对） */
  cover?: string;
  meta?: ArtifactMeta;
}

