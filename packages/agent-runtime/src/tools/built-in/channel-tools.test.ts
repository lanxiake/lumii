/**
 * channel 工具 stub 契约测试
 */
import { describe, expect, it } from "vitest";
import {
  CHANNEL_LIST_TOOL_NAME,
  CHANNEL_SEND_TOOL_NAME,
  OUTBOUND_CHANNEL_IDS,
  OUTBOUND_CHANNEL_PROFILES,
  PCWECHAT_SELF_PEER_ID,
  channelListToolConfig,
  channelSendToolConfig,
} from "./channel-tools.js";

describe("channel-tools stub contract", () => {
  it("channel_list 为只读且不需权限", () => {
    expect(channelListToolConfig.name).toBe(CHANNEL_LIST_TOOL_NAME);
    expect(channelListToolConfig.isReadOnly).toBe(true);
    expect(channelListToolConfig.needsPermission).toBe(false);
    expect(channelListToolConfig.category).toBe("channel");
  });

  it("channel_send 的 channel 枚举与 OUTBOUND_CHANNEL_IDS 同源", () => {
    // 反例（真发生过）：主进程加了 pcwechat，schema 枚举漏改，
    // 模型一调用就在参数校验层被拒——Router 的白名单门根本没机会执行。
    const properties = channelSendToolConfig.parameters.properties as Record<
      string,
      { anyOf?: Array<{ const?: string }> }
    >;
    const enumValues = (properties.channel?.anyOf ?? []).map((l) => l.const);
    expect(enumValues).toEqual([...OUTBOUND_CHANNEL_IDS]);
  });

  it("channel_send 需权限且非只读", () => {
    expect(channelSendToolConfig.name).toBe(CHANNEL_SEND_TOOL_NAME);
    expect(channelSendToolConfig.isReadOnly).toBe(false);
    expect(channelSendToolConfig.needsPermission).toBe(true);
    expect(channelSendToolConfig.category).toBe("channel");
  });

  it("个人微信与本机微信在渠道说明与工具描述里区分清楚，并给出自推送路径", () => {
    // 反例：只给 id + pushMode 时，模型把需要主动推送的通知发到个人微信（被动窗口外必失败），
    // 或不知道本机微信可以发给文件传输助手来通知用户本人。
    for (const id of OUTBOUND_CHANNEL_IDS) {
      expect(OUTBOUND_CHANNEL_PROFILES[id].name.length).toBeGreaterThan(0);
      expect(OUTBOUND_CHANNEL_PROFILES[id].note.length).toBeGreaterThan(0);
    }
    expect(OUTBOUND_CHANNEL_PROFILES.weixin.name).toContain("个人微信");
    expect(OUTBOUND_CHANNEL_PROFILES.pcwechat.name).toContain("本机微信");
    expect(OUTBOUND_CHANNEL_PROFILES.pcwechat.note).toContain(`to="${PCWECHAT_SELF_PEER_ID}"`);
    expect(channelSendToolConfig.description).toContain("个人微信");
    expect(channelSendToolConfig.description).toContain(`to="${PCWECHAT_SELF_PEER_ID}"`);
  });
});
