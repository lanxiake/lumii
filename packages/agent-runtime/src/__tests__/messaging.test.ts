/**
 * Messaging 模块单元测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MessageBus, type AgentBusMessage } from "../messaging/message-bus.js";
import {
  isStructuredMessage,
  normalizeMessage,
  serializeMessage,
  parseStructuredMessage,
} from "../messaging/message-types.js";

// ─── MessageBus 测试 ───

describe("MessageBus", () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  it("register/has", () => {
    expect(bus.has("agent-1")).toBe(false);
    bus.register("agent-1");
    expect(bus.has("agent-1")).toBe(true);
  });

  it("unregister", () => {
    bus.register("agent-1");
    bus.unregister("agent-1");
    expect(bus.has("agent-1")).toBe(false);
  });

  it("send/drain 基本流程", () => {
    bus.register("agent-1");
    const msg: AgentBusMessage = {
      id: "msg-1",
      from: "agent-2",
      text: "hello",
      timestamp: new Date().toISOString(),
    };
    bus.send("agent-1", msg);

    expect(bus.pendingCount("agent-1")).toBe(1);

    const messages = bus.drain("agent-1");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe("hello");

    // drain 后应清空
    expect(bus.pendingCount("agent-1")).toBe(0);
    expect(bus.drain("agent-1")).toHaveLength(0);
  });

  it("send 到未注册的 Agent 应抛错", () => {
    const msg: AgentBusMessage = {
      id: "msg-1",
      from: "agent-1",
      text: "hello",
      timestamp: new Date().toISOString(),
    };
    expect(() => bus.send("unknown-agent", msg)).toThrow("not registered");
  });

  it("广播排除发送方", () => {
    bus.register("agent-1");
    bus.register("agent-2");
    bus.register("agent-3");

    const msg: AgentBusMessage = {
      id: "msg-1",
      from: "agent-1",
      text: "broadcast",
      timestamp: new Date().toISOString(),
    };
    bus.send("*", msg);

    // agent-1 (sender) 不应收到
    expect(bus.pendingCount("agent-1")).toBe(0);
    // agent-2, agent-3 应收到
    expect(bus.pendingCount("agent-2")).toBe(1);
    expect(bus.pendingCount("agent-3")).toBe(1);
  });

  it("subscribe 收到消息通知", () => {
    bus.register("agent-1");
    const received: Array<{ agentId: string; msg: AgentBusMessage }> = [];

    bus.subscribe((agentId, message) => {
      received.push({ agentId, msg: message });
    });

    const msg: AgentBusMessage = {
      id: "msg-1",
      from: "agent-2",
      text: "event",
      timestamp: new Date().toISOString(),
    };
    bus.send("agent-1", msg);

    expect(received).toHaveLength(1);
    expect(received[0]!.agentId).toBe("agent-1");
  });

  it("destroy 清理所有状态", () => {
    bus.register("agent-1");
    bus.register("agent-2");
    bus.destroy();

    expect(bus.has("agent-1")).toBe(false);
    expect(bus.has("agent-2")).toBe(false);
  });

  it("多消息 FIFO 顺序", () => {
    bus.register("agent-1");

    for (let i = 0; i < 5; i++) {
      bus.send("agent-1", {
        id: `msg-${i}`,
        from: "agent-2",
        text: `message ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    const messages = bus.drain("agent-1");
    expect(messages).toHaveLength(5);
    expect(messages[0]!.text).toBe("message 0");
    expect(messages[4]!.text).toBe("message 4");
  });

  it("pendingCount 对未注册 Agent 返回 0", () => {
    expect(bus.pendingCount("nonexistent")).toBe(0);
  });
});

// ─── 结构化消息类型测试 ───

describe("isStructuredMessage", () => {
  it("字符串不是结构化消息", () => {
    expect(isStructuredMessage("hello")).toBe(false);
  });

  it("对象带 type 字段是结构化消息", () => {
    expect(isStructuredMessage({ type: "text", content: "hello" })).toBe(true);
  });
});

describe("normalizeMessage", () => {
  it("字符串转换为 TextMessage", () => {
    const result = normalizeMessage("hello");
    expect(result).toEqual({ type: "text", content: "hello" });
  });

  it("结构化消息直接返回", () => {
    const msg = { type: "shutdown_request" as const, requestId: "req-1" };
    expect(normalizeMessage(msg)).toBe(msg);
  });
});

describe("serializeMessage", () => {
  it("TextMessage 返回纯文本", () => {
    expect(serializeMessage({ type: "text", content: "hello" })).toBe("hello");
  });

  it("其他类型序列化为 JSON", () => {
    const result = serializeMessage({ type: "shutdown_request", requestId: "req-1" });
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe("shutdown_request");
  });
});

describe("parseStructuredMessage", () => {
  it("有效 JSON 解析为结构化消息", () => {
    const text = JSON.stringify({
      type: "task_notification",
      taskId: "t1",
      agentId: "a1",
      status: "completed",
      summary: "done",
    });
    const result = parseStructuredMessage(text);
    expect(result.type).toBe("task_notification");
  });

  it("纯文本解析为 TextMessage", () => {
    const result = parseStructuredMessage("just some text");
    expect(result).toEqual({ type: "text", content: "just some text" });
  });

  it("无效 JSON 解析为 TextMessage", () => {
    const result = parseStructuredMessage("{invalid json");
    expect(result).toEqual({ type: "text", content: "{invalid json" });
  });
});
