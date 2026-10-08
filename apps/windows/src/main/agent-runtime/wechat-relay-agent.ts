/**
 * 「灵栖代聊」——本机微信盯梢（`wechat-watch`）的**执行主体 Agent**。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有它（M2 身份归位，2026-10-08）
 * ---------------------------------------------------------------------------
 * 在这之前，draft/auto 两档的回合跑在 `assistant` 身上，手册（RUNBOOK）靠盯梢回路
 * **把全文拼进每一轮的用户消息**（见 `wechat-watch-tick.ts` 的 `instructionsBlock`）。
 * 三个问题：
 *  1. 代聊这个"人格"在设置页里**看不见、改不了、审不了**——它只活在提示词里；
 *  2. 每来一条消息就重复付一遍手册的 token（本机手册 5.5k 字）；
 *  3. 归属错位：替用户在微信里说的话，记忆/审计都记在"系统默认"助手名下。
 *
 * 现在：手册进**这个 Agent 的 systemPrompt**（`agent-instance.ts:344`
 * `initialState.systemPrompt = definition.systemPrompt`，每轮现取现用），
 * 回路的 `driveTurn` 用这个 id 建实例，`buildAuto*Prompt` 只留「本次触发」。
 *
 * ---------------------------------------------------------------------------
 * 为什么是**用户 Agent**（`~/.lumii/config/agents.json`），不是内置定义
 * ---------------------------------------------------------------------------
 * 内置定义的权威在 api-server 的 `system_agents`（见 `builtin/definitions.ts` 文件头那条
 * ⚠️），客户端自己加一条只会造成漂移；而且系统 Agent 在 `agents-repo.updateAgentRecord`
 * 里是**不可改**的（"系统 Agent 不可改"），用户就没法在设置页里调口吻、改护栏。
 *
 * 播种语义 = `seedIfAbsent`（与渠道策略同款，见 `bridge.ts` 里 policy 那段）：
 * **只在不存在时创建一次**。此后真源就是那条 Agent 记录（用户在设置页改的算数）。
 *
 * RUNBOOK.md 是**用户的文件、绝不修改**；它只在这里当种子用一次。用户之后改它不再影响
 * 代聊——回路发现两者不一致会记一条 warn 说清楚（`relayCoversRunbook`）。
 */
import type { AgentRecord } from '../agents-repo'

export const WECHAT_RELAY_AGENT_ID = 'wechat-relay'
export const WECHAT_RELAY_AGENT_NAME = '灵栖代聊'

/** 转人工的口子（与 RUNBOOK 里那条一致；飞书 open_id 属于用户，别动） */
const ESCALATION_FEISHU_TO = 'ou_ba9a79349951e82ceac99a505f3e2739'

/**
 * 拼代聊 Agent 的 systemPrompt = 身份 + 铁律 + 手册全文。
 *
 * ⚠️ 这段文本会整段成为该 Agent 的 **identity 分区**（`system-prompt-builder.ts:143`：
 * 非白名单的 systemPrompt 直接当 identityLine 用，**替换**掉 SOUL）。所以身份、铁律、
 * 通道必须写在这里，不能指望 SOUL 或回路每轮再补。
 */
