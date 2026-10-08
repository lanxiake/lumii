/**
 * channel 工具 stub 契约测试
 */
import { describe, expect, it } from "vitest";
import {
  CHANNEL_LIST_TOOL_NAME,
  CHANNEL_SEND_TOOL_NAME,
  OUTBOUND_CHANNEL_IDS,
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
});
