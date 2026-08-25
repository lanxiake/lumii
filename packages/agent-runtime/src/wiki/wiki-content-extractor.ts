/**
 * WikiContentExtractor — 按媒体类型提取可索引正文
 *
 * P0 不自建 PDF/Office 解析：文档类正文由调用方（摄入钩子）在已有读文件路径上传入，
 * 这里只做直通与空值归一。图片描述依赖注入的 recognizeImage（vision 通道），
 * 未注入时返回 null——null 表示"未生成描述"，与"已生成但为空"（""）语义不同，
 * UI 靠这个区别决定是否显示"可重新识别"。音频/视频 P0 不提取正文。
 */

import type { WikiMediaType } from "./types.js";

export interface WikiContentExtractorDeps {
  /** 图片描述生成（vision 通道）；未提供表示该能力未启用 */
  readonly recognizeImage?: (path: string) => Promise<string>;
}

export interface ExtractInput {
  readonly mediaType: WikiMediaType;
  /** 文件路径，图片识别需要 */
  readonly sourcePath?: string | null;
  /** 调用方已读出的正文（文档类唯一来源） */
  readonly text?: string | null;
}

export class WikiContentExtractor {
  constructor(private readonly deps: WikiContentExtractorDeps = {}) {}

  /**
   * 返回可索引正文，null 表示未能提取（能力未启用或该类型不提取）。
   * 图片识别失败不抛错——摄入不能因为描述生成失败而中断。
   */
  async extract(input: ExtractInput): Promise<string | null> {
    switch (input.mediaType) {
      case "document":
        return input.text && input.text.trim() ? input.text : null;

      case "image": {
        const recognize = this.deps.recognizeImage;
        if (!recognize || !input.sourcePath) return null;
        try {
          return await recognize(input.sourcePath);
        } catch (err) {
          console.warn(`[WikiContentExtractor] 图片描述生成失败: ${(err as Error).message}`);
          return null;
        }
      }

      case "audio":
      case "video":
        return null;
    }
  }
}