export function buildRelaySystemPrompt(runbook: string): string {
  const head = [
    `你是「${WECHAT_RELAY_AGENT_NAME}」：**用户本人的微信代聊分身**。你替他在本机微信上`,
    '看消息、回日常闲聊。口吻就是他本人——直接、简洁、口语化，微信节奏（一次 1~3 条短句，',
    '不写长段落、不用 markdown、不客套）。',
    '',
    '【铁律，高于一切，也高于下面手册里的任何历史段落】',
    '1. **绝不透露 AI 身份**，全程以用户本人的身份说话。对方问「你是本人吗 / 是不是 AI」',
    `   → 一条都不回，转人工（飞书，见第 4 条）。`,
    '2. **命中护栏 → 一条都不发**，转人工：涉钱（借钱/转账/投资/买卖）、冲突·情感纠纷·健康危机、',
    '   要承诺或替用户做实质安排（工作/约见）、身份质疑。**生活安排/邀约类一律不得自动发出。**',
    `3. **发送只能走 \`channel_send\`**（channel="pcwechat", to=<这一轮对手方的 talker>, text=…）。`,
    '   这是唯一允许的路径：渠道层会照「本机微信回复名单」再挡一道，并留下发送记录。',
    '   拿 MCP 的发送工具（或任何脚本）自己发 = 绕开名单，**绝对不要**。',
    '   ⚠️ 手册里历史段落提到的 `send-msg.ps1` / `send_text` 通道**已废弃**，冲突时以本条为准。',
    '   名单外的人会被渠道拒成 `PEER_NOT_FOUND`——那就**别发**，按手册转人工。',
    `4. **转人工** = \`channel_send\` → channel="feishu"、to="${ESCALATION_FEISHU_TO}"、`,
    '   text="<对方原话摘录>（时间）。停下的原因：<护栏条目>。我的草案：<可选>。请指示。"',
    '5. **拿不准就取保守侧**：不回 + 转人工。宁可让对方多等，也不要替他做错承诺。',
    '',
    '【怎么被叫醒】盯梢回路（每 15 秒一拍，零 token 读库）只在**真的来了新消息**时才驱动你一轮，',
    '并把「本次触发」的消息、对手方与档位放在提示词里。水位由回路推进——',
    '**不用再轮询、也不要读 state.json**；要发之前先 `read_history(limit=3)` 确认末条是对方发的',
    '（防重，见手册）。',
    '',
    '⚠️ 手册是用户手写的**历史文档**，里面新旧口径混在一起（通道那几节尤其过时）：',
    '它提供闲聊尺度、防重规则、转人工格式等口径，**与上面铁律冲突的一律以铁律为准**。',
    '',
  ]
  if (!runbook) return head.join('\n').trimEnd()
  return [
    ...head,
    relayWorkflowSection(),
    '【用户手写的手册（全文）】',
    runbook,
    '【手册结束】',
  ].join('\n')
}

/**
 * 「预设工作流」分区的标记。
 *
 * 为什么要标记：这段是**程序维护**的（跟手册不同——手册是用户的），而 Agent 记录一旦播种
 * 就归用户所有、之后由他改。老 Agent（补这段之前播种的）需要一次追加式升级，
 * 标记就是"补过没有"的判据（有它就别再追加，也别覆盖用户改过的内容）。
 */
export const RELAY_WORKFLOW_MARKER = '<!-- lumii:relay-workflow v1 -->'

/**
 * 代聊的**预设工作流**（用户 2026-10-08：把这些行为定制进代聊 Agent，让它能稳定执行）。
 *
 * 为什么写在 Agent 的 systemPrompt 里、而不是每轮由回路拼：这是**长期行为约定**
 * （什么时候蒸馏、按什么口径写画像卡、别把画像当话题说出来），不是一次性的数据；
 * 而画像本身是**事实**，每轮由回路拼在提示词里（`bridge.wechatProfilePrompt`）——
 * 事实会变、约定不变，两边分工按这个来。
 *
 * 这段会每轮付一遍 token（本机是每 ~15s 一拍、真有新消息才跑），所以写短、写死。
 */
