/**
 * 记忆宫殿展示层中文化 —— 用户的抱怨是「列表数据看不懂」（conversations /
 * qbot:964A4769… / chronicler 全是机器标识），这里守住「不认识的都翻成人话」。
 */
import { describe, expect, it } from 'vitest'
import {
  agentLabel,
  channelFromConversationId,
  channelLabel,
  drawerSubtitle,
  drawerTitle,
  wingLabel,
} from './palace-labels'

describe('agentLabel', () => {
  it('已知定义 id 翻成中文名', () => {
    expect(agentLabel('assistant')).toBe('主助手')
    expect(agentLabel('chronicler')).toBe('灵栖记事')
    expect(agentLabel('code-dev')).toBe('开发助手')
  })

  it('未知 id 原样返回（不编造名字）', () => {
    expect(agentLabel('some-new-agent')).toBe('some-new-agent')
  })
})

describe('channelFromConversationId', () => {
  it('按前缀判渠道', () => {
    expect(channelFromConversationId('qbot:964A4769')).toBe('qbot')
    expect(channelFromConversationId('feishu:ou_ba9a')).toBe('feishu')
    expect(channelFromConversationId('weixin:o9cq801')).toBe('weixin')
    expect(channelFromConversationId('cron:seed-focus-check')).toBe('cron')
  })

  it('桌面对话没有渠道前缀时返回 null', () => {
    expect(channelFromConversationId('e6b1e8096bfcf1ee')).toBeNull()
  })
})

describe('channelLabel', () => {
  it('渠道类型翻成中文', () => {
    expect(channelLabel('qbot')).toBe('QQ')
    expect(channelLabel('feishu')).toBe('飞书')
    expect(channelLabel('cron')).toBe('定时任务')
    expect(channelLabel('local')).toBe('桌面端')
  })

  it('null / 空返回 null', () => {
    expect(channelLabel(null)).toBeNull()
    expect(channelLabel(undefined)).toBeNull()
  })
})

describe('wingLabel', () => {
  it('每轮归档的 wing 翻成「逐轮对话」', () => {
    expect(wingLabel('conversations')).toBe('逐轮对话')
  })

  it('段归档的 wing 翻成「Agent（用户）」', () => {
    expect(wingLabel('assistant:local-user')).toBe('主助手（local-user）')
    expect(wingLabel('code-dev:local-user')).toBe('开发助手（local-user）')
  })

  it('旧 Python 宫殿的下划线变形也能认（标注历史）', () => {
    expect(wingLabel('assistant_local-user')).toBe('主助手（历史）')
  })

  it('完全未知的 wing 原样返回', () => {
    expect(wingLabel('something-weird')).toBe('something-weird')
  })
})

describe('drawerTitle', () => {
  it('优先用会话标题（用户最认得的那个）', () => {
    expect(
      drawerTitle({
        conversationTitle: '帮我解读这条内容',
        room: 'qbot:964A4769',
        wing: 'conversations',
      }),
    ).toBe('帮我解读这条内容')
  })

  it('没有标题时退回「渠道 对话」而不是显示机器 id', () => {
    expect(
      drawerTitle({ room: 'qbot:964A4769', wing: 'conversations' }),
    ).toBe('QQ 对话')
  })

  it('既没标题也没渠道时退回 wing 的中文名', () => {
    expect(drawerTitle({ room: '2026-09-17', wing: 'conversations' })).toBe('逐轮对话')
  })

  it('空白标题当作没有（不能渲染出一片空）', () => {
    expect(drawerTitle({ conversationTitle: '   ', room: 'qbot:x', wing: 'conversations' })).toBe(
      'QQ 对话',
    )
  })
})

describe('drawerSubtitle', () => {
  it('拼出「渠道 · Agent · 字数」', () => {
    expect(
      drawerSubtitle({
        room: 'qbot:x',
        wing: 'conversations',
        agent_id: 'assistant',
        channelType: 'qbot',
        char_count: 328,
      }),
    ).toBe('QQ · 主助手 · 328 字')
  })

  it('检索结果没有 agent_id 时省略该段', () => {
    expect(
      drawerSubtitle({
        room: 'qbot:x',
        wing: 'conversations',
        channelType: 'qbot',
        char_count: 100,
      }),
    ).toBe('QQ · 100 字')
  })

  it('渠道未知时仍给出字数（不返回空串）', () => {
    expect(
      drawerSubtitle({ room: '2026-09-17', wing: 'conversations', char_count: 50 }),
    ).toBe('50 字')
  })
})
