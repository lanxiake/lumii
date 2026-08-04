/**
 * 本机开发类 AI 工具（ACP）提示执行入口
 *
 * 灵栖/Lumii：仅连接本机已安装的 Cursor / Claude / Codex / Copilot CLI。
 */

import { runLocalAcpCli } from '../coding-dev-local-runner.js'
import type {
  CodingDevLightweightBackendOutput,
  CodingDevLightweightBackendProgress,
} from './contracts.js'

export type CodingDevAcpPromptNodeParams = {
  backendId: string
  text: string
  images?: Array<{ mimeType: string; base64: string }>
  accountId: string
  peerId: string
  senderId: string
  contextToken?: string
  timestamp?: number
  cwd?: string
  emitProgress?: (progress: CodingDevLightweightBackendProgress) => Promise<void> | void
  abortSignal?: AbortSignal
}

/**
 * 在本机工作目录运行对应 CLI，流式回传进度
 */
export async function runCodingDevAcpPrompt(
  params: CodingDevAcpPromptNodeParams,
): Promise<CodingDevLightweightBackendOutput | void> {
  const cwd =
    params.cwd?.trim() ||
    process.env.MTBOT_CURSOR_ACP_CWD?.trim() ||
    process.env.MTBOT_CLAUDE_ACP_CWD?.trim() ||
    process.env.MTBOT_CODEX_ACP_CWD?.trim() ||
    process.env.MTBOT_COPILOT_ACP_CWD?.trim() ||
    process.cwd()
  return runLocalAcpCli({
    backendId: params.backendId,
    text: params.text,
    cwd,
    emitProgress: params.emitProgress,
    abortSignal: params.abortSignal,
  })
}
