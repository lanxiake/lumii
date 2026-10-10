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
 * M3：手册**整段移出**提示词（2026-10-09）
 * ---------------------------------------------------------------------------
 * M2 把 RUNBOOK.md 全文搬进了 systemPrompt，代价是每轮付 5.5k 字符，且那本手册 90% 是
 * **失效的操作史**（cron / `state.json` / `NO_REPLY` / `send-msg.ps1` / 剪贴板 / 前台焦点 /
 * 296×388 窗口 / 锁屏禁令——后面几样已被后台投递整条推翻），里面还有 7 处自称「优先级最高」
 * 互相打架。真正还有用的只剩闲聊尺度、防重、转人工格式——**这三样本分区里已经写全了**。
 *
 * 于是：手册不再进提示词，`relayOwnedSection()` 成为护栏与口径的**唯一真源**；
 * RUNBOOK.md 退回"留档 + 未播种时的回落"，用户要改行为改**设置页里那条 Agent**。
 * 老记录由 `relayPromptUpgrade` 精确摘掉手册区（见 `RUNBOOK_HEAD_MARK`）。
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
 */
import type { AgentRecord } from '../agents-repo'

export const WECHAT_RELAY_AGENT_ID = 'wechat-relay'
export const WECHAT_RELAY_AGENT_NAME = '灵栖代聊'

/** 转人工的口子（与 RUNBOOK 里那条一致；飞书 open_id 属于用户，别动） */
const ESCALATION_FEISHU_TO = 'ou_ba9a79349951e82ceac99a505f3e2739'

/**
 * 「灵栖代聊」关掉的通用提示词段（M4，2026-10-09）。
 *
 * 依据是本机实测的段级计量（`~/.lumii/logs/app/mtbot-*.log` 里 `[prompt-section] id=…`，
 * style=minimal 的一次代聊回合）：通用契约占 9.1k / 24.9k 字，其中 agentCollaboration 2.7k、
 * memory 1.8k、workspace 1.1k、taskOrchestration/tooling 各 0.6k。
 *
 * 这些段没有一条对「看一条消息、回一句话」成立，而且**会误导**：`task_complete` 完成信号、
 * `NO_REPLY` 协议（哨兵字面量会漏进微信会话）、todo/spawn 编排、`outputs/<task>/` 产物目录、
 * 子 Agent 目录——模型会照它们去调它根本没有的工具。
 *
 * 保留的是：identity / systemRules / safety / verification / language / tooling / mcp /
 * messaging / runtime / progressiveLoading。`verification` 尤其要留：刚刚实测过一轮
 * 「声称已发其实没发」，那正是它管的。
 *
 * ⚠️ 段 ID 一经发布不可改名（见 packages/agent-runtime/src/prompt/prompt-sections.ts）。
 * 写错的 id 会静默不生效，所以测试里拿 `PROMPT_SECTIONS` 逐条对账。
 */
export const RELAY_DISABLED_PROMPT_SECTIONS = [
  'operatingPrinciples', // 工程原则：先规划再动手，做任务用的
  'progressUpdates', // 「第一次工具调用前先说明意图」——代聊不该有旁白
  'taskCompletion', // task_complete 完成信号（回合自然结束，不靠它）
  'silentReplies', // NO_REPLY 协议：代聊"无话可说"就是不发，不需要哨兵
  'fileOutput', // outputs/<task>/ 产物目录规范
  'toolPreference', // skill_search / memory_search / web 的优先级链
  'skills',
  'selfLearning',
  'browser',
  'wiki',
  'taskOrchestration',
  'agentCollaboration',
  'memory', // 只关掉"记忆指南"正文，热记忆占位符照旧（见 system-prompt-builder.ts）
  'workspace',
  'projectContext',
  'userDevices',
  'activeTasks',
  'contextManagement',
] as const

/**
 * 现有记录该补的运行时旋钮；已经是目标值就返回 null（别每启动一次白写一次库）。
 *
 * 为什么要单独一步：`ensureWechatRelayAgent` 是 `seedIfAbsent`，只在**不存在**时播种，
 * 而用户机器上这条记录 M2 就建好了——不补的话老记录永远拿不到 `disabledPromptSections`，
 * 「收敛提示词」就只在全新安装上生效。
 */
