export function isMcpEnabledForSession(
  serverName: string,
  disabledServers: readonly string[],
): boolean {
  return !disabledServers.includes(serverName)
}
