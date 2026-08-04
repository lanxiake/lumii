/**
 * 判断 Agent 镜像事件是否属于宠物窗口当前绑定的会话。
 * 同时匹配 rootSessionKey 与 sessionKey，避免子实例键与根键不一致时丢事件。
 */
export function petSessionMatchesEvent(
  localSessionKey: string,
  event: { sessionKey?: string; rootSessionKey?: string },
): boolean {
  if (!localSessionKey) return true
  const root = event.rootSessionKey ?? event.sessionKey
  const sk = event.sessionKey
  return root === localSessionKey || sk === localSessionKey
}