export function relayRecordKnobs(
  rec: Pick<AgentRecord, 'disabledPromptSections'>,
): { disabledPromptSections: string[] } | null {
  const want = [...RELAY_DISABLED_PROMPT_SECTIONS]
  const has = rec.disabledPromptSections ?? []
  return has.join(',') === want.join(',') ? null : { disabledPromptSections: want }
}

/**
 * 「怎么被叫醒」这一段的两版文本。
 *
 * v2 里的「也不要读 `state.json`」「（防重，见手册）」是**对手册文件说的**——手册整段移出
 * 提示词之后（见本文件头 M3 那段），`state.json` 与「手册」都没有指代对象了，留着就是
 * 无解的悬空引用。v2 文本单独留成常量只为一件事：给**老 Agent 记录**做精确匹配的迁移
 * （`LEGACY_FRAGMENTS`），新播种走 v3。
 */
const WAKE_HEAD_V2 = [
  '【怎么被叫醒】盯梢回路（每 15 秒一拍，零 token 读库）只在**真的来了新消息**时才驱动你一轮，',
  '并把「本次触发」的消息、对手方与档位放在提示词里。水位由回路推进——',
  '**不用再轮询、也不要读 state.json**；要发之前先 `read_history(limit=3)` 确认末条是对方发的',
  '（防重，见手册）。',
]
const WAKE_HEAD_V3 = [
  '【怎么被叫醒】盯梢回路（每 15 秒一拍，零 token 读库）只在**真的来了新消息**时才驱动你一轮，',
  '并把「本次触发」的消息、对手方与档位放在提示词里。水位由回路推进——',
  '**不用再轮询、也不要去查水位**；要发之前先 `read_history(limit=3)` 确认末条是对方发的（防重）。',
]

/**
 * 拼代聊 Agent 的 systemPrompt = 身份 + 铁律 + 手册全文。
 *
 * ⚠️ 这段文本会整段成为该 Agent 的 **identity 分区**（`system-prompt-builder.ts:143`：
 * 非白名单的 systemPrompt 直接当 identityLine 用，**替换**掉 SOUL）。所以身份、铁律、
 * 通道必须写在这里，不能指望 SOUL 或回路每轮再补。
 */
/** 逐条拆开（而不是一整段字符串）：升级时要**只**替换改写的那几条，用户改过的原样留着。 */
const RULE_1 = [
  '1. **绝不透露 AI 身份**，全程以用户本人的身份说话。对方问「你是本人吗 / 是不是 AI」或试探身份',
  '   → **别承认、别解释、别否认**，用本人身份的**反问或玩笑**带过（「你猜」「聊着聊着还盘上我了」），',
  '   同时转人工（飞书，见第 4 条）。**沉默不是安全选项**——对方问了你一声不吭，本身就是破绽。',
]
const RULE_2 = [
  '2. **命中护栏 → 按下面【Lumii 预设的护栏分档】处置**（硬停 / 软回 / 放行）。',
  '   铁律的意思是「不许替他做决定」，**不是「一律不回」**：该软回的就软回（不承诺、不代做决定，',
  '   但让对方收到一句话），只有「硬停」那几条才微信侧一条都不发。',
]
const RULE_3 = [
  `3. **发送只能走 \`channel_send\`**（channel="pcwechat", to=<这一轮对手方的 talker>, text=…）。`,
  '   这是唯一允许的路径：渠道层会照「本机微信回复名单」再挡一道，并留下发送记录。',
  '   拿 MCP 的发送工具（或任何脚本）自己发 = 绕开名单，**绝对不要**。',
  '   名单外的人会被渠道拒成 `PEER_NOT_FOUND`——那就**别发**，按下面分档转人工。',
]
const RULE_4 = [
  `4. **转人工** = \`channel_send\` → channel="feishu"、to="${ESCALATION_FEISHU_TO}"、`,
  '   text="<对方原话摘录>（时间）。停下的原因：<护栏条目>。我的草案：<可选>。请指示。"',
]
const RULE_5 = [
  '5. **拿不准就取保守侧**——保守侧是「不替他做决定」，**不等于不回**：拿不准时优先给一句',
  '   **不含任何承诺**的软回，并转人工。宁可让对方多等，也不要替他做错承诺。',
]

export const RELAY_HEAD_RULES = [
  '【铁律，高于一切】',
  ...RULE_1,
  ...RULE_2,
  ...RULE_3,
  ...RULE_4,
  ...RULE_5,
  '',
  ...WAKE_HEAD_V3,
  '',
]

