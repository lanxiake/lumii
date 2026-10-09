/**
 * 「灵栖代聊」的播种规格（M2 身份归位 2026-10-08 / M3 手册移出 2026-10-09）。
 *
 * 三件事错一件都会静默出事：
 *   1. 护栏**没进** systemPrompt → 代聊在没有护栏的情况下替用户说话；
 *   2. 播种**覆盖**了已有的 Agent → 用户在设置页改的护栏被启动覆盖；
 *   3. 提示词里留下**悬空引用**（指向已经不在场的「手册 / state.json / transcript」）
 *      → 模型照着找一个不存在的文件，或者把废弃通道当当前口径用。
 */
import { describe, it, expect, vi } from 'vitest'
import { PROMPT_SECTIONS } from '@mtbot/agent-runtime'
import {
  buildRelaySystemPrompt,
  ensureWechatRelayAgent,
  RELAY_DISABLED_PROMPT_SECTIONS,
  RELAY_OWNED_END,
  RELAY_OWNED_START,
  RELAY_WORKFLOW_MARKER,
  relayOwnedSection,
  relayPromptUpgrade,
  relayRecordKnobs,
  WECHAT_RELAY_AGENT_ID,
  WECHAT_RELAY_AGENT_NAME,
} from './wechat-relay-agent'
import type { AgentRecord } from '../agents-repo'

const RUNBOOK = '【护栏】涉钱 / 冲突 / 身份质疑一律不发，转人工（飞书）'

describe('buildRelaySystemPrompt', () => {
  it('身份 + 铁律 + 程序分区；通道写死成 channel_send', () => {
    const p = buildRelaySystemPrompt()
    expect(p).toContain(WECHAT_RELAY_AGENT_NAME)
    expect(p).toContain(RELAY_OWNED_START)
    expect(p).toContain('channel_send')
    expect(p).toContain('channel="pcwechat"')
    // 转人工口子（飞书 open_id 属于用户，抄错就转不出去）
    expect(p).toContain('ou_ba9a79349951e82ceac99a505f3e2739')
    // 身份不披露 = 这条循环存在的底线
    expect(p).toContain('绝不透露 AI 身份')
  })

  it('M3：手册**整段移出**——提示词里不再出现「手册」这个指代物', () => {
    // 2026-10-09：RUNBOOK 全文 5.5k 字里九成是失效的操作史（cron / state.json / NO_REPLY /
    // send-msg.ps1 / 剪贴板 / 前台焦点 / 296×388 窗口 / 锁屏禁令），其中七处自称"优先级最高"
    // 互相打架。真有用的（闲聊尺度 / 防重 / 转人工格式）程序分区里已经写全。
    const p = buildRelaySystemPrompt()
    expect(p).not.toContain('手册')
    expect(p).not.toContain('【用户手写的手册')
    expect(p).not.toContain(RUNBOOK)
  })

  it('M3：不留悬空引用（state.json / transcript / 废弃的 ps1 通道）', () => {
    const p = buildRelaySystemPrompt()
    for (const dead of ['state.json', 'transcript', 'send-msg.ps1', 'pending.txt', 'NO_REPLY']) {
      expect(p, `提示词里不该再提「${dead}」——它已不在场`).not.toContain(dead)
    }
  })
})

