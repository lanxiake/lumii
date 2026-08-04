/**
 * Read-before-Write Hook — 契约校验层（主题1 P0-4 + P1-1）
 *
 * 对 file_edit/file_write 在 beforeExecute 强制：
 * 1. 文件存在但未被 Read 过 → 拒绝（"Read it first before writing"）
 * 2. 文件自 Read 后被外部修改（mtime 漂移）→ 拒绝（"Read it again before writing"）
 *    - P1-1：若 contentHash 存在且匹配，仍放行（Windows mtime 抖动回退）
 * 3. 写入成功后 afterExecute 回写最新 mtime，使连续两次 edit 第二次不被自己拦截
 *
 * 对照 claude-code-rev：
 * - FileWriteTool.ts:198-219（validateInput 校验 readFileState）
 * - FileEditTool.ts:275-307（同）、L520-522（edit 后回写）
 *
 * 放行策略：
 * - 新文件（statSync 抛 ENOENT）→ 放行
 * - file_write mode='append' → 放行（语义上不要求先读）
 * - isPartialView=true → 拒绝（分页未读全）
 */

import { statSync, readFileSync } from "node:fs";
import type { ToolHook } from "../tool-hooks.js";
import { getFileStateCache } from "../file-state-cache.js";
import { computeFileHash } from "../file-hash.js";

export interface ReadBeforeWriteHookOptions {
  /**
   * 启用 Windows mtime 抖动回退（主题1 P1-1，默认 false）
   *
   * 开启后：mtime 漂移但 contentHash 匹配（小文件）时放行，避免 Windows 误拦。
   */
  enableMtimeHashFallback?: boolean;
}

export function createReadBeforeWriteHook(options: ReadBeforeWriteHookOptions = {}): ToolHook {
  const enableMtimeHashFallback = options.enableMtimeHashFallback ?? false;
  return {
    name: "read-before-write",
    critical: false, // 非致命：hook 异常不阻断工具执行（降级为无校验）
    filter: {
      toolNames: ["file_edit", "file_write"],
    },

    beforeExecute(ctx) {
      const instanceId = ctx.context.instanceId ?? "default";
      const cache = getFileStateCache(instanceId);

      const filePath = ctx.params.filePath as string | undefined;
      if (!filePath) {
        // 参数缺失，后续工具 execute 会报错，此处不拦截
        return;
      }

      // 放行 file_write mode='append'（语义上不要求先读）
      if (ctx.toolName === "file_write") {
        const mode = ctx.params.mode as string | undefined;
        if (mode === "append") {
          return;
        }
      }

      // 放行新文件（statSync 抛 ENOENT）
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(filePath);
      } catch (err: unknown) {
        // 文件不存在 → 放行（新文件合法）
        if ((err as { code?: string }).code === "ENOENT") {
          return;
        }
        // 其他异常（权限拒绝等）→ 放行，后续工具执行会报错
        return;
      }

      // 校验：文件已存在，是否在缓存中有 Read 记录？
      const entry = cache.get(filePath);
      if (!entry) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `[${ctx.toolName} 被拒绝] ${filePath}\n` +
                `文件存在但未被 file_read 读取过。在编辑或覆盖写入前，必须先用 file_read 读取文件内容，确保你了解当前状态。`,
            },
          ],
          isError: true,
          details: { filePath, reason: "not_read", toolName: ctx.toolName },
        };
      }

      // 注：entry.offset===undefined（写入后回写的条目）视为"已读过"，
      // 以放行连续两次 edit/write —— offset 区分仅用于 dedup（P1-2），不用于本写入门禁。
      //
      // 注：不因 isPartialView 拒绝。大文件分页读取很常见，Agent 通常编辑已看到的区域，
      // 在 partial 时硬拦会造成高频误拦。门禁只保留"从未读过"与"mtime 漂移"两条硬规则。

      // 校验：mtime 是否漂移？Math.floor 防亚毫秒抖动
      const diskMtimeMs = Math.floor(st.mtimeMs);
      if (diskMtimeMs > entry.mtimeMs) {
        // 主题1 P1-1：Windows mtime 抖动回退 —— mtime 漂移但内容哈希匹配则放行
        if (enableMtimeHashFallback && entry.contentHash) {
          try {
            const diskHash = computeFileHash(readFileSync(filePath));
            if (diskHash && diskHash === entry.contentHash) {
              // 内容未变（仅 mtime 抖动）→ 放行，并回写最新 mtime 避免下次重复比对
              cache.set(filePath, { ...entry, mtimeMs: diskMtimeMs });
              return;
            }
          } catch {
            // 读取失败 → 落入下方拒绝分支
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                `[${ctx.toolName} 被拒绝] ${filePath}\n` +
                `文件在 file_read 之后被外部修改（mtime 漂移）。请重新用 file_read 读取最新内容，再进行编辑或写入。`,
            },
          ],
          isError: true,
          details: { filePath, reason: "mtime_drift", toolName: ctx.toolName },
        };
      }

      // 通过：file_read 过且 mtime 未变 → 放行
    },

    afterExecute(ctx) {
      // 写入成功后回写最新 mtime，使连续两次 edit 第二次不被自己拦截
      if (ctx.isError) {
        // 工具执行失败，不回写
        return;
      }

      const instanceId = ctx.context.instanceId ?? "default";
      const cache = getFileStateCache(instanceId);

      const filePath = ctx.params.filePath as string | undefined;
      if (!filePath) {
        return;
      }

      // 读取最新 mtime 并回写缓存（标记为非 Read 条目：offset=undefined）
      try {
        const st = statSync(filePath);
        cache.set(filePath, {
          mtimeMs: Math.floor(st.mtimeMs),
          // offset/limit 不设 → 标记为"写入后条目"，dedup 不对其生效（对齐 claude-code）
          isPartialView: false,
        });
      } catch {
        // statSync 失败（文件被删？）→ 静默忽略，不阻断后续流程
      }
    },
  };
}