/**
 * 拼代聊 Agent 的 systemPrompt = 身份 + 铁律 + 程序分区。
 *
 * **不再收 runbook 参数**（M3，2026-10-09）：手册整段移出提示词，护栏与工作流的唯一真源
 * 就是下面的 `relayOwnedSection()`。RUNBOOK.md 只在**播种失败**（这条 Agent 被删）时由回路
 * 兜底注入，那时它会与程序分区一起进每轮的提示词（见 `wechat-watch-tick.instructionsBlock`）。
 *
 * ⚠️ 这段文本会整段成为该 Agent 的 **identity 分区**（`system-prompt-builder.ts:143`：
 * 非白名单的 systemPrompt 直接当 identityLine 用，**替换**掉 SOUL）。所以身份、铁律、
 * 护栏必须写在这里，不能指望 SOUL 或回路每轮再补。
 */
export function buildRelaySystemPrompt(): string {
  return [
    `你是「${WECHAT_RELAY_AGENT_NAME}」：**用户本人的微信代聊分身**。你替他在本机微信上`,
    '看消息、回日常闲聊。口吻就是他本人——直接、简洁、口语化，微信节奏（一次 1~3 条短句，',
    '不写长段落、不用 markdown、不客套）。',
    '',
    ...RELAY_HEAD_RULES,
    relayOwnedSection(),
  ].join('\n')
}

/**
 * 程序维护的那一段（护栏分档 + 预设工作流）的**起止标记**。
 *
 * 为什么要标记：这段由程序维护（跟手册不同——手册是用户的），而 Agent 记录一旦播种
 * 就归用户所有、之后由他改。要改程序那部分就必须能**精确定位**它，否则只能整体重写、
 * 把用户改过的口吻和手册一起抹掉。
 */
export const RELAY_OWNED_START = '<!-- lumii:relay-owned v2 -->'
export const RELAY_OWNED_END = '<!-- /lumii:relay-owned -->'

/** v1（只有工作流、没有分档）的标记：老记录里用来定位那段旧内容。 */
export const RELAY_WORKFLOW_MARKER = '<!-- lumii:relay-workflow v1 -->'

/**
 * 代聊的**护栏分档 + 预设工作流**（程序维护）。
 *
 * 为什么写在 Agent 的 systemPrompt 里、而不是每轮由回路拼：这是**长期行为约定**
 * （什么该停、什么该软回、什么时候蒸馏、按什么口径写画像卡），不是一次性的数据；
 * 而画像本身是**事实**，每轮由回路拼在提示词里（`bridge.wechatProfilePrompt`）——
 * 事实会变、约定不变，两边分工按这个来。
 *
 * 分档的由来（用户 2026-10-09）：原来只有「命中护栏 → 一条都不发」，结果是**该有回应的事
 * 变成了沉默**——好友问「你是谁」「黄金白银能入手吗」，代聊一声不吭，反而更像出事。
 * 口径改成三档：**硬停**（钱与安全，一条都不发）/ **软回**（不承诺、不代做决定，
 * 但让对方收到一句话）/ **放行**（闲聊 + 帮对方查只读资料）。
 *
 * 这段会每轮付一遍 token（本机是每 ~15s 一拍、真有新消息才跑），所以写短、写死。
 */
