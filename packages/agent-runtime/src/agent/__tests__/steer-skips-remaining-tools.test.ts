import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai/compat";
import { AgentInstance } from "../agent-instance.js";

/**
 * 插话打断工具批：升级到 pi 0.87.1 后的语义守护。
 *
 * 旧版（0.50.x）executeToolCalls 严格顺序执行，每个工具跑完后轮询 steering，
 * 有插话就给同批剩余工具发 "Skipped due to queued user message." 并跳出。
 * 新版把轮询挪到整批之后、且默认并发（`toolExecution` 默认 "parallel"），于是
 * 「跑到一半插话」会失效。本仓用 `beforeToolCall` + `toolExecution: "sequential"`
 * 把它找回来（见 agent-instance.ts 的 STEER_SKIP_REMAINING_TOOLS_REASON）。
 *
 * ⚠️ 与旧版**不完全等价**：插话落在「模型流式期间」（批未开始）时本实现整批拦下，
 * 而旧版仍会跑完第一个工具。这是刻意保留的（见本文件最后一条用例），不是回归。
 *
 * 这几条用例锁的是**行为**而不是实现：它们会真的跑 pi 的 agent loop。
 */

const TOOL_RESULT = { content: [{ type: "text" as const, text: "ok" }], details: undefined };

/** 造一个「记录自己被调用过」的工具 */
function makeTool(
  name: string,
  calls: string[],
  onExecute?: () => void | Promise<void>,
): AgentTool {
  return {
    name,
    label: name,
    description: `test tool ${name}`,
    parameters: Type.Object({}),
    execute: async () => {
      calls.push(name);
      await onExecute?.();
      return TOOL_RESULT;
    },
  } as AgentTool;
}

/** 造一条只含指定 toolCall 的 assistant 消息 */
function assistantWithToolCalls(...names: string[]): AssistantMessage {
  return {
    role: "assistant",
    content: names.map(
      (name, i) => ({ type: "toolCall", id: `${name}-${i}`, name, arguments: {} }) as ToolCall,
    ),
    api: "openai-completions",
    provider: "openai",
    model: "fake-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

/** 纯文本收尾消息（没有工具调用 → 回合结束） */
function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "fake-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * 假 streamFn：按请求次序逐条吐出预置消息。
 *
 * 只实现 loop 真正用到的两个口子——`Symbol.asyncIterator`（吐一个 done，
 * 让 loop 走到 `case "done"` 去取 result）与 `result()`。
 *
 * `onRequest` 用于**在"模型生成期间"投递插话**：此刻 prepareRequest 已经跑完、
 * 工具批还没开始，正是「插话落在流式期间」那个时机（见本文件最后一条用例）。
 */
function scriptedStreamFn(script: AssistantMessage[], onRequest?: (index: number) => void): StreamFn {
  let i = 0;
  return (() => {
    const index = i;
    const message = script[Math.min(i, script.length - 1)]!;
    i += 1;
    onRequest?.(index);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done" } as never;
      },
      async result() {
        return message;
      },
    };
  }) as unknown as StreamFn;
}

function makeInstance(
  tools: AgentTool[],
  script: AssistantMessage[],
  agentOptions?: Record<string, unknown>,
  onRequest?: (index: number) => void,
) {
  return new AgentInstance({
    id: "steer-test",
    definition: {
      id: "steer-test-def",
      name: "steer-test",
      description: "test agent",
      systemPrompt: "You are a test agent.",
      modelTier: "basic",
      permissionMode: "default",
      // 关掉记忆与自愈的额外请求，保证脚本里的请求次序就是工具批的次序
      memory: { scope: "none", autoExtract: false },
    },
    streamFn: scriptedStreamFn(script, onRequest),
    model: { id: "fake-model", provider: "openai" } as never,
    tools,
    agentOptions,
  } as never);
}