describe('护栏分档与程序分区', () => {
  it('三档都在，且"沉默"只留给硬停档（这是 2026-10-09 改口径的全部意义）', () => {
    const s = relayOwnedSection()
    for (const w of ['硬停', '软回', '放行']) expect(s).toContain(w)
    // 硬停只留钱与安全
    expect(s).toContain('借钱 / 转账 / 收款码 / 投资荐股')
    expect(s).toContain('索要验证码')
    // 身份试探走软回（反问带过），不是沉默
    expect(s).toContain('试探身份')
    expect(s).toContain('不承认、不解释、不否认')
    // 帮好友查只读资料放行
    expect(s).toContain('帮对方查只读资料')
    // 有代价的事任何档都不做
    expect(s).toContain('代付、代下单、代报名')
  })

  it('工作流：画像四栏 + scope 语义 + 覆盖写提醒 + 别当话题说出来', () => {
    const s = relayOwnedSection()
    expect(s).toContain('wechat_digest')
    expect(s).toContain('wechat_profile_save')
    expect(s).toContain('wechat_distill_state')
    expect(s).toContain('别在回话里提画像')
    // 四栏规格（用户 2026-10-09：「用户画像也不清不楚」）
    for (const col of ['身份与关系', '常聊话题', '怎么跟他说话', '雷区']) expect(s).toContain(col)
    // 本人那份要用 scope="self" 写（写用"留空"、读用 self 是当年 self 画像读不回来的来路）
    expect(s).toContain('scope="self"')
    // 覆盖写：不读回就更新会丢条目
    expect(s).toContain('整份覆盖写')
    // 元评论禁令（不写"本机有三个同名会话""回复是代聊发的"这种给操作者看的旁白）
    expect(s).toContain('不写元评论')
  })

  it('铁律第 2 条指向分档，不再写"一条都不发"', () => {
    const p = buildRelaySystemPrompt()
    expect(p).toContain('按下面【Lumii 预设的护栏分档】处置')
    expect(p).not.toContain('2. **命中护栏 → 一条都不发**')
    expect(p).not.toContain('一条都不回，转人工')
  })
})

