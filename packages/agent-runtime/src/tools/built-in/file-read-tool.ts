/**
 * File Read Tool — 读取文件内容（渐进式加载）
 *
 * 默认每次最多读取 500 行，避免单次工具调用撑爆上下文窗口。
 * 超出时返回截断提示，Agent 可通过 offset+limit 分页继续读取。
 *
 * 对非纯文本格式(图片/PDF/office/音视频/压缩包)做格式分发拦截，
 * 返回该类别的可执行指引而非乱码，避免浪费一轮调用。
 *
 * 内建优化：
 * - Dedup: mtime 未变时返回 stub，省 token
 * - 循环检测: 连续重复读同一文件渐进阻断（warn → block）
 */

import { Type } from "@sinclair/typebox";
import { statSync, openSync, readSync, closeSync } from "node:fs";
import type { MtBotToolConfig } from "../tool-adapter.js";
import { getFileStateCache } from "../file-state-cache.js";
import { computeFileHash } from "../file-hash.js";
import { resolveAgentFilePath } from "../resolve-file-path.js";

/** 单个 instance 的读取追踪状态 */
interface ReadTrackerState {
  /** 上一次读取的键（path+offset+limit 元组字符串） */
  lastKey: string | null;
  /** 连续相同调用次数 */
  consecutive: number;
  /** Dedup 缓存: {path+offset+limit → mtime} */
  dedup: Map<string, number>;
  /** Dedup stub 返回次数: {path+offset+limit → count} */
  dedupHits: Map<string, number>;
}

/** 全局追踪 Map: instanceId → state */
const _readTracker = new Map<string, ReadTrackerState>();

/** 获取或创建追踪状态 */
function getTrackerState(instanceId: string): ReadTrackerState {
  let state = _readTracker.get(instanceId);
  if (!state) {
    state = {
      lastKey: null,
      consecutive: 0,
      dedup: new Map(),
      dedupHits: new Map(),
    };
    _readTracker.set(instanceId, state);
  }
  return state;
}

/** 清理过期追踪（容量上限：防止长期运行内存泄漏） */
const MAX_TRACKER_INSTANCES = 100;
function capTrackerSize() {
  if (_readTracker.size > MAX_TRACKER_INSTANCES) {
    // 删除最早的 20 个（简单 FIFO）
    const keys = Array.from(_readTracker.keys());
    for (let i = 0; i < 20 && i < keys.length; i++) {
      _readTracker.delete(keys[i]!);
    }
  }
}

/** 二进制格式处理指引 */
interface BinaryFormatGuide {
  readonly reason: string;
  readonly guidance: string;
}

/**
 * 按扩展名查找二进制格式的处理指引。
 * 命中返回指引对象,未命中返回 null(按纯文本处理)。
 */
