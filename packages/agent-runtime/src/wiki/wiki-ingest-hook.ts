/**
 * WikiIngestHook — 四路摄入统一入口（上传 / 任务产物 / 网页检索 / 对话）
 *
 * 薄封装 repo.ingestToInbox，只负责组装参数与算去重哈希。
 * 关键约束：每个方法内部吞掉异常——摄入是主流程的旁路，钩子失败绝不能影响
 * 上传/产物写入/检索本身（设计原则「自动优先」的前提是钩子无侵入性）。
 * 返回摄入条目 id，摄入被跳过或失败时返回 null。
 */

import { contentAddressId } from "../memory/content-address.js";
import type { WikiRepo } from "./wiki-repo.js";
import type { WikiMediaType } from "./types.js";

/** 按扩展名归类媒体类型，未知一律当文档处理 */
function mediaTypeFromPath(path: string, mime?: string): WikiMediaType {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("audio/")) return "audio";
  if (mime?.startsWith("video/")) return "video";
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (["mp3", "wav", "flac", "m4a", "aac", "ogg"].includes(ext)) return "audio";
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return "video";
  return "document";
}

export class WikiIngestHook {
  constructor(private readonly repo: WikiRepo) {}

  /** 用户上传文件 */
  ingestUpload(
    agentId: string,
    userId: string,
    path: string,
    title: string,
    mime?: string,
    contentPreview?: string,
  ): string | null {
    return this.safeIngest(() =>
      this.repo.ingestToInbox({
        agentId,
        userId,
        itemType: "upload",
        sourcePath: path,
        title,
        contentPreview,
        mediaType: mediaTypeFromPath(path, mime),
        contentHash: contentAddressId([path, contentPreview ?? "", mime ?? ""]),
      }),
    );
  }

  /** 任务产物落盘 */
  ingestOutput(agentId: string, userId: string, path: string, title: string, taskContext?: string): string | null {
    return this.safeIngest(() =>
      this.repo.ingestToInbox({
        agentId,
        userId,
        itemType: "output",
        sourcePath: path,
        title,
        contentPreview: taskContext,
        mediaType: mediaTypeFromPath(path),
        contentHash: contentAddressId([path, taskContext ?? ""]),
      }),
    );
  }

  /** 网页检索结果 */
  ingestWebSearch(agentId: string, userId: string, url: string, title: string, snippet?: string): string | null {
    return this.safeIngest(() =>
      this.repo.ingestToInbox({
        agentId,
        userId,
        itemType: "search",
        sourcePath: url, // 以 url 作为去重维度（ingestToInbox 按 sourcePath+hash 去重）
        sourceUrl: url,
        title,
        contentPreview: snippet,
        mediaType: "document",
        contentHash: contentAddressId([url, snippet ?? ""]),
      }),
    );
  }

  /** 对话内容显式收藏（无自动钩子，只能显式调用） */
  ingestChat(agentId: string, userId: string, content: string, title: string): string | null {
    const hash = contentAddressId([content]);
    return this.safeIngest(() =>
      this.repo.ingestToInbox({
        agentId,
        userId,
        itemType: "chat",
        // 对话无真实文件路径，用哈希造一个稳定的合成路径以复用去重逻辑
        sourcePath: `chat://${hash}`,
        title,
        contentPreview: content,
        mediaType: "document",
        contentHash: hash,
      }),
    );
  }

  private safeIngest(fn: () => { readonly id: string }): string | null {
    try {
      return fn().id;
    } catch (err) {
      console.warn(`[WikiIngestHook] 摄入失败（已忽略，不影响主流程）: ${(err as Error).message}`);
      return null;
    }
  }
}