describe('relayPromptUpgrade（老 Agent 的原地升级）', () => {
  /** v1 的原样输出（当年 buildRelaySystemPrompt + 追加分区 的结果），逐字照抄 */
  const V1_PREFIX = [
    `你是「${WECHAT_RELAY_AGENT_NAME}」：**用户本人的微信代聊分身**。你替他在本机微信上`,
    '看消息、回日常闲聊。口吻就是他本人。',
    '',
    '【铁律，高于一切，也高于下面手册里的任何历史段落】',
    '1. **绝不透露 AI 身份**，全程以用户本人的身份说话。对方问「你是本人吗 / 是不是 AI」',
    '   → 一条都不回，转人工（飞书，见第 4 条）。',
    '2. **命中护栏 → 一条都不发**，转人工：涉钱（借钱/转账/投资/买卖）、冲突·情感纠纷·健康危机、',
    '   要承诺或替用户做实质安排（工作/约见）、身份质疑。**生活安排/邀约类一律不得自动发出。**',
    '3. **发送只能走 `channel_send`**。',
    '5. **拿不准就取保守侧**：不回 + 转人工。宁可让对方多等，也不要替他做错承诺。',
    '',
  ].join('\n')
  const V1_TAIL = [
    '',
    '<!-- lumii:relay-workflow v1 -->',
    '【Lumii 预设的工作流（这段由程序维护，别删）】',
    '3. 蒸馏是**本机只读统计**，产物在 `~/.lumii/wechat-distill/`。',
    '',
  ].join('\n')

  /**
   * v2 的**头几段**（逐字照抄当年代码的输出）。M2 那版把手册搬进了提示词，于是留下了
   * 指向手册的悬空引用——这正是 v2 → v3 要清掉的东西。
   */
  const V2_HEAD = [
    '【铁律，高于一切，也高于下面手册里的任何历史段落】',
    '3. **发送只能走 `channel_send`**（channel="pcwechat", to=<这一轮对手方的 talker>, text=…）。',
    '   这是唯一允许的路径：渠道层会照「本机微信回复名单」再挡一道，并留下发送记录。',
    '   拿 MCP 的发送工具（或任何脚本）自己发 = 绕开名单，**绝对不要**。',
    '   ⚠️ 手册里历史段落提到的 `send-msg.ps1` / `send_text` 通道**已废弃**，冲突时以本条为准。',
    '   名单外的人会被渠道拒成 `PEER_NOT_FOUND`——那就**别发**，按手册转人工。',
    '',
    '【怎么被叫醒】盯梢回路（每 15 秒一拍，零 token 读库）只在**真的来了新消息**时才驱动你一轮，',
    '并把「本次触发」的消息、对手方与档位放在提示词里。水位由回路推进——',
    '**不用再轮询、也不要读 state.json**；要发之前先 `read_history(limit=3)` 确认末条是对方发的',
    '（防重，见手册）。',
    '',
    '⚠️ 手册是用户手写的**历史文档**，里面新旧口径混在一起（通道那几节尤其过时）：',
    '它提供闲聊尺度、防重规则、转人工格式等口径，**与上面铁律冲突的一律以铁律为准**。',
    '',
  ].join('\n')

  it('v1 记录（分区追加在末尾）：换成新分区 + 改写铁律，别处一字不动', () => {
    const userLine = '【用户自己写的口吻】只说"嗯"。'
    const up = relayPromptUpgrade(`${V1_PREFIX}${userLine}\n${V1_TAIL}`)
    expect(up).not.toBeNull()
    expect(up!.prompt).toContain(userLine)            // 用户的内容原样
    expect(up!.prompt).toContain(RELAY_OWNED_START)   // 新分区到位
    expect(up!.prompt).not.toContain(RELAY_WORKFLOW_MARKER) // 旧分区没留残渣
    expect(up!.prompt).not.toContain('一条都不回，转人工')
    expect(up!.applied).toContain('铁律口径')
    expect(up!.applied).toContain('程序分区（v1 → v2）')
  })

  it('v2 记录：手册区**整段摘掉**，头部的悬空引用一并改掉', () => {
    const src = `${V2_HEAD}${V1_TAIL}\n【用户手写的手册（全文）】\n${RUNBOOK}\n【手册结束】\n`
    const up = relayPromptUpgrade(src)!
    expect(up.applied).toContain('手册移出')
    expect(up.applied).toContain('铁律口径')
    // 手册区没了（正文与两个标记都不在）
    expect(up.prompt).not.toContain(RUNBOOK)
    expect(up.prompt).not.toContain('【用户手写的手册')
    expect(up.prompt).not.toContain('【手册结束】')
    // 悬空引用清掉了
    expect(up.prompt).not.toContain('send-msg.ps1')
    expect(up.prompt).not.toContain('state.json')
    expect(up.prompt).not.toContain('手册')
    // 但同一条铁律的实质内容还在（不能把整条删了）
    expect(up.prompt).toContain('channel_send')
    expect(up.prompt).toContain('PEER_NOT_FOUND')
    expect(up.prompt).toContain('也不要去查水位')
  })

  it('用户改过铁律 → 对不上就跳过，绝不覆盖他的手笔', () => {
    const edited = '2. **命中护栏 → 一条都不发**（我自己改过这条，别动）。'
    const up = relayPromptUpgrade(`${edited}\n${V1_TAIL}`)
    expect(up!.prompt).toContain(edited)
    expect(up!.applied).not.toContain('铁律口径')
    expect(up!.prompt).toContain(RELAY_OWNED_START) // 分区照升
  })

  it('比 v1 还老（没有分区）→ 追加到末尾', () => {
    const up = relayPromptUpgrade('【我自己的代聊提示词】随便聊。')
    expect(up!.prompt.startsWith('【我自己的代聊提示词】')).toBe(true)
    expect(up!.prompt).toContain(RELAY_OWNED_START)
    expect(up!.applied).toEqual(['程序分区（新增）'])
  })

  it('已经是当前版本 → null（否则每启动一次长一截 / 白写一次库）', () => {
    expect(relayPromptUpgrade(buildRelaySystemPrompt())).toBeNull()
    expect(relayPromptUpgrade(relayPromptUpgrade(`${V1_PREFIX}${V1_TAIL}`)!.prompt)).toBeNull()
  })

  it('prompt 为空/未定义 → 不动：内容被清空是用户的决定，不硬塞', () => {
    expect(relayPromptUpgrade('')).toBeNull()
    expect(relayPromptUpgrade('   \n ')).toBeNull()
    expect(relayPromptUpgrade(undefined)).toBeNull()
  })
})

