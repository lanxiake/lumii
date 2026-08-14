/**
 * channel 工具 stub 契约测试
 */
import { describe, expect, it } from "vitest";
import {
  CHANNEL_LIST_TOOL_NAME,
  CHANNEL_SEND_TOOL_NAME,
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

  it("channel_send 需权限且非只读", () => {
    expect(channelSendToolConfig.name).toBe(CHANNEL_SEND_TOOL_NAME);
    expect(channelSendToolConfig.isReadOnly).toBe(false);
    expect(channelSendToolConfig.needsPermission).toBe(true);
    expect(channelSendToolConfig.category).toBe("channel");
  });
});
