/**
 * 格式化 token 数量用于 UI 展示（1K / 128K / 1M）
 */
export function formatTokenCount(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(n);
}

/**
 * 构造上下文用量展示文案：`12.5K/1M (1%)`
 */
export function formatContextUsageCompact(usedTokens: number, contextWindow: number): string {
  if (contextWindow <= 0) return '--';
  const ratio = usedTokens / contextWindow;
  const percent = Math.round(ratio * 100);
  return `${formatTokenCount(usedTokens)}/${formatTokenCount(contextWindow)} (${percent}%)`;
}