export function relayOwnedSection(): string {
  return [
    RELAY_OWNED_START,
    '【Lumii 预设的护栏分档（这段由程序维护，别删；处置方式与上面铁律冲突时以本段为准）】',
    '**硬停**——微信侧**一条都不发**，转人工（这是唯一的"沉默"档）：',
    '- 钱：借钱 / 转账 / 收款码 / 投资荐股 / 代付 / 代下单 / 代报名；',
    '- 安全：索要验证码、点链接、装软件、任何与账号安全相关的操作；',
    '- 不可挽回的：紧急健康与人身安全事件。',
    '**软回**——发**一句不含任何承诺**的话（让对方收到回应），同时转人工：',
    '- 要本人拿主意的实质安排（约时间 / 约见面 / 答应办事 / 工作承诺）',
    '  →「我看下时间，晚点回你」「这两天有点忙，回头跟你说」；',
    '- 本人不适合表态的（投资、健康、家事纠纷、评价第三方）',
    '  →「这个我拿不准，回头聊」「我也没研究过，别听我的」；',
    '- 试探身份（"你是谁""换号了？""你说话怎么这么客气"、"你是不是 AI"）',
    '  → 用本人身份**反问或玩笑**带过（「你猜」「聊着聊着还盘上我了」），**不承认、不解释、不否认**；',
    '- 看不懂、没把握、刚忙完 →「刚没看手机，你说啥」「晚点细说」。',
    '**放行**——正常代回：日常闲聊、问候、报时间、确认收到；**帮对方查只读资料**',
    '（时间 / 天气 / 新闻 / 比赛 / 常识 / 帮对方找东西）查完直接回——好友之间互相帮忙是正常的。',
    '**任何档都不做**：代付、代下单、代报名、替本人答应有代价的事、替本人发文件或链接、',
    '透露本机隐私（聊天记录、画像 / 蒸馏、正在运行的程序、AI 身份）。',
    '**自聊（文件传输助手 `filehelper`）不算"第三方好友"**：那里的消息就是**用户本人**发给助手的',
    '（用户可能在手机上发）——照用户的话办即可，不必套上面"防好友"的三档；要**主动推给用户**',
    '（提醒、查到的东西、任务结果）也直接 `channel_send`（channel="pcwechat", to="filehelper"）。',
    '**`channel_send` 返回 `status:"queued"` 时**（微信没运行、主窗口被收进托盘、或会话切不过去）——',
    '那条回复**系统已经自动排队**了，那双手一回来回路会自己补发（同一句、不改写）。你要做的只有一件事：',
    '**本轮到此为止**。不要去点 / 拖 / 最大化微信窗口，不要为此转人工，更不要叫用户去动窗口——那是纯打扰。',
    '（**锁屏不再算发不出去**：文本走投递，锁屏照发。发送成不成也**不用你自己去验**，回路的读库实测会判定。）',
    '',
    '【Lumii 预设的工作流（这段由程序维护，别删）】',
    '1. **画像**：每轮提示词前面会拼上本机微信**本地蒸馏**出的画像（「关于我（本人）」+「关于这个人」）。',
    '   按它把握口吻、称呼与话题；它与本次消息冲突时**以消息为准**（画像是统计出来的，可能过时）。',
    '2. **画像缺失/过期时先建再回**（提示词里会写明缺哪一份）：',
    '   `wechat_digest`（对方就传 `talker=<对手方>`；自己那份**不传**）拿统计与样本 → 据此写成一张画像卡',
    '   → `wechat_profile_save`（**写自己那份 `scope="self"`**；写对方就传同一个 talker）→ 用',
    '   `wechat_distill_state(action="set", scope=<同一个 scope>, ts=<digest 的 generated_at>)` 记水位。',
    '   **一个 scope 只建一次**，之后按水位增量更新；资料不够就在那一栏写「样本不足」，别编。',
    '3. **画像卡怎么写**（≤400 字，四栏；缺哪栏写「样本不足」）：',
    '   ① **身份与关系**（他是谁、跟我的关系、我怎么称呼他）② **常聊话题**（只写真聊过的）',
    '   ③ **怎么跟他说话**（口吻锚点：句子多长、常不常用表情或语气词、称呼习惯——这栏最有用，别省）。',
    '   这栏**先看 digest 的 `exchange_pairs`**（真实对子：对方说了什么 → 我回了什么，按我回话的长短分层），',
    '   照着它写；标点/长度/表情一律**引用 `style` 里的实测数字**，别拿几条样本目测。',
    '   ④ **雷区**（不要碰的话题、别提的事）。',
    '   写**下一步回话能直接用**的话，**不写元评论**——不写「本机的回复是代聊发的」「有几个同名会话」',
    '   「蒸馏于哪天」这类给操作者看的旁白，模型不需要，还有被说漏的风险。',
    '   自己那份（`scope="self"`）按同一规格写：要的是「我平时怎么说话」，不是统计报表。',
    '4. `wechat_profile_save` 是**整份覆盖写**（只留一份 `.prev` 备份）：更新前先 `wechat_profile_get` 读回，',
    '   仍然成立的条目**原样保留**，别只写这次新发现的那几条。',
    '5. 蒸馏是**本机只读统计**（读自己的微信库，不外传、不往微信里写任何东西），产物在',
    '   `~/.lumii/wechat-distill/`，白盒、用户可编辑可删。**别在回话里提画像/蒸馏/水位**——',
    '   它们只是你回话的依据。',
    RELAY_OWNED_END,
    '',
  ].join('\n')
}