describe('ensureWechatRelayAgent', () => {
  const existing = (over: Partial<AgentRecord> = {}): AgentRecord =>
    ({
      id: WECHAT_RELAY_AGENT_ID,
      name: WECHAT_RELAY_AGENT_NAME,
      systemPrompt: '用户自己改过的那份',
      isEnabled: true,
      userId: 'local-user',
      createdAt: 'x',
      updatedAt: 'x',
      ...over,
    }) as AgentRecord

  it('不存在 → 建一条，护栏（程序分区）就在 systemPrompt 里，段落收敛一并落盘', () => {
    const createAgent = vi.fn(
      (d: { id: string; name: string; systemPrompt?: string; disabledPromptSections?: string[] }) =>
        existing(d),
    )
    const res = ensureWechatRelayAgent({ getAgent: () => undefined, createAgent })
    expect(res).toEqual({ created: true, id: WECHAT_RELAY_AGENT_ID })
    expect(createAgent).toHaveBeenCalledTimes(1)
    const data = createAgent.mock.calls[0]![0]
    expect(data.id).toBe(WECHAT_RELAY_AGENT_ID)
    expect(data.systemPrompt).toContain('硬停')
    expect(data.systemPrompt).toContain('软回')
    // 播种时就带上，否则第一次启动后要等下一轮 sync 才收敛
    expect(data.disabledPromptSections).toEqual([...RELAY_DISABLED_PROMPT_SECTIONS])
  })

  it('已存在 → 一个字都不写（设置页里那份才是真源）', () => {
    const createAgent = vi.fn()
    const res = ensureWechatRelayAgent({ getAgent: () => existing(), createAgent })
    expect(res).toEqual({ created: false, id: WECHAT_RELAY_AGENT_ID })
    expect(createAgent).not.toHaveBeenCalled()
  })

  it('M3：不再依赖 RUNBOOK.md 是否存在——护栏住在程序分区里，跟文件无关', () => {
    // 旧行为：文件读不到就不建 Agent，随后回落路径"每轮注入手册"也注不出东西，
    // 结果是整条代聊**没有护栏**（比没有更危险）。现在播种只看"在不在"。
    const createAgent = vi.fn(() => existing())
    const res = ensureWechatRelayAgent({ getAgent: () => undefined, createAgent })
    expect(res).toEqual({ created: true, id: WECHAT_RELAY_AGENT_ID })
    expect(createAgent).toHaveBeenCalledTimes(1)
  })
})

describe('relayOwnedSection（程序分区的边界）', () => {
  it('起止标记成对，且整段可被精确定位（升级时整段替换）', () => {
    const s = relayOwnedSection()
    expect(s.includes(RELAY_OWNED_START)).toBe(true)
    expect(s.includes(RELAY_OWNED_END)).toBe(true)
    expect(s.indexOf(RELAY_OWNED_START)).toBeLessThan(s.indexOf(RELAY_OWNED_END))
  })
})

describe('RELAY_DISABLED_PROMPT_SECTIONS（M4 段落收敛）', () => {
  it('每个 ID 都在 PROMPT_SECTIONS 里真实存在（写错的 id 会静默不生效）', () => {
    // 段 ID 一经发布不可改名（prompt-sections.ts 的文件头），而这份清单住在另一个包里——
    // 没有这条对账，改名的后果是"收敛悄悄少生效一段"，谁也发现不了。
    const known = new Set(PROMPT_SECTIONS.map((s) => s.id))
    for (const id of RELAY_DISABLED_PROMPT_SECTIONS) {
      expect(known.has(id), `PROMPT_SECTIONS 里没有「${id}」`).toBe(true)
    }
    expect(new Set(RELAY_DISABLED_PROMPT_SECTIONS).size).toBe(RELAY_DISABLED_PROMPT_SECTIONS.length)
  })

  it('护栏相关的段一个都没被关掉', () => {
    // 收敛的对象是"做任务的通用契约"，不是行为红线——关错一个就是代聊少一层约束。
    for (const keep of ['identity', 'systemRules', 'safety', 'verification', 'language', 'messaging']) {
      expect(RELAY_DISABLED_PROMPT_SECTIONS as readonly string[]).not.toContain(keep)
    }
  })
})

describe('relayRecordKnobs（老记录补旋钮）', () => {
  it('缺字段 / 与目标不一致 → 给出目标值；一致 → null（不白写一次库）', () => {
    expect(relayRecordKnobs({})?.disabledPromptSections).toEqual([...RELAY_DISABLED_PROMPT_SECTIONS])
    expect(relayRecordKnobs({ disabledPromptSections: ['taskCompletion'] })).not.toBeNull()
    expect(
      relayRecordKnobs({ disabledPromptSections: [...RELAY_DISABLED_PROMPT_SECTIONS] }),
    ).toBeNull()
  })
})