describe("插话打断工具批（pi 0.87.1 语义回归）", () => {
  it("工具执行中插话 → 同批剩余工具不再执行", async () => {
    const calls: string[] = [];
    const instance = makeInstance(
      [makeTool("toolA", calls, () => instance.steer("停，别继续了")), makeTool("toolB", calls)],
      [assistantWithToolCalls("toolA", "toolB"), assistantText("好")],
    );

    await instance.prompt("跑两个工具");

    expect(calls).toEqual(["toolA"]);
  });

  it("对照：不插话则两个工具都执行（否则上一条可能只是工具本身没跑）", async () => {
    const calls: string[] = [];
    const instance = makeInstance(
      [makeTool("toolA", calls), makeTool("toolB", calls)],
      [assistantWithToolCalls("toolA", "toolB"), assistantText("好")],
    );

    await instance.prompt("跑两个工具");

    expect(calls).toEqual(["toolA", "toolB"]);
  });

  it("followUp 不算插话 → 两个工具都执行（防退回 peekQueuedMessages）", async () => {
    // 这条守的是实现选择：框架的 agent.peekQueuedMessages() 在 steering 为空时
    // 会回退到 followUp 队列，而本仓的 token-budget nudge 正走 followUp。
    // 若有人把 beforeToolCall 换成 peekQueuedMessages()，这条会红。
    const calls: string[] = [];
    const instance = makeInstance(
      [makeTool("toolA", calls, () => void instance.followUp("继续干活")), makeTool("toolB", calls)],
      [assistantWithToolCalls("toolA", "toolB"), assistantText("好")],
    );

    await instance.prompt("跑两个工具");

    expect(calls).toEqual(["toolA", "toolB"]);
  });

  it("插话被注入后计数归零 → 之后的新工具批照常执行，不被上一次插话迁怒", async () => {
    const calls: string[] = [];
    let steered = false;
    const instance = makeInstance(
      [
        makeTool("toolA", calls, () => {
          if (!steered) {
            steered = true;
            instance.steer("先停一下");
          }
        }),
        makeTool("toolB", calls),
        makeTool("toolC", calls),
        makeTool("toolD", calls),
      ],
      [
        assistantWithToolCalls("toolA", "toolB"),
        // 插话注入后模型重新决策，这一批是全新的一批
        assistantWithToolCalls("toolC", "toolD"),
        assistantText("好"),
      ],
    );

    await instance.prompt("跑起来");

    // toolB 被插话跳过；toolC/toolD 属于插话之后的新批次，必须正常跑。
    // 若 prepareRequest 没有归零计数，toolC/toolD 会被一并拦掉。
    expect(calls).toEqual(["toolA", "toolC", "toolD"]);
  });

  it("插话落在「模型流式期间」（工具批尚未开始）→ 整批拦下，一个工具都不跑", async () => {
    // ⚠️ 这条锁的是**刻意**保留的、与旧版**不同**的行为，不要当成 bug 改掉。
    //
    // 旧版每跑完一个工具才轮询 steering，所以此时（批还没开始）它仍会执行第一个工具；
    // 本实现只要批开始前有待注入插话就整批拦下。理由是「立刻结束」要真的立刻——
    // 批内第一个工具若是 spawn_agent 这类要跑几分钟的，旧版会白等它跑完。
    // 代价：轻量插话（"顺便也看下 X"）会作废整批计划、多一次模型往返。
    // 2026-09-23 用户实测到该差异后确认保留。
    const calls: string[] = [];
    let steeredDuringStreaming = false;
    const instance = makeInstance(
      [makeTool("toolA", calls), makeTool("toolB", calls)],
      [assistantWithToolCalls("toolA", "toolB"), assistantText("好")],
      undefined,
      (requestIndex) => {
        // 只在第一次"生成"期间插话：此时 prepareRequest 已跑完，工具批还没开始
        if (requestIndex === 0 && !steeredDuringStreaming) {
          steeredDuringStreaming = true;
          instance.steer("停！立刻结束");
        }
      },
    );

    await instance.prompt("跑两个工具");

    expect(steeredDuringStreaming).toBe(true);
    expect(calls).toEqual([]);
  });
});
