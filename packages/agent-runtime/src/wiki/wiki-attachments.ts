/**
 * Wiki 附件引用语法——纯函数，agent-runtime 侧不依赖 DOM/File API
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md` §7.1
 * 引用语法沿用项目既有格式（见 apps/windows ChatPage 的 file-attachment-strategy.ts）：
 *   [media attached: /path/to/file (filename)]
 * 前端渲染把该语法替换为 <img> 或媒体播放器；本模块只负责生成/识别该行文本，
 * 供 WikiRepo.attachFile 拖拽上传后插入正文引用。
 */

/** 生成一行附件引用语法，供插入页面正文 */
export function serializeAttachmentReference(filePath: string, displayName: string): string {
  return `[media attached: ${filePath} (${displayName})]`;
}

/** 判断一行是否为附件引用语法（用于正文渲染时识别替换点） */
export function isAttachmentReferenceLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("[media attached:") && trimmed.endsWith("]");
}
