/**
 * 工作区回合快照 — 轻量文件 hash 映射，供 diffTurnSnapshots 计算净变更。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { VCS_SKIP_DIRS } from "./vcs-ignore";

/** 超过此大小的文件不读全量内容，改用 size+mtime 合成伪 hash */
const MAX_HASH_BYTES = 2 * 1024 * 1024;

const log = {
  debug: (...args: unknown[]) => console.debug("[WorkspaceTurnSnapshot]", ...args),
};

/**
 * 判断相对 posix 路径是否应被快照忽略（对应 DEFAULT_VCS_IGNORE 中的文件级规则）。
 */
function shouldIgnoreSnapshotFile(relPosix: string): boolean {
  const base = relPosix.includes("/")
    ? relPosix.slice(relPosix.lastIndexOf("/") + 1)
    : relPosix;

  if (base === ".DS_Store" || base === "Thumbs.db") return true;
  if (base.endsWith(".log")) return true;

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
function assertWorkspaceDir(workspaceDir: string): void {
  if (!workspaceDir || typeof workspaceDir !== "string") {
    throw new Error("workspaceDir 无效");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(workspaceDir);
  } catch {
    throw new Error(`工作区目录不存在: ${workspaceDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`工作区路径不是目录: ${workspaceDir}`);
  }
}

/**
 * 计算单个文件的 sha256；超大文件用 size+mtime 伪 hash，避免阻塞主进程。
 */
function hashFile(absPath: string): string {
  const stat = fs.statSync(absPath);
  if (stat.size > MAX_HASH_BYTES) {
    log.debug(`跳过大文件全量 hash (${stat.size} bytes): ${absPath}`);
    return createHash("sha256")
      .update(`size:${stat.size}:mtime:${stat.mtimeMs}`)
      .digest("hex");
  }
  const content = fs.readFileSync(absPath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 递归遍历工作区，收集相对 posix 路径 → sha256(内容) 映射。
 * 跳过 node_modules、.git、.mtbot-vcs、tmp/temp/.cache 及 DEFAULT_VCS_IGNORE 大文件模式。
 */
function walkWorkspace(
  absDir: string,
  relDir: string,
  out: Map<string, string>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`读取工作区目录失败: ${absDir}`, { cause: error });
  }

  for (const entry of entries) {
    if (VCS_SKIP_DIRS.has(entry.name)) continue;

    const abs = path.join(absDir, entry.name);
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const relPosix = rel.replace(/\\/g, "/");

    if (entry.isDirectory()) {
      walkWorkspace(abs, relPosix, out);
    } else if (entry.isFile()) {
      if (shouldIgnoreSnapshotFile(relPosix)) continue;
      out.set(relPosix, hashFile(abs));
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
  assertWorkspaceDir(workspaceDir);

  const snapshot = new Map<string, string>();
  walkWorkspace(workspaceDir, "", snapshot);
  return snapshot;
}
