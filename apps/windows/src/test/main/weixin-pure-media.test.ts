/**
 * 回归测试：微信语音消息必须派发给 Agent，不能当成「纯媒体」缓存掉。
 *
 * 起因：语音消息 iLink 已回传 voice_item.text（转录文字），但适配器只看
 * 「有没有 [media attached:] 行」就判定纯媒体，把消息缓存起来回复
 * "请发送文字说明"，Agent 永远收不到 → 用户发语音没有任何回复。
 */

import { describe, it, expect } from 'vitest'
import { isPureMediaMessage, extractMediaAttachmentLines } from '../../main/weixin-message-utils'

const VOICE_LINE = '[media attached: uploads/20260825/abc.silk]'
const FILE_LINE = '[media attached: uploads/20260825/清单.md (清单.md)]'

describe('isPureMediaMessage', () => {
  it('语音消息带转录文字 → 不是纯媒体，必须派发给 Agent', () => {
    expect(
      isPureMediaMessage({
        type: 'media',
        text: `帮我查下明天天气\n${VOICE_LINE}`,
        hasUserText: true,
      }),
    ).toBe(false)
  })

  it('纯附件、用户一个字没写 → 是纯媒体，缓存等说明', () => {
    expect(
      isPureMediaMessage({
        type: 'media',
        // 纯媒体消息的 text 会被填入 buildMediaFallbackText 占位描述，非空
        text: `用户发送了媒体消息（共 1 个）：\n1. 类型: 文件，file_key: k1\n${FILE_LINE}`,
        hasUserText: false,
      }),
    ).toBe(true)
  })

  it('图片带说明文字 → 不是纯媒体', () => {
    expect(
      isPureMediaMessage({ type: 'media', text: `这张图什么意思\n${FILE_LINE}`, hasUserText: true }),
    ).toBe(false)
  })

  it('纯文本消息 → 永远不是纯媒体', () => {
    expect(isPureMediaMessage({ type: 'text', text: '你好', hasUserText: true })).toBe(false)
  })

  it('没有附件行（下载全失败）→ 不按纯媒体缓存，避免消息丢失', () => {
    expect(
      isPureMediaMessage({ type: 'media', text: '用户发送了一条媒体消息。', hasUserText: false }),
    ).toBe(false)
  })
})

describe('extractMediaAttachmentLines', () => {
  it('只取 [media attached:] 行，忽略占位描述', () => {
    expect(
      extractMediaAttachmentLines(`用户发送了媒体消息（共 1 个）：\n1. 类型: 语音\n${VOICE_LINE}`),
    ).toEqual([VOICE_LINE])
  })
})