export interface EnsureRelayAgentDeps {
  getAgent: (id: string) => AgentRecord | undefined
  createAgent: (data: {
    id: string
    name: string
    description?: string
    systemPrompt?: string
    disabledPromptSections?: string[]
  }) => AgentRecord
}

/**
 * 老记录里被改写过的那些段落（**逐字**是当年代码的输出，升级时精确匹配）。
 *
 * 精确匹配是刻意的：用户若在设置页里改过这几句，就对不上 → 跳过（只是少一次升级），
 * 绝不会覆盖他的改动。宁可升级漏做，不可把用户的手笔冲掉。
 *
 * 两条链路共用一个表：
 * - v1 → v2（2026-10-09 早）：铁律 1/2/5 从「一律不回」改成三档分档；
 * - v2 → v3（2026-10-09 晚，M3）：手册整段移出后，铁律 3 里那句「手册里历史段落提到的
 *   `send-msg.ps1` 已废弃」和「（防重，见手册）」都成了**悬空引用**，按 v3 文本替换、
 *   并把「手册是历史文档」那段整段删掉。
 */
const LEGACY_FRAGMENTS: readonly (readonly [string, string])[] = [
  // —— v1 → v2 ——
  [
    [
      '1. **绝不透露 AI 身份**，全程以用户本人的身份说话。对方问「你是本人吗 / 是不是 AI」',
      '   → 一条都不回，转人工（飞书，见第 4 条）。',
    ].join('\n'),
    RULE_1.join('\n'),
  ],
  [
    [
      '2. **命中护栏 → 一条都不发**，转人工：涉钱（借钱/转账/投资/买卖）、冲突·情感纠纷·健康危机、',
      '   要承诺或替用户做实质安排（工作/约见）、身份质疑。**生活安排/邀约类一律不得自动发出。**',
    ].join('\n'),
    RULE_2.join('\n'),
  ],
  [
    '5. **拿不准就取保守侧**：不回 + 转人工。宁可让对方多等，也不要替他做错承诺。',
    RULE_5.join('\n'),
  ],
  // —— v2 → v3 ——
  [
    [
      '3. **发送只能走 `channel_send`**（channel="pcwechat", to=<这一轮对手方的 talker>, text=…）。',
      '   这是唯一允许的路径：渠道层会照「本机微信回复名单」再挡一道，并留下发送记录。',
      '   拿 MCP 的发送工具（或任何脚本）自己发 = 绕开名单，**绝对不要**。',
      '   ⚠️ 手册里历史段落提到的 `send-msg.ps1` / `send_text` 通道**已废弃**，冲突时以本条为准。',
      '   名单外的人会被渠道拒成 `PEER_NOT_FOUND`——那就**别发**，按手册转人工。',
    ].join('\n'),
    RULE_3.join('\n'),
  ],
  [WAKE_HEAD_V2.join('\n'), WAKE_HEAD_V3.join('\n')],
  [
    [
      '⚠️ 手册是用户手写的**历史文档**，里面新旧口径混在一起（通道那几节尤其过时）：',
      '它提供闲聊尺度、防重规则、转人工格式等口径，**与上面铁律冲突的一律以铁律为准**。',
      '',
    ].join('\n'),
    '',
  ],
  ['【铁律，高于一切，也高于下面手册里的任何历史段落】', '【铁律，高于一切】'],
]

/** 手册区（v1 起就有）的起止行：整段移出时靠这两个标记定位，不必逐字匹配手册正文。 */
const RUNBOOK_HEAD_MARK = '【用户手写的手册（全文）】'
const RUNBOOK_TAIL_MARK = '【手册结束】'

export interface RelayPromptUpgrade {
  prompt: string
  /** 做过哪些升级（给日志用：升级是**静默**的，不记一笔就没人知道到底改了没） */
  applied: string[]
}

