/**
 * WikiContentExtractor — 按媒体类型提取可索引正文
 *
 * P0 不自建 PDF/Office 解析：文档类正文优先用调用方传入的文本；没传时（产物/上传
 * 摄入钩子拿不到正文）回落到注入的 readTextFile 直接读纯文本文件，否则归档出来的
 * 页面正文为空、检索不到。图片描述依赖注入的 recognizeImage（vision 通道），
 * 未注入时返回 null——null 表示"未生成描述"，与"已生成但为空"（""）语义不同，
 * UI 靠这个区别决定是否显示"可重新识别"。音频/视频 P0 不提取正文。
 */

import type { WikiMediaType } from "./types.js";

/**
 * 可安全按纯文本读取的扩展名。
 * 二进制文档（pdf/docx/xlsx…）读出来是乱码，会污染索引，P0 一律不读——
 * 留空正文比塞乱码好，用户仍可手动编辑页面补正文。
 */
const TEXT_READABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "txt", "md", "markdown", "json", "yaml", "yml", "toml", "ini", "csv", "tsv",
  "log", "xml", "html", "htm", "css", "js", "mjs", "cjs", "jsx", "ts", "tsx",
  "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "sh",
  "bash", "zsh", "ps1", "sql", "graphql", "vue", "svelte", "properties", "env",
]);

/** 单文件读取上限：超过只取前 200KB，避免大日志把提示词与索引撑爆 */
export const MAX_EXTRACT_BYTES = 200 * 1024;

/** 该路径是否可按纯文本读取（扩展名白名单，未知扩展名不读） */
export function isTextReadablePath(path: string): boolean {
  const lastDot = path.lastIndexOf(".");
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (lastDot === -1 || lastDot < lastSep) return false;
  return TEXT_READABLE_EXTENSIONS.has(path.slice(lastDot + 1).toLowerCase());
}

export interface WikiContentExtractorDeps {
  /** 图片描述生成（vision 通道）；未提供表示该能力未启用 */
  readonly recognizeImage?: (path: string) => Promise<string>;
  /**
   * 读取纯文本文件内容（宿主注入，agent-runtime 不直接依赖 node:fs）。
   * 未提供表示该能力未启用，文档类正文只能靠调用方传入。
   */
  readonly readTextFile?: (path: string, maxBytes: number) => Promise<string | null>;
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
      case "document": {
        // 调用方已读出的正文优先（对话沉淀、带 taskContext 的产物走这条）
        if (input.text && input.text.trim()) return input.text;
        // 没正文时读文件：产物/上传摄入只有路径，不读就归档出空页
        const read = this.deps.readTextFile;
        if (!read || !input.sourcePath || !isTextReadablePath(input.sourcePath)) return null;
        try {
          const content = await read(input.sourcePath, MAX_EXTRACT_BYTES);
          return content && content.trim() ? content : null;
        } catch (err) {
          // 读失败不能中断摄入：页面正文留空，条目仍归档
          console.warn(`[WikiContentExtractor] 读取文件失败: ${(err as Error).message}`);
          return null;
        }
      }

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
