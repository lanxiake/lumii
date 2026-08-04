/**
 * 权限记忆 — 进程内短期「允许同类工具」缓存
 *
 * 用户点击「允许并记住」后，在 durationMs 内对同名工具跳过确认。
 * 拒绝不记忆；进程退出即清空（不做持久化）。
 */

/** 默认「记住允许」时长：24 小时 */
export const DEFAULT_PERMISSION_MEMORY_MS = 24 * 60 * 60 * 1000;

/**
 * 权限记忆存储
 */
export class PermissionMemory {
  /** toolName → 允许失效时间戳 (ms) */
  private readonly allowExpires = new Map<string, number>();

  /**
   * 记录用户对某工具的一次决策
   *
   * @param toolName - 工具名（与注册名一致，如 bash、file_write）
   * @param allowed - 仅在为 true 时写入；false 表示不记忆
   * @param durationMs - 允许有效期
   */
  recordDecision(toolName: string, allowed: boolean, durationMs: number): void {
    if (!allowed) return;
    this.allowExpires.set(toolName, Date.now() + Math.max(0, durationMs));
  }

  /**
   * 查询是否在记忆窗口内曾允许该工具
   *
   * @returns true 表示仍有效；undefined 表示无记忆或已过期
   */
  getDecision(toolName: string): boolean | undefined {
    const exp = this.allowExpires.get(toolName);
    if (exp === undefined) return undefined;
    if (Date.now() > exp) {
      this.allowExpires.delete(toolName);
      return undefined;
    }
    return true;
  }

  /**
   * 清空全部记忆（用于测试或会话重置）
   */
  clear(): void {
    this.allowExpires.clear();
  }
}
