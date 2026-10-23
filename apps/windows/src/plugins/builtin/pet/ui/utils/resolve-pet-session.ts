/**
 * resolvePetSessionKey - 解析宠物模式语音/对话所用的 sessionKey
 *
 * 优先使用主窗口同步的 activeSessionKey；若无则取最近会话或新建「宠物对话」。
 */

const log = {
  info: (...args: unknown[]) => console.log('[resolvePetSession]', ...args),
  warn: (...args: unknown[]) => console.warn('[resolvePetSession]', ...args),
}

function isCommandError(result: unknown): result is { error: string } {
  return typeof result === 'object' && result !== null && 'error' in result
}

/**
 * 解析并缓存宠物模式会话 key（写入主进程 activeSessionKey）。
 */
export async function resolvePetSessionKey(): Promise<string> {
  const pet = window.electronAPI?.pet
  const cached = (await pet?.getActiveSessionKey()) || ''
  if (cached) return cached

  const runtime = window.electronAPI?.agentRuntime
  if (!runtime?.sendCommand) {
    throw new Error('Agent Runtime 不可用，无法创建会话')
  }

  const listResult = await runtime.sendCommand({ type: 'conversation:list' })
  let sessionKey = ''

  if (Array.isArray(listResult) && listResult.length > 0) {
    const first = listResult[0] as { sessionKey?: string }
    sessionKey = first.sessionKey ?? ''
    log.info(`使用最近会话 sessionKey=${sessionKey}`)
  }

  if (!sessionKey) {
    const created = await runtime.sendCommand({
      type: 'conversation:create',
      title: '宠物对话',
    })
    if (!isCommandError(created) && created && typeof created === 'object' && 'sessionKey' in created) {
      sessionKey = (created as { sessionKey: string }).sessionKey
      log.info(`已创建宠物会话 sessionKey=${sessionKey}`)
    }
  }

  if (!sessionKey) {
    throw new Error('无法解析或创建会话，请先在桌面模式打开一次聊天')
  }

  await pet?.setActiveSessionKey(sessionKey)
  return sessionKey
}