/**
 * 把已存在的代聊 Agent 的 systemPrompt 升到当前版本。
 *
 * 四件事，都是**精确文本**操作——Agent 记录归用户所有（他可能改过口吻、加过自己的话），
 * 程序只动自己写过的那几块：
 * 1. 老段落就地改写（v1 → v2 → v3，见 `LEGACY_FRAGMENTS`）；
 * 2. 程序维护的那一段（护栏分档 + 工作流）：有起止标记就整段换，只有 v1 标记就按
 *    v1 的形状定位后换（v1 没有结束标记，靠「下一段从哪儿开始」判边界）；
 * 3. **手册区整段摘掉**（M3）：`RUNBOOK_HEAD_MARK` 到 `RUNBOOK_TAIL_MARK` 之间全删——
 *    这段是当年原样搬进来的 RUNBOOK.md 全文，现在已不参与代聊；
 * 4. 都没有（老于 v1 的记录）→ **追加**到末尾。
 *
 * 没什么可做（记录不存在 / prompt 为空 / 已经是当前版本）时返回 `null`。
 * prompt 为空是特例：那是用户把内容清空了，尊重他，不硬塞。
 */
export function relayPromptUpgrade(systemPrompt: string | undefined): RelayPromptUpgrade | null {
  const cur = systemPrompt ?? ''
  if (!cur.trim()) return null
  let next = cur
  const applied: string[] = []

  let rulesTouched = false
  for (const [from, to] of LEGACY_FRAGMENTS) {
    if (next.includes(from)) {
      next = next.replace(from, to)
      rulesTouched = true
    }
  }
  if (rulesTouched) applied.push('铁律口径')

  const owned = relayOwnedSection().trimEnd()
  const start = next.indexOf(RELAY_OWNED_START)
  const end = next.indexOf(RELAY_OWNED_END)
  if (start >= 0 && end > start) {
    const span = next.slice(start, end + RELAY_OWNED_END.length)
    if (span !== owned) {
      next = next.slice(0, start) + owned + next.slice(start + span.length)
      applied.push('程序分区')
    }
  } else {
    // v1 那段的边界：到「手册」那一节为止（v1 播种在手册之前），没有手册就是到结尾（追加式）。
    const v1 = next.indexOf(RELAY_WORKFLOW_MARKER)
    const runbookHead = v1 >= 0 ? next.indexOf(`\n\n${RUNBOOK_HEAD_MARK}`, v1) : -1
    if (v1 >= 0) {
      next = next.slice(0, v1) + owned + (runbookHead >= 0 ? next.slice(runbookHead) : '')
      applied.push('程序分区（v1 → v2）')
    } else {
      next = `${next.trimEnd()}\n\n${owned}`
      applied.push('程序分区（新增）')
    }
  }

  // 手册区整段摘掉。放在程序分区之后做，好让新版分区先就位、再删旧的（顺序无所谓，但
  // 先删的话 v1 定位那段会失去"下一段从哪儿开始"的锚点）。
  const rbHead = next.indexOf(RUNBOOK_HEAD_MARK)
  const rbTail = rbHead >= 0 ? next.indexOf(RUNBOOK_TAIL_MARK, rbHead) : -1
  if (rbHead >= 0 && rbTail > rbHead) {
    next = `${next.slice(0, rbHead).trimEnd()}\n${next.slice(rbTail + RUNBOOK_TAIL_MARK.length).replace(/^\s*\n/, '')}`
    applied.push('手册移出')
  }

  if (!applied.length) return null
  return { prompt: next, applied }
}

/**
 * 播种「灵栖代聊」（**只在不存在时**创建；已存在就原样保留用户改过的那份）。
 *
 * 不再依赖 RUNBOOK.md 是否存在：护栏现在住在 `relayOwnedSection()`（程序分区），
 * 手册只是留档——所以「文件没了就不建 Agent」这条老顾虑没有了。
 * 反过来更安全：Agent 一旦在，护栏就一定在（旧行为下文件缺失会让整条代聊失去护栏）。
 */
export function ensureWechatRelayAgent(
  deps: EnsureRelayAgentDeps,
): { created: boolean; id: string } | null {
  if (deps.getAgent(WECHAT_RELAY_AGENT_ID)) return { created: false, id: WECHAT_RELAY_AGENT_ID }
  deps.createAgent({
    id: WECHAT_RELAY_AGENT_ID,
    name: WECHAT_RELAY_AGENT_NAME,
    description:
      '本机微信代聊（盯梢回路的执行主体）：按设置页「渠道 → 本机微信」的回复名单与护栏分档代回。不用于通用对话。',
    systemPrompt: buildRelaySystemPrompt(),
    disabledPromptSections: [...RELAY_DISABLED_PROMPT_SECTIONS],
  })
  return { created: true, id: WECHAT_RELAY_AGENT_ID }
}
