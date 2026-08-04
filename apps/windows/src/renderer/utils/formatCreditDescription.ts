/**
 * 积分流水/批次说明展示格式化（与 admin-console 逻辑一致）
 */

/** 匹配流水说明中旧版「管理员 + UUID」格式 */
const ADMIN_GRANT_UUID_IN_DESC =
  /管理员\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s+/i

/**
 * 积分流水/批次「说明」展示：管理员发放不展示 UUID，优先用 metadata 中的管理员账号名
 *
 * @param description - 原始说明
 * @param source - 流水来源
 * @param metadata - 扩展字段（可含 adminUsername）
 * @returns 对用户展示的文案
 */
export function formatCreditDescriptionForDisplay(
  description: string | undefined,
  source: string | undefined,
  metadata?: Record<string, unknown> | null,
): string {
  const raw = description?.trim() ?? ''
  if (!raw) {
    return ''
  }
  const name =
    typeof metadata?.adminUsername === 'string' ? metadata.adminUsername.trim() : ''
  if (source === 'admin_grant' || ADMIN_GRANT_UUID_IN_DESC.test(raw)) {
    if (name) {
      return raw.replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        name,
      )
    }
    return raw.replace(ADMIN_GRANT_UUID_IN_DESC, '管理员 ').replace(/\s{2,}/g, ' ').trim()
  }
  return raw
}
