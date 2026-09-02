/**
 * WikiIngestHook — 两路摄入统一入口（上传 / 任务产物）
 *
 * 薄封装 repo.ingestToInbox，只负责组装参数与算去重哈希。
 * 关键约束：每个方法内部吞掉异常——摄入是主流程的旁路，钩子失败绝不能影响
 * 上传/产物写入本身（设计原则「自动优先」的前提是钩子无侵入性）。
 * 网页链接与对话消息不单独收录；编写文档时可将链接嵌入正文。
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

  /** 网页检索结果不再收录：Wiki 只收文件与文档；链接可嵌入文档正文，不单独建资料 */
  ingestWebSearch(_agentId: string, _userId: string, _url: string, _title: string, _snippet?: string): null {
    return null;
  }

  /** 对话消息不再收录：Wiki 只收文件与文档（设计 §1），始终返回 null，不写 inbox */
  ingestChat(_agentId: string, _userId: string, _content: string, _title: string): null {
    return null;
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
