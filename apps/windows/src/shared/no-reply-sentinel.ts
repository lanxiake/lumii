/**
 * NO_REPLY 哨兵判据（主进程与渲染进程共用）。
 *
 * 协议：Agent 无话可说时整条回复就是 `NO_REPLY`。渠道轮（微信/飞书/QQ）的常态是
 * 「干活 → channel_send 把答案发给对端 → 最后用哨兵收尾」，所以哨兵**不代表整轮没有产出**，
 * 只代表「这条 LLM 调用不用再往对话流里说一遍」。
 *
 * 两侧必须用同一判据，否则会出现「库里留着、界面被删掉」的反向漂移：
 * 主进程 `agent:end` 只在**整轮只剩哨兵**时删行，渲染层早期却在**任意一次 message:end
 * 命中哨兵**时就删掉整条助手气泡（连工具轨迹一起）——飞书回合因此在 App 里看不到回复。
 */
export function isNoReplySentinel(text: string | undefined): boolean {
  return typeof text === "string" && text.trim().toUpperCase() === "NO_REPLY";
}
