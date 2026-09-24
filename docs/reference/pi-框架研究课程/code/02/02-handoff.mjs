// 02-handoff.mjs
// 模拟 pi-ai 的跨 provider context handoff（规则来源：packages/ai/README.md
// "Cross-Provider Handoffs" 与 packages/ai/src/api/transform-messages.ts）。
// provider A：thinking 放独立字段、带签名 blob（类 Anthropic signature / OpenAI
// reasoning.encrypted）；provider B：只认文本，thinking 需降级为文本、签名不可重放。
// 演示：转换前后 JSON 对比 + 签名 blob 丢弃/保留的后果。
// 运行：node 02-handoff.mjs（零依赖，无需 API key）

// ---- provider A 的原始回合（AssistantMessage，纯 JSON，可直接序列化）----
const assistantFromA = {
  role: "assistant",
  provider: "providerA", api: "providerA-messages", model: "a-opus",
  content: [
    {
      type: "thinking",
      thinking: "用户要 25*18。拆成 25*20-25*2=450。",
      thinkingSignature: "A_SIG_encrypted_reasoning_v2__opaque__", // 只有 A 能解密的推理重放数据
    },
    {
      type: "text",
      text: "25 × 18 = 450。",
    },
    {
      type: "toolCall",
      id: "resp_item_00|fc_9f3a....(OpenAI Responses 风格 450+ 字符含 '|')....b71e",
      name: "verify",
      arguments: { expr: "25*18", expected: 450 },
      // Google 系对应字段是 thoughtSignature；OpenAI Responses 文本块是 textSignature
    },
  ],
  usage: { input: 9, output: 31, cacheRead: 0, cacheWrite: 0, totalTokens: 40 },
  stopReason: "toolUse",
  timestamp: Date.now(),
};

const toolResult = {
  role: "toolResult", toolCallId: assistantFromA.content[2].id, toolName: "verify",
  content: [{ type: "text", text: "OK: 450" }], isError: false, timestamp: Date.now(),
};

// ---- 最小 handoff 转换器（对齐 transform-messages.ts 的规则）----
function transformMessagesForTarget(messages, target) {
  const idMap = new Map();
  const dropped = [];
  const out = messages.map((msg) => {
    if (msg.role === "user") return msg; // 规则1: user 原样

    if (msg.role === "toolResult") { // toolResult 原样，但 id 若被归一化要同步改写
      const nid = idMap.get(msg.toolCallId);
      return nid ? { ...msg, toolCallId: nid } : msg;
    }

    if (msg.role === "assistant") {
      const isSameModel = msg.provider === target.provider && msg.api === target.api && msg.model === target.model;
      const content = msg.content.flatMap((block) => {
        if (block.type === "thinking") {
          if (block.redacted) { // 加密的审查内容：跨模型只能丢弃，重放给别家必炸
            if (!isSameModel) dropped.push("redacted thinking (encrypted payload)");
            return isSameModel ? [block] : [];
          }
          if (isSameModel && block.thinkingSignature) { // 同家：签名是续命符，保留
            return [block];
          }
          if (!block.thinking) return [];
          if (isSameModel) return [block];
          dropped.push(`thinking -> text（B 只认文本，思考过程以文本形式留在上下文中）`);
          if (block.thinkingSignature) dropped.push("thinkingSignature（仅 A 可解，不可重放给 B，随降级一并丢弃）");
          const text = target.requiresThinkingAsText
            ? `<thinking>\n${block.thinking}\n</thinking>`   // OpenAI 兼容路径: compat.requiresThinkingAsText
            : block.thinking;                                 // transform-messages.ts 的裸降级
          return [{ type: "text", text }];
        }
        if (block.type === "toolCall") {
          // OpenAI Responses 的 id 含 '|' 且超长；Anthropic 要求 ^[a-zA-Z0-9_-]+$ ≤64
          if (!target.toolCallIdOk(block.id)) {
            const nid = "tc_" + block.id.length.toString(16) + "_" + Math.abs(hash(block.id)).toString(16).slice(0, 8);
            idMap.set(block.id, nid);
            dropped.push(`toolCall id 归一化 -> ${nid}`);
            return [{ ...block, id: nid }];
          }
          return [block];
        }
        return [block]; // text 等原样
      }).map((b) => {
        // 跨家时删除一切签名 blob：A 的密文喂给 B = 轻则 400 重则串计费/审计
        if (!isSameModel && b.thinkingSignature) { dropped.push("thinkingSignature（仅 A 可解，不可重放给 B）"); const { thinkingSignature, ...rest } = b; return rest; }
        if (!isSameModel && b.thoughtSignature) { dropped.push("thoughtSignature"); const { thoughtSignature, ...rest } = b; return rest; }
        return b;
      });
      return { ...msg, content };
    }
    return msg;
  });
  return { messages: out, dropped };
}

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

// ---- 场景 1：喂给只认文本的 provider B（跨家）----
const targetB = { provider: "providerB", api: "openai-completions", model: "b-gpt", requiresThinkingAsText: true, toolCallIdOk: (id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id) };
const context = { messages: [assistantFromA, toolResult, { role: "user", content: "刚才对了吗？", timestamp: Date.now() }] };

console.log("=== 转换前（provider A 原始上下文，节选 content）===");
console.log(JSON.stringify(context.messages[0].content, null, 2));

const handed = transformMessagesForTarget(context.messages, targetB);
console.log("\n=== 转换后（可安全喂给 provider B）===");
console.log(JSON.stringify(handed.messages[0].content, null, 2));
console.log("\ntoolCall 对应的 toolResult.toolCallId 已同步改写:", handed.messages[1].toolCallId);
console.log("\n丢弃/改写清单:");
for (const d of handed.dropped) console.log("  -", d);

// ---- 场景 2：同 provider 续聊（对照组：签名必须保留）----
const targetA2 = { provider: "providerA", api: "providerA-messages", model: "a-opus", requiresThinkingAsText: false, toolCallIdOk: () => true };
const same = transformMessagesForTarget(context.messages, targetA2);
console.log("\n=== 对照：同 provider 重放（签名保留，thinking 原样，丢弃清单为空）===");
console.log("thinking block:", JSON.stringify(same.messages[0].content[0]));
console.log("丢弃清单:", same.dropped.length === 0 ? "[]" : same.dropped.join("; "));

// ---- 后果演示：若把 A 的签名硬塞给 B ----
console.log("\n=== 若违规重放（把 A_SIG 原样发给 B）===");
console.log('providerB POST /v1/chat/completions -> 400 {"error":"unknown field \'thinkingSignature\' / cannot decrypt reasoning item"}');
console.log("结论：签名 blob 是『发给原主的回执』，不是上下文内容；handoff 时删除是唯一正确动作（transform-messages.ts isSameModel 分支）。");