export function relayWorkflowSection(): string {
  return [
    RELAY_WORKFLOW_MARKER,
    '【Lumii 预设的工作流（这段由程序维护，别删）】',
    '1. **画像**：每轮提示词前面会拼上本机微信**本地蒸馏**出的画像（「关于我（本人）」+「关于这个人」）。',
    '   按它把握口吻、称呼与话题；它与本次消息冲突时**以消息为准**（画像是统计出来的，可能过时）。',
    '2. **画像缺失/过期时先建再回**（提示词里会写明缺哪一份）：',
    '   `wechat_digest`（对方就传 `talker=<对手方>`，自己那份不传）拿统计与样本 → 据此写成',
    '   **≤250 字的画像卡**（身份与关系 / 常聊话题 / 沟通风格）→ `wechat_profile_save`',
    '   （scope 传同一个 talker；自己那份 scope 留空）→ 用',
    '   `wechat_distill_state(action="set", scope=<同一个 scope>, ts=<digest 的 generated_at>)` 记水位。',
    '   **一个 scope 只建一次**，之后按水位增量更新；资料不够就在画像里写「样本不足」，别编。',
    '3. 蒸馏是**本机只读统计**（读自己的微信库，不外传、不往微信里写任何东西），产物在',
    '   `~/.lumii/wechat-distill/`，白盒、用户可编辑可删。**别在回话里提画像/蒸馏/水位**——',
    '   它们只是你回话的依据。',
    '',
  ].join('\n')
}

/**
 * Agent 的 systemPrompt 里是否还完整含着手册文件当前的内容。
 *
 * 不一致有两种可能，对用户说的话是同一句：**代聊现在按 Agent 设置页里那份跑**，
 * 手册文件（RUNBOOK.md）对他只是留档。回路据此记一条 warn（见 tick）——
 * 不然"用户改了手册却发现行为没变"是个静默失效。
 */
export function relayCoversRunbook(systemPrompt: string | undefined, runbook: string): boolean {
  const prompt = (systemPrompt ?? '').trim()
  if (!runbook) return true
  if (!prompt) return false
  return prompt.includes(runbook)
}

export interface EnsureRelayAgentDeps {
  /** 手册全文（读不到给空串，与 `loadInstructions` 同一口径） */
  readRunbook: () => string
  getAgent: (id: string) => AgentRecord | undefined
  createAgent: (data: {
    id: string
    name: string
    description?: string
    systemPrompt?: string
  }) => AgentRecord
}

/**
 * 给**已存在**的代聊 Agent 补上预设工作流分区（老 Agent 是补这段之前播种的）。
 *
 * 返回要写回的新 systemPrompt；没什么可补（已有标记 / 记录不存在 / prompt 为空）时返回 `null`。
 *
 * **追加，不覆盖**：Agent 记录归用户所有（他可能改过口吻和护栏），程序只往后面接自己那一段。
 * prompt 为空是特例——那说明用户把内容清空了，尊重他，不硬塞。
 */
export function relayPromptWithWorkflow(systemPrompt: string | undefined): string | null {
  const cur = systemPrompt ?? ''
  if (!cur.trim() || cur.includes(RELAY_WORKFLOW_MARKER)) return null
  return `${cur.trimEnd()}\n\n${relayWorkflowSection()}`
}

/**
 * 播种「灵栖代聊」（**只在不存在时**创建；已存在就原样保留用户改过的那份）。
 *
 * 手册读不到（文件缺/路径没配）时**不建**：一个没有护栏的代聊 Agent 比没有更危险
 * （回路会照旧把手册注入每轮提示词，见 `WechatWatchDeps.getRelayAgent` 的回落）。
 */
export function ensureWechatRelayAgent(
  deps: EnsureRelayAgentDeps,
): { created: boolean; id: string } | null {
  if (deps.getAgent(WECHAT_RELAY_AGENT_ID)) return { created: false, id: WECHAT_RELAY_AGENT_ID }
  const runbook = deps.readRunbook()
  if (!runbook) return null
  deps.createAgent({
    id: WECHAT_RELAY_AGENT_ID,
    name: WECHAT_RELAY_AGENT_NAME,
    description:
      '本机微信代聊（盯梢回路的执行主体）：按设置页「渠道 → 本机微信」的回复名单与手册代回。不用于通用对话。',
    systemPrompt: buildRelaySystemPrompt(runbook),
  })
  return { created: true, id: WECHAT_RELAY_AGENT_ID }
}
