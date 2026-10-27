/**
 * 单次 Agent run 内锁定流式模型，避免工具间隙会话偏好被 prime 改掉导致中途错切。
 */

/**
 * 解析本跳应使用的模型引用：若本 run 已锁定则复用，否则用当前偏好或默认并锁定。
 *
 * @param pinnedRef 本 run 已锁定的模型 id（无则 undefined）
 * @param preferredRaw 会话级偏好原始串
 * @param defaultModelId 工厂默认模型 id
 */
export function resolvePinnedStreamModelRef(
  pinnedRef: string | undefined,
  preferredRaw: string | undefined,
  defaultModelId: string,
): { targetRef: string; nextPinnedRef: string } {
  if (pinnedRef?.trim()) {
    const locked = pinnedRef.trim()
    return { targetRef: locked, nextPinnedRef: locked }
  }
  const fromPref = preferredRaw?.trim()
  const targetRef = fromPref || defaultModelId
  return { targetRef, nextPinnedRef: targetRef }
}
