/**
 * 记忆行合并判定（纯函数）——从 `SyncImporter.mergeMemory` 抽出，便于单测。
 *
 * 设计：`docs/design/记忆系统/2026-09-17-记忆系统评审.md` §4.4（非破坏失效）。
 *
 * 两条规则，优先级从高到低：
 * 1. **墓碑取胜**：任一侧已写 `deleted_at`，删除这一事实就必须保住，不论时间戳谁更新。
 *    删除本身不改活动时间，所以"谁的时间戳大"根本回答不了"谁先删的"。
 * 2. **时间戳取胜**：两侧都活着时，活动时间（`last_injected_at`，旧版本回退 `last_used`）
 *    更大的一方覆盖对方。
 */

export type MemoryMergeAction =
  /** 本地没有该行，直接插入远端记录 */
  | 'insert'
  /** 用远端整行覆盖本地 */
  | 'take_remote'
  /** 只把远端的 deleted_at 落到本地（不覆盖内容） */
  | 'apply_remote_tombstone'
  /** 本地墓碑更早，用本地的 deleted_at 覆盖远端带来的值 */
  | 'keep_local_tombstone'
  /** 保持本地不变 */
  | 'keep_local';

export interface MemoryMergeInput {
  /** 本地是否已有该 id 的行 */
  readonly localExists: boolean;
  /** 活动时间（`last_injected_at` ?? `last_used`），ISO 字符串 */
  readonly remoteTs: string;
  readonly localTs: string;
  readonly remoteDeletedAt: string | null | undefined;
  readonly localDeletedAt: string | null | undefined;
}

const isDeleted = (v: string | null | undefined): v is string => v !== null && v !== undefined;

export function decideMemoryMerge(input: MemoryMergeInput): MemoryMergeAction {
  if (!input.localExists) return 'insert';

  const { remoteDeletedAt, localDeletedAt } = input;
  const remoteDeleted = isDeleted(remoteDeletedAt);
  const localDeleted = isDeleted(localDeletedAt);

  // 规则 1：墓碑取胜
  if (remoteDeleted && !localDeleted) return 'apply_remote_tombstone';
  if (remoteDeleted && localDeleted) {
    // 两侧都删了：取更早的删除时间，其余不动
    return String(remoteDeletedAt) < String(localDeletedAt)
      ? 'apply_remote_tombstone'
      : 'keep_local';
  }
  if (localDeleted) return 'keep_local_tombstone';

  // 规则 2：时间戳取胜
  return input.remoteTs > input.localTs ? 'take_remote' : 'keep_local';
}
