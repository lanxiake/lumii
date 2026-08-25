/**
 * 工作区回合快照 — 轻量文件 hash 映射，供 diffTurnSnapshots 计算净变更。
 *
 * 每轮对话开始/结束都会调用一次，采用异步 fs API 并在遍历批次间让出事件循环，
 * 避免大工作区下长时间独占 Electron 主进程（会阻塞所有 IPC，表现为 UI 卡顿）。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { VCS_SKIP_DIRS } from "./vcs-ignore";
import { createLogger } from "../logger";

const logger = createLogger("workspace-vcs/turn-snapshot");

/** 超过此大小的文件不读全量内容，改用 size+mtime 合成伪 hash */
const MAX_HASH_BYTES = 2 * 1024 * 1024;

/** 单次快照允许全量哈希的文件数量上限；超过后剩余文件降级为 size+mtime 伪哈希，避免超大工作区单次快照耗时失控 */
const MAX_FULL_HASH_FILE_COUNT = 5000;

/** 单次快照允许全量哈希读取的累计字节数上限（200MB）；超过后剩余文件降级为伪哈希 */
const MAX_FULL_HASH_TOTAL_BYTES = 200 * 1024 * 1024;

/** 每处理完这么多个文件，让出一次事件循环（setImmediate），避免长时间占用主线程 */
const YIELD_EVERY_N_FILES = 50;

/**
 * 判断相对 posix 路径是否应被快照忽略（对应 DEFAULT_VCS_IGNORE 中的文件级规则）。
 */
function shouldIgnoreSnapshotFile(relPosix: string): boolean {
  const base = relPosix.includes("/")
    ? relPosix.slice(relPosix.lastIndexOf("/") + 1)
    : relPosix;

  if (base === ".DS_Store" || base === "Thumbs.db") return true;
  if (base.endsWith(".log")) return true;

  // 技能索引由主进程自动维护（注册/卸载/打分都会重写），不是用户或 Agent 的
  // 会话产出。若纳入快照，任何回合的 diff 都会莫名出现这个文件的"修改"。
  if (relPosix === "skills/index.json") return true;

  // uploads/ 下的大媒体与二进制（与 vcs-ignore DEFAULT_VCS_IGNORE 一致）
  if (
    /^uploads\/.+\.(zip|mp4|mov|png|jpg|jpeg|gif|pdf)$/i.test(relPosix)
  ) {
    return true;
  }

  return false;
}

/**
 * 校验工作区根目录存在且为目录，否则抛错。
 */
async function assertWorkspaceDir(workspaceDir: string): Promise<void> {
  if (!workspaceDir || typeof workspaceDir !== "string") {
    throw new Error("workspaceDir 无效");
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(workspaceDir);
  } catch {
    throw new Error(`工作区目录不存在: ${workspaceDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`工作区路径不是目录: ${workspaceDir}`);
  }
}

/** 让出一次事件循环，避免遍历/哈希大量文件时长时间独占主线程 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 用 size+mtime 合成伪 hash（不读文件内容），用于超大文件或触达数量/字节上限后的降级 */
function pseudoHash(stat: fs.Stats): string {
  return createHash("sha256")
    .update(`size:${stat.size}:mtime:${stat.mtimeMs}`)
    .digest("hex");
}

/**
 * 计算单个文件的 sha256；超大文件用 size+mtime 伪 hash，避免阻塞主进程。
 */
async function hashFile(absPath: string, stat: fs.Stats): Promise<string> {
  if (stat.size > MAX_HASH_BYTES) {
    return pseudoHash(stat);
  }
  const content = await fs.promises.readFile(absPath);
  return createHash("sha256").update(content).digest("hex");
}

/** 遍历过程中的累计状态，用于数量/字节上限判定与完成后的日志汇总 */
interface WalkStats {
  fileCount: number;
  totalBytes: number;
  fullHashCount: number;
  pseudoHashCount: number;
  filesSinceYield: number;
}

/**
 * 递归遍历工作区，收集相对 posix 路径 → sha256(内容) 映射。
 * 跳过 node_modules、.git、.mtbot-vcs、tmp/temp/.cache 及 DEFAULT_VCS_IGNORE 大文件模式。
 * 异步 IO + 定期让出事件循环；触达文件数/字节数上限后剩余文件降级为伪哈希。
 */
async function walkWorkspace(
  absDir: string,
  relDir: string,
  out: Map<string, string>,
  stats: WalkStats,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(absDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`读取工作区目录失败: ${absDir}`, { cause: error });
  }

  for (const entry of entries) {
    if (VCS_SKIP_DIRS.has(entry.name)) continue;

    const abs = path.join(absDir, entry.name);
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const relPosix = rel.replace(/\\/g, "/");

    if (entry.isDirectory()) {
      await walkWorkspace(abs, relPosix, out, stats);
    } else if (entry.isFile()) {
      if (shouldIgnoreSnapshotFile(relPosix)) continue;

      const stat = await fs.promises.stat(abs);
      const overLimit =
        stats.fileCount >= MAX_FULL_HASH_FILE_COUNT ||
        stats.totalBytes >= MAX_FULL_HASH_TOTAL_BYTES;

      if (overLimit) {
        out.set(relPosix, pseudoHash(stat));
        stats.pseudoHashCount += 1;
      } else {
        out.set(relPosix, await hashFile(abs, stat));
        stats.fullHashCount += 1;
      }

      stats.fileCount += 1;
      stats.totalBytes += stat.size;
      stats.filesSinceYield += 1;

      if (stats.filesSinceYield >= YIELD_EVERY_N_FILES) {
        stats.filesSinceYield = 0;
        await yieldToEventLoop();
      }
    }
  }
}

/**
 * 递归遍历工作区，返回相对 posix 路径 → sha256(内容) 映射。
 * 跳过：node_modules、.git、.mtbot-vcs、tmp/temp/.cache，以及 DEFAULT_VCS_IGNORE 中的大文件模式。
 * workspaceDir 无效或不存在时抛错。
 */
export async function captureWorkspaceTurnSnapshot(
  workspaceDir: string,
): Promise<Map<string, string>> {
  await assertWorkspaceDir(workspaceDir);

  const startTime = performance.now();
  logger.info(`[captureWorkspaceTurnSnapshot] 开始遍历工作区, workspaceDir=${workspaceDir}`);

  const snapshot = new Map<string, string>();
  const stats: WalkStats = {
    fileCount: 0,
    totalBytes: 0,
    fullHashCount: 0,
    pseudoHashCount: 0,
    filesSinceYield: 0,
  };

  await walkWorkspace(workspaceDir, "", snapshot, stats);

  const durationMs = Math.round(performance.now() - startTime);
  logger.info(
    `[captureWorkspaceTurnSnapshot] 遍历完成, 文件数=${stats.fileCount}, 总字节数=${stats.totalBytes}, 全量哈希=${stats.fullHashCount}, 伪哈希=${stats.pseudoHashCount}, 耗时=${durationMs}ms`,
  );

  if (stats.pseudoHashCount > 0) {
    logger.warn(
      `[captureWorkspaceTurnSnapshot] 工作区文件数或体积超出全量哈希上限（文件数上限=${MAX_FULL_HASH_FILE_COUNT}, 字节数上限=${MAX_FULL_HASH_TOTAL_BYTES}），${stats.pseudoHashCount} 个文件已降级为 size+mtime 伪哈希`,
    );
  }

  return snapshot;
}
