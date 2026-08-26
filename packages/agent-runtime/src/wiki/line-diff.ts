/**
 * 行级 diff——自写 LCS，替代未安装的 `diff` 依赖
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md` §5.1
 * 页面正文规模（数千字）下 O(n·m) 可接受；长度积超过上限时降级为
 * 「首尾公共前缀/后缀 + 中间整体替换」，避免 O(n·m) 在超大文本上卡死。
 * 纯函数、无副作用。
 */

export type DiffLineType = "same" | "add" | "remove";

export interface DiffLine {
  readonly type: DiffLineType;
  readonly text: string;
}

/** 长度积上限：超过则跳过精确 LCS，改用前后缀降级策略 */
const LCS_MAX_PRODUCT = 4_000_000;

function splitLines(text: string): readonly string[] {
  if (text === "") return [];
  return text.split("\n");
}

/** 精确 LCS 行 diff（动态规划），O(n·m) 时间与空间 */
function diffLinesExact(oldLines: readonly string[], newLines: readonly string[]): DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;
  // dp[i][j] = oldLines[i..) 与 newLines[j..) 的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: "same", text: oldLines[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      result.push({ type: "remove", text: oldLines[i]! });
      i++;
    } else {
      result.push({ type: "add", text: newLines[j]! });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: "remove", text: oldLines[i]! });
    i++;
  }
  while (j < m) {
    result.push({ type: "add", text: newLines[j]! });
    j++;
  }
  return result;
}

/**
 * 降级策略：抽取首尾公共前缀/后缀行，中间部分整体标记为「先删后加」。
 * 不做行级精确对齐，仅保证结果正确（能还原两侧全文）且不卡死。
 */
function diffLinesFallback(oldLines: readonly string[], newLines: readonly string[]): DiffLine[] {
  let prefixLen = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefixLen < maxPrefix && oldLines[prefixLen] === newLines[prefixLen]) prefixLen++;

  let suffixLen = 0;
  const maxSuffix = Math.min(oldLines.length, newLines.length) - prefixLen;
  while (
    suffixLen < maxSuffix &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const result: DiffLine[] = [];
  for (let k = 0; k < prefixLen; k++) result.push({ type: "same", text: oldLines[k]! });

  const oldMidEnd = oldLines.length - suffixLen;
  const newMidEnd = newLines.length - suffixLen;
  for (let k = prefixLen; k < oldMidEnd; k++) result.push({ type: "remove", text: oldLines[k]! });
  for (let k = prefixLen; k < newMidEnd; k++) result.push({ type: "add", text: newLines[k]! });

  for (let k = oldLines.length - suffixLen; k < oldLines.length; k++) {
    result.push({ type: "same", text: oldLines[k]! });
  }
  return result;
}

/** 按行对比两段文本，输出统一 diff 格式 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  const product = oldLines.length * newLines.length;
  if (product > LCS_MAX_PRODUCT) {
    return diffLinesFallback(oldLines, newLines);
  }
  return diffLinesExact(oldLines, newLines);
}
