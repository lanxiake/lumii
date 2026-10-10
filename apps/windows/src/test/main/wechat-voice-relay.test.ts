/**
 * @vitest-environment node
 *
 * 回归测试：微信入站**语音**必须能被转成文字，且用户翻会话记录时**看得见**。
 *
 * 背景（2026-10-10 实测定型）：微信语音的音频**不在磁盘上**——全盘搜 `.silk/.amr` 为空。
 * 它在 `db_storage/message/media_*.db` 的 `VoiceInfo.voice_data` 里（明文 SILK_V3，
 * 头 `\x02#!SILK_V3`）。所以链路是：
 *
 *   MCP 从 VoiceInfo 取 SILK → 落成文件、消息上给 `voice_path`
 *   → 客户端 `transcribeVoiceFile`（silk-wasm 解码 → 本地 Paraformer ASR）→ 文字
 *   → 挂到消息的 `voice_text` 上 → **提示词与落库的会话历史都从它取**
 *
 * 这里钉三件事：
 * 1. MCP 导出的 SILK 文件**确实能被客户端的 silk-wasm 解码**（跨进程的接缝，坏了不报错、
 *    只会静默没有转写）；
 * 2. 提示词在拿到转写时会把它摆出来，拿不到时**不留噪声**；
 * 3. **落库的会话历史带上转写**——用户点进来要能看见对方说了什么，
 *    而不是只看到一句 `[语音 1.9 秒]`（这正是补这条测试的起因）。
 *
 * 数据相关的那条在本机没有导出文件时自动跳过（跟 wechat-mcp 其它实机测试一个口径）。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildAutoPrompt,
  buildDraftPrompt,
  formatIncomingForHistory,
} from '../../main/agent-runtime/wechat-watch-tick'

/** MCP 侧的导出目录（`wechat_core.WORK` = %TEMP%/lumii-wechat-mcp） */
const VOICE_DIR = path.join(os.tmpdir(), 'lumii-wechat-mcp', 'voice')

function exportedSilkFiles(): string[] {
  try {
    return fs
      .readdirSync(VOICE_DIR)
      .filter((f) => f.endsWith('.silk'))
      .map((f) => path.join(VOICE_DIR, f))
  } catch {
    return []
  }
}

describe('微信语音 → 转写 → 提示词 / 会话历史', () => {
  it('MCP 导出的 SILK 能被客户端 silk-wasm 解码', async () => {
    const files = exportedSilkFiles()
    if (files.length === 0) {
      // 没跑过 read_history/poll_new 就没有导出物；不是失败
      console.log('[skip] 本机还没有导出过语音文件')
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { decode } = require('silk-wasm')
    let checked = 0
    for (const f of files.slice(0, 5)) {
      const buf = fs.readFileSync(f)
      // 导出物必须是 SILK_V3（0x02 开头 + "#!SILK_V3"），不是裸 PCM 或别的
      expect(buf.subarray(0, 10)).toEqual(Buffer.from('\x02#!SILK_V3', 'latin1'))
      // silk-wasm 的 Emscripten 绑定只收 Uint8Array；直接喂 Node Buffer 会抛
      // 「Cannot pass non-string to std::string」（实测踩过）
      const r = await decode(new Uint8Array(buf), 16000)
      const seconds = r.data.byteLength / 2 / 16000
      // 一条语音总得有点长度，且不至于离谱（WeChat 语音上限 60 秒）
      expect(seconds).toBeGreaterThan(0.2)
      expect(seconds).toBeLessThan(120)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('拿到转写 → 提示词里摆出文字，并禁止模型去猜', () => {
    const msg = {
      ts: 1_791_442_261,
      talker: 'wxid_x',
      name: '张三',
      text: '[语音 15.2 秒]',
      voice_text: '明天下午三点开会',
    }
    const p = buildAutoPrompt([msg], '', undefined)
    expect(p).toContain('明天下午三点开会')
    expect(p).toContain('语音')
    // 必须说清「以转写为准」，否则模型看着「[语音 15.2 秒]」会去编内容
    expect(p).toMatch(/别去猜|以它为准/)
  })

  it('落库的会话历史也带转写（用户翻记录要看得见对方说了什么）', () => {
    const base = { ts: 1, talker: 'wxid_x', name: '张三', text: '[语音 1.9 秒]' }
    // 有转写 → 历史里看得见内容
    expect(formatIncomingForHistory({ ...base, voice_text: '可以听到我说话吗' })).toBe(
      '[语音 1.9 秒]（转写：可以听到我说话吗）',
    )
    // 群里还要带上说话人
    expect(
      formatIncomingForHistory({
        ...base,
        talker: '123@chatroom',
        sender: '张三',
        voice_text: '可以听到我说话吗',
      }),
    ).toBe('张三：[语音 1.9 秒]（转写：可以听到我说话吗）')
    // 没转写 → 原样落库，别加空壳
    expect(formatIncomingForHistory(base)).toBe('[语音 1.9 秒]')
    expect(formatIncomingForHistory({ ...base, voice_text: '   ' })).toBe('[语音 1.9 秒]')
  })

  it('没拿到转写 → 一个字都不加（绝不写「转写失败」这种噪声）', () => {
    const msg = { ts: 1_791_442_261, talker: 'wxid_x', name: '张三', text: '[语音 15.2 秒]' }
    for (const empty of ['', '   ', undefined]) {
      const auto = buildAutoPrompt([{ ...msg, voice_text: empty }], '', undefined)
      const draft = buildDraftPrompt([{ ...msg, voice_text: empty }], '', undefined)
      expect(auto).not.toMatch(/本地转写|转写失败/)
      expect(draft).not.toMatch(/本地转写|转写失败/)
      // 元数据本身还在——它说了「这是条语音、多长」
      expect(auto).toContain('[语音 15.2 秒]')
    }
  })
})
