/**
 * Image 命令处理器（image:*）
 */

import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'

const log = {
  info: (...args: unknown[]) => console.log('[agent-runtime-ipc/image]', ...args),
  error: (...args: unknown[]) => console.error('[agent-runtime-ipc/image]', ...args),
}

export async function handleImageRecognize(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'image:recognize' }>,
): Promise<unknown> {
  const { imagePath, modelId, prompt, includeOcr } = command
  try {
    const result = await bridge.recognizeImage({
      imagePath,
      modelId,
      prompt,
      includeOcr,
    })
    log.info(`[image:recognize] 识别完成 model=${result.modelId} descLen=${result.description.length} ocrLen=${result.ocrText.length}`)
    return result
  } catch (err) {
    log.error(`[image:recognize] 失败:`, err)
    throw err
  }
}

export async function handleImageGenerate(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'image:generate' }>,
): Promise<unknown> {
  const { prompt, modelId, width, height } = command
  try {
    const result = await bridge.generateImage({ prompt, modelId, width, height })
    log.info(`[image:generate] 生成完成: ${result.filePath} (${result.width}x${result.height})`)
    return result
  } catch (err) {
    log.error(`[image:generate] 失败:`, err)
    throw err
  }
}

export async function handleImageProcess(
  _bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'image:process' }>,
): Promise<unknown> {
  const { operation } = command
  // 预留接口：当前仅支持未来注册的策略，目前统一抛错
  // 注册方式（后续实现）：const strategy = imageStrategies[operation]; if (strategy) return strategy.run(...)
  throw new Error(`图片处理操作 '${operation}' 尚未实现，功能开发中`)
}
