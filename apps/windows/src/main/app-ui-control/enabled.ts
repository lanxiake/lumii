/**
 * Agent App UI 控制总开关：读取渲染进程 localStorage 设置。
 */

/** 从设置 JSON 解析 allowAgentAppUiControl（缺省或未设置时为 true） */
export async function isAppUiControlEnabled(
  getSettingsJson: () => Promise<string | null>,
): Promise<boolean> {
  try {
    const json = await getSettingsJson()
    if (!json) return true
    const parsed = JSON.parse(json) as { privacy?: { allowAgentAppUiControl?: boolean } }
    return parsed.privacy?.allowAgentAppUiControl !== false
  } catch {
    return true
  }
}
