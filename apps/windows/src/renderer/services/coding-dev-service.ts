/**
 * 开发类 AI 工具（ACP）服务 — 封装 window.electronAPI.app 的 coding-dev 子域
 *
 * 动作 / 探测型接口：错误向调用方抛出（原调用点负责展示提示）。
 */

/** 获取 ACP 环境说明与当前解析的工作区 */
export async function getCodingDevEnvInfo() {
  return window.electronAPI.app.getCodingDevEnvInfo()
}

/** 探测单个工具（安装状态 / 版本 / 解析路径） */
export async function detectCodingDevTool(toolId: string) {
  return window.electronAPI.app.detectCodingDevTool(toolId)
}

/** 获取本机工具元数据（无版本 / 状态探测，快速返回） */
export async function listCodingDevToolsMetadata() {
  return window.electronAPI.app.listCodingDevToolsMetadata()
}

/** 一键执行官方安装脚本 */
export async function installCodingDevTool(toolId: string) {
  return window.electronAPI.app.installCodingDevTool(toolId)
}

/** 卸载前预览：将要执行的命令与风险提示（不执行任何命令） */
export async function previewUninstallCodingDevTool(toolId: string) {
  return window.electronAPI.app.previewUninstallCodingDevTool(toolId)
}

/** 执行卸载（用户确认后） */
export async function uninstallCodingDevTool(toolId: string) {
  return window.electronAPI.app.uninstallCodingDevTool(toolId)
}

/** 触发 CLI 登录（如 cursor agent login 打开浏览器 OAuth） */
export async function loginCodingDevTool(toolId: string) {
  return window.electronAPI.app.loginCodingDevTool(toolId)
}

/** 开发类 Agent 的本机绑定（Agent → CLI + 工作目录） */
export type CodingDevAgentBinding = {
  agentId: string
  backendId: 'claude' | 'codex' | 'cursor' | 'opencode'
  workspace?: string
  enabled: boolean
  permissionMode?: string
}

/** 读取开发类 Agent 的本机绑定列表 */
export async function getCodingDevAgentBindings(): Promise<CodingDevAgentBinding[]> {
  return window.electronAPI.app.getCodingDevAgentBindings() as Promise<CodingDevAgentBinding[]>
}

/** 覆盖式保存开发类 Agent 的本机绑定列表 */
export async function setCodingDevAgentBindings(
  bindings: CodingDevAgentBinding[],
): Promise<{ ok: boolean }> {
  return window.electronAPI.app.setCodingDevAgentBindings(bindings)
}
