/**
 * FileStateCache — 跨工具共享的文件状态缓存（主题1 P0-1）
 *
 * 契约层基石：Read 成功后写入 { mtimeMs, offset, limit, contentHash? }，
 * Edit/Write 在 beforeExecute 读取它做 Read-before-Write 强校验。
 *
 * 特性：
 * - 路径归一化（path.normalize + Windows 大小写不敏感）→ 保证 `C:\a\B.txt` 与 `c:/a/b.txt` 命中同一条
 * - 有界 LRU（max 条数 + max 字节）防止长对话内存无界增长
 * - 按 instanceId 隔离的全局注册表（与 file-read-tool 私有 _readTracker 同隔离粒度）
 *
 * 对照 claude-code-rev：`fileStateCache.ts`（LRUCache max=100 + maxSize=25MB + normalize key）。
 */

import path from "node:path";

/** 单个文件的状态条目 */
export interface FileStateEntry {
  /** Read 时记录的 mtime（已 Math.floor 防亚毫秒抖动） */
  mtimeMs: number;
  /** 来自 Read 才有（offset!==undefined 判定"被读过"） */
  offset?: number;
  /** 来自 Read 才有 */
  limit?: number;
  /** Windows mtime 抖动回退用（P1，小文件才算） */
  contentHash?: string;
  /** 是否为部分视图（分页未读全）→ 不满足 Read-before-Write */
  isPartialView?: boolean;
}

const isWindows = process.platform === "win32";

/** 归一化路径作为缓存 key：统一分隔符/`..` 段，Windows 下大小写不敏感 */
export function normalizeFilePathKey(filePath: string): string {
  const normalized = path.normalize(filePath);
  return isWindows ? normalized.toLowerCase() : normalized;
}

/** 估算单条占用字节（仅 contentHash 可能稍大，其余固定开销） */
function estimateEntrySize(key: string, entry: FileStateEntry): number {
  return key.length * 2 + (entry.contentHash?.length ?? 0) * 2 + 64;
}

/**
 * 有界 LRU 文件状态缓存。
 * 手写 Map（保留插入顺序）实现 LRU，不引入第三方依赖。
 */
export class FileStateCache {
  private readonly map = new Map<string, FileStateEntry>();
  private currentBytes = 0;

  constructor(
    private readonly maxEntries = 100,
    private readonly maxSizeBytes = 25 * 1024 * 1024,
  ) {}

  get(filePath: string): FileStateEntry | undefined {
    const key = normalizeFilePathKey(filePath);
    const entry = this.map.get(key);
    if (entry === undefined) {
      return undefined;
    }
    // LRU 触达：移到末尾
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(filePath: string, entry: FileStateEntry): void {
    const key = normalizeFilePathKey(filePath);
    const existing = this.map.get(key);
    if (existing) {
      this.currentBytes -= estimateEntrySize(key, existing);
      this.map.delete(key);
    }
    this.map.set(key, entry);
    this.currentBytes += estimateEntrySize(key, entry);
    this.evict();
  }

  delete(filePath: string): void {
    const key = normalizeFilePathKey(filePath);
    const existing = this.map.get(key);
    if (existing) {
      this.currentBytes -= estimateEntrySize(key, existing);
      this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
    this.currentBytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  /** 驱逐最旧条目直到满足 max 条数与 max 字节 */
  private evict(): void {
    while (
      (this.map.size > this.maxEntries || this.currentBytes > this.maxSizeBytes) &&
      this.map.size > 0
    ) {
      const oldestKey = this.map.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      const oldest = this.map.get(oldestKey)!;
      this.currentBytes -= estimateEntrySize(oldestKey, oldest);
      this.map.delete(oldestKey);
    }
  }
}

/** 按 instanceId 隔离的注册表 */
const _registry = new Map<string, FileStateCache>();
const MAX_CACHE_INSTANCES = 100;

/** 获取（或创建）某 instance 的共享文件状态缓存 */
export function getFileStateCache(instanceId: string): FileStateCache {
  let cache = _registry.get(instanceId);
  if (!cache) {
    // 实例数封顶：FIFO 删除最早的若干个，防长期运行泄漏
    if (_registry.size >= MAX_CACHE_INSTANCES) {
      const keys = Array.from(_registry.keys());
      for (let i = 0; i < 20 && i < keys.length; i++) {
        _registry.delete(keys[i]!);
      }
    }
    cache = new FileStateCache();
    _registry.set(instanceId, cache);
  }
  return cache;
}

/** 测试用：清空注册表 */
export function _clearFileStateRegistry(): void {
  _registry.clear();
}