function lookupBinaryFormatGuide(ext: string): BinaryFormatGuide | null {
  // 图片 — 已通过视觉通道附带在用户消息中
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif", ".avif", ".tiff", ".tif", ".ico", ".svg"].includes(ext)) {
    return {
      reason: "image_binary",
      guidance: "图片内容已通过视觉通道直接附带在用户消息中，请直接根据看到的图片内容回答，无需再调用 file_read。",
    };
  }

  // PDF 文档
  if (ext === ".pdf") {
    return {
      reason: "pdf_binary",
      guidance:
        "PDF 是二进制格式,按文本行读取会得到乱码。推荐方案:\n" +
        "1. 若有宿主层 PDF 解析能力(检查 toolContext.parsePdf 是否存在),优先使用\n" +
        "2. 若用户上下文中有该文件的文本摘要或已粘贴的内容,直接使用\n" +
        "3. 若以上都不可用,明确告知用户此文件为 PDF,file_read 无法读取,需要专用解析工具",
    };
  }

  // Office 文档(Word/Excel/PowerPoint)
  if ([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"].includes(ext)) {
    return {
      reason: "office_binary",
      guidance:
        "Office 文档是二进制或 ZIP 封装的 XML 格式,按文本行读取会得到乱码。推荐方案:\n" +
        "1. 若宿主层有 office 解析能力(检查 toolContext.parseOffice),优先使用\n" +
        "2. 若用户已粘贴文档内容或提供摘要,直接使用\n" +
        "3. 明确告知用户此文件为 Office 文档,file_read 无法读取,需要专用解析工具",
    };
  }

  // 音频文件
  if ([".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".wma"].includes(ext)) {
    return {
      reason: "audio_binary",
      guidance:
        "音频文件是二进制格式,无法通过 file_read 按文本读取。推荐方案:\n" +
        "1. 若需要音频内容,使用语音转文本工具(若有 toolContext.transcribeAudio)\n" +
        "2. 若仅需元数据(时长/比特率等),明确告知用户 file_read 不支持音频,需要专用工具\n" +
        "3. 若用户提到此音频内容,请用户提供文本转写或摘要",
    };
  }

  // 视频文件
  if ([".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv", ".webm"].includes(ext)) {
    return {
      reason: "video_binary",
      guidance:
        "视频文件是二进制格式,无法通过 file_read 按文本读取。推荐方案:\n" +
        "1. 若需要视频帧内容,检查是否有视觉工具(toolContext.extractVideoFrames)\n" +
        "2. 若仅需元数据(时长/分辨率等),明确告知用户 file_read 不支持视频,需要专用工具\n" +
        "3. 若用户提到此视频内容,请用户提供截图或文字描述",
    };
  }

  // 压缩包
  if ([".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"].includes(ext)) {
    return {
      reason: "archive_binary",
      guidance:
        "压缩包是二进制格式,无法通过 file_read 按文本读取。推荐方案:\n" +
        "1. 若宿主层有解压能力(toolContext.extractArchive),先解压后读取内部文件\n" +
        "2. 若无解压能力,明确告知用户需要先解压此文件,或使用专用工具查看压缩包内容列表\n" +
        "3. 提示用户提供压缩包内具体要读取的文件路径",
    };
  }

  // 其他二进制格式(可执行文件/动态库等)
  if ([".exe", ".dll", ".so", ".dylib", ".bin", ".dat"].includes(ext)) {
    return {
      reason: "executable_binary",
      guidance:
        "可执行文件或二进制数据文件无法通过 file_read 按文本读取。\n" +
        "若需要分析此文件,请明确告知用户 file_read 不支持,需要使用专用的二进制分析工具。",
    };
  }

  // 未命中 — 按纯文本处理
  return null;
}

/**
 * 字节嗅探：读前若干字节判断是否为二进制（扩展名未命中时的兜底）。
 *
 * 检测两类信号：
 * 1. 已知文件头魔数（PNG/JPEG/GIF/PDF/ZIP/ELF 等）
 * 2. 出现 NUL 字节（文本文件几乎不含 \x00）
 *
 * 读取失败（文件不存在/无权限）时返回 null，交由后续 readFile 报错。
 */
function sniffBinaryByBytes(filePath: string): BinaryFormatGuide | null {
  let header: Buffer;
  try {
    const fd = openSync(filePath, "r");
    try {
      header = Buffer.alloc(64);
      const bytesRead = readSync(fd, header, 0, 64, 0);
      header = header.subarray(0, bytesRead);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  if (header.length === 0) return null;

  // 已知魔数 → 映射到具体类别指引
  const startsWith = (sig: number[]): boolean =>
    sig.every((b, i) => header[i] === b);

  if (startsWith([0x89, 0x50, 0x4e, 0x47])) {
    return lookupBinaryFormatGuide(".png");
  }
  if (startsWith([0xff, 0xd8, 0xff])) {
    return lookupBinaryFormatGuide(".jpg");
  }
  if (startsWith([0x47, 0x49, 0x46, 0x38])) {
    return lookupBinaryFormatGuide(".gif");
  }
  if (startsWith([0x25, 0x50, 0x44, 0x46])) {
    return lookupBinaryFormatGuide(".pdf");
  }
  // ZIP/office/jar（PK\x03\x04）
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) {
    return {
      reason: "zip_container_binary",
      guidance:
        "检测到 ZIP 封装的二进制文件(可能是 office 文档/jar/压缩包),按文本读取会得到乱码。\n" +
        "请先确认文件类型,office 文档需专用解析,压缩包需先解压。",
    };
  }
  // ELF 可执行
  if (startsWith([0x7f, 0x45, 0x4c, 0x46])) {
    return lookupBinaryFormatGuide(".bin");
  }

  // NUL 字节信号：文本文件几乎不含 \x00
  if (header.includes(0x00)) {
    return {
      reason: "nul_byte_binary",
      guidance:
        "文件包含 NUL 字节,判定为二进制文件,无法按文本读取。\n" +
        "若需要分析此文件,请使用专用的二进制分析工具,或确认这是否是预期的文本文件。",
    };
  }

  return null;
}

/** 单次读取的默认行数上限（约 12000 字符，安全边际内） */
const DEFAULT_READ_LIMIT = 500;
/** 单次读取的硬上限（防止 Agent 传入超大 limit） */
const MAX_READ_LIMIT = 1000;

const FileReadInput = Type.Object({
  filePath: Type.String({
    description:
      "Path to the file to read. Relative paths (e.g. outputs/foo.md) resolve against workspace root.",
  }),
  offset: Type.Optional(
    Type.Number({
      description: "Line number to start reading from (1-based). Use for paginated reading.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Number of lines to read. Default ${DEFAULT_READ_LIMIT}, max ${MAX_READ_LIMIT}. Use offset+limit to read large files progressively.`,
    }),
  ),
});

export const fileReadToolConfig: MtBotToolConfig<typeof FileReadInput> = {
  name: "file_read",
  label: "Read File",
  description: `Read file contents. Default reads first ${DEFAULT_READ_LIMIT} lines. For large files, use offset+limit to read progressively (e.g., offset=201, limit=200 for next page).`,
  parameters: FileReadInput,
  category: "filesystem",
  isReadOnly: true,
  needsPermission: false,
  execute: async (_toolCallId, params, context) => {
    const filePath = resolveAgentFilePath(params.filePath, context.getCwd());
    const instanceId = context.instanceId ?? "default";
    const state = getTrackerState(instanceId);
    capTrackerSize();

    // 1. 格式分发：先扩展名,后字节嗅探
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    let guide = lookupBinaryFormatGuide(ext);
    if (!guide) {
      guide = sniffBinaryByBytes(filePath);
    }
    if (guide) {
      return {
        content: [
          {
            type: "text" as const,
            text: `[file_read 无法按文本读取二进制文件：${filePath}]\n${guide.guidance}`,
          },
        ],
        details: { filePath, skipped: true, reason: guide.reason },
      };
    }

    const effectiveOffset = params.offset ?? 1;
    const effectiveLimit = Math.min(params.limit ?? DEFAULT_READ_LIMIT, MAX_READ_LIMIT);

    // 2. Dedup 检查：mtime 未变 → 返回 stub
    const dedupKey = `${filePath}::${effectiveOffset}::${effectiveLimit}`;
    const cachedMtime = state.dedup.get(dedupKey);
    let currentMtime: number | undefined;
    try {
      currentMtime = statSync(filePath).mtimeMs;
    } catch {
      // 文件不存在/无权限 → 后续 readFile 会报错,此处不拦截
    }

    if (cachedMtime !== undefined && currentMtime !== undefined && currentMtime === cachedMtime) {
      const hits = (state.dedupHits.get(dedupKey) ?? 0) + 1;
      state.dedupHits.set(dedupKey, hits);

      // dedup stub 循环次数过多 → 升级为硬阻断
      if (hits >= 3) {
        return {
          content: [
            {
              type: "text",
              text:
                `[file_read 重复读取 ${filePath} (offset=${effectiveOffset}, limit=${effectiveLimit}) 已 ${hits} 次]\n` +
                `文件内容未变,且已多次返回 unchanged 提示,请停止重复读取。\n` +
                `该内容已在你的上下文窗口中,直接引用先前读取的结果。`,
            },
          ],
          details: { filePath, unchanged: true, blocked: true },
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `[file_read ${filePath} — 内容未变]\n` +
              `自上次读取以来,该文件未被修改(offset=${effectiveOffset}, limit=${effectiveLimit})。\n` +
              `请直接使用你上下文窗口中先前读取的结果,无需重新获取。`,
          },
        ],
        details: { filePath, unchanged: true },
      };
    }

    // 3. 循环检测：连续相同调用渐进处罚
    const currentKey = dedupKey;
    if (state.lastKey === currentKey) {
      state.consecutive += 1;
    } else {
      state.lastKey = currentKey;
      state.consecutive = 1;
    }

    const consecutive = state.consecutive;
    let loopWarning: string | null = null;

    if (consecutive === 2) {
      loopWarning = `[警告] 你已连续第 2 次读取同一文件的同一区间。请确认是否真的需要重复读取。`;
    } else if (consecutive === 3) {
      loopWarning = `[警告] 你已连续第 3 次读取同一文件的同一区间。该内容已在你的上下文中,继续重复读取会浪费 token。`;
    } else if (consecutive >= 4) {
      return {
        content: [
          {
            type: "text",
            text:
              `[file_read 循环阻断]\n` +
              `你已连续 ${consecutive} 次读取 ${filePath} (offset=${effectiveOffset}, limit=${effectiveLimit})。\n` +
              `该内容已在你的上下文窗口中,请停止重复读取,直接引用先前的结果。`,
          },
        ],
        details: { filePath, loopBlocked: true },
      };
    }

    // 4. 实际读取
    const content = await context.readFile(filePath, {
      offset: effectiveOffset,
      limit: effectiveLimit,
    });

    const lines = content.split("\n");
    const startLine = effectiveOffset;
    const endLine = startLine + lines.length - 1;

    // 检查是否还有更多内容（通过读取下一行来判断）
    let hasMore = false;
    try {
      const probe = await context.readFile(filePath, {
        offset: endLine + 1,
        limit: 1,
      });
      hasMore = probe.trim().length > 0;
    } catch {
      // 读取失败说明已到文件末尾
    }

    // 5. 更新 dedup 缓存(读成功后记录 mtime)
    if (currentMtime !== undefined) {
      state.dedup.set(dedupKey, currentMtime);
      state.dedupHits.delete(dedupKey); // 重置 hits(真正读了一次新内容)

      // 同步写入跨工具共享缓存（供 Read-before-Write hook 校验）
      // isPartialView：非首页(offset>1) 或 还有更多内容(hasMore) → 部分视图
      const isPartialView = effectiveOffset > 1 || hasMore;

      // 主题1 P1-1：小文件完整读取时计算 contentHash（Windows mtime 抖动回退用）
      let contentHash: string | undefined;
      if (!isPartialView && effectiveOffset === 1) {
        // 完整读取（首页且无更多内容）→ 计算哈希
        contentHash = computeFileHash(content);
      }

      getFileStateCache(instanceId).set(filePath, {
        mtimeMs: Math.floor(currentMtime),
        offset: effectiveOffset,
        limit: effectiveLimit,
        isPartialView,
        contentHash,
      });
    }

    let text = content;
    if (loopWarning) {
      text = `${loopWarning}\n\n${text}`;
    }
    if (hasMore) {
      text += `\n\n[截断：已读取第 ${startLine}-${endLine} 行，文件还有更多内容。使用 offset=${endLine + 1}, limit=${effectiveLimit} 继续读取下一页。]`;
    } else {
      text += `\n\n[已读取第 ${startLine}-${endLine} 行，到达文件末尾。]`;
    }

    return {
      content: [{ type: "text", text }],
      details: { filePath, startLine, endLine, hasMore },
    };
  },
};
