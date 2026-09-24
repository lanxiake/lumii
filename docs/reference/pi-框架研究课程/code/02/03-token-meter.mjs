// 03-token-meter.mjs
// 复现博客（mariozechner.at/posts/2025-11-30-pi-coding-agent/ L83）的 token 统计困境：
// "Some report token counts at the start of the SSE stream, others only at the end,
//  making accurate cost tracking impossible if a request is aborted ... you can't
//  provide a unique ID to later correlate with their billing APIs."
// 两个假 provider：headProvider 在流首报 usage（Anthropic message_start 式，
//   见 packages/ai/src/api/anthropic-messages.ts L615-625，message_delta 还会二次修正）；
// tailProvider 只在流尾报 usage（OpenAI stream_options.include_usage 的最终 chunk /
//   Google usageMetadata 式，见 openai-completions.ts L829、google-generative-ai.ts L231）。
// 中途 abort 对比两者“可计费性”。
// 运行：node 03-token-meter.mjs（零依赖，无需 API key）

const TOKENS_PER_DELTA = { input: 100, outputPerDelta: 8 };

function mkUsage(input, output) {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { input: input * 3e-6, output: output * 15e-6, cacheRead: 0, cacheWrite: 0,
      total: input * 3e-6 + output * 15e-6 } };
}

// 统一事件流上的“计量器”：pi-ai 消费事件时顺手把 usage 抄进 partial（各家抄法不同）
function makeMeter() {
  let usage = null;      // 计量器视角的“已知用量”
  let finalized = false; // 只有流正常收尾才等于“可结算”
  return {
    observe(ev) {
      if (ev.usage) { usage = ev.usage; finalized = ev.type === "done"; }
      if (ev.type === "done") finalized = true;
      if (ev.type === "error") finalized = false; // 与 provider 上报时机无关：失败即不可结算
    },
    snapshot: () => usage,
    settleable: () => finalized,
  };
}

// headProvider：流首事件即报 input（output 先报 0，尾部才修正为精确值）
async function* headProvider(stopAfter) {
  yield { type: "start", usage: mkUsage(TOKENS_PER_DELTA.input, 0) }; // message_start 式
  let n = 0;
  for (let i = 0; i < 6; i++) {
    if (++n > stopAfter) { yield { type: "error", reason: "aborted", errorMessage: "aborted mid-stream" }; return; }
    yield { type: "text_delta", delta: `段${i} ` };
  }
  yield { type: "done", reason: "stop", usage: mkUsage(TOKENS_PER_DELTA.input, n * TOKENS_PER_DELTA.outputPerDelta) }; // message_delta 修正
}

// tailProvider：全程静默，最后一个事件才报全部 usage
async function* tailProvider(stopAfter) {
  yield { type: "start" };
  let n = 0;
  for (let i = 0; i < 6; i++) {
    if (++n > stopAfter) { yield { type: "error", reason: "aborted", errorMessage: "aborted mid-stream" }; return; }
    yield { type: "text_delta", delta: `段${i} ` };
  }
  yield { type: "done", reason: "stop", usage: mkUsage(TOKENS_PER_DELTA.input, n * TOKENS_PER_DELTA.outputPerDelta) };
}

async function run(name, gen, abort) {
  const meter = makeMeter();
  let deltas = 0;
  for await (const ev of gen(abort ? 3 : Infinity)) {
    meter.observe(ev);
    if (ev.type === "text_delta") deltas++;
  }
  const u = meter.snapshot();
  return {
    场景: name,
    实际消耗: `${TOKENS_PER_DELTA.input} in + ${deltas * TOKENS_PER_DELTA.outputPerDelta} out（模型真的算了）`,
    计量器已知: u ? `${u.input} in + ${u.output} out` : "（一无所知）",
    可结算: meter.settleable() && u ? `是 $${u.cost.total.toFixed(5)}` : "否",
    偏差: u && (u.input !== TOKENS_PER_DELTA.input || u.output !== deltas * TOKENS_PER_DELTA.outputPerDelta)
      ? `少计 output：${deltas * TOKENS_PER_DELTA.outputPerDelta - u.output} tokens（流首值未修正）`
      : "无",
  };
}

const rows = [
  await run("head 报首 + 正常完成", headProvider, false),
  await run("tail 报尾 + 正常完成", tailProvider, false),
  await run("head 报首 + 第 3 delta 后 abort", headProvider, true),
  await run("tail 报尾 + 第 3 delta 后 abort", tailProvider, true),
];

console.log("=== token 上报时机 × abort：可计费性对照 ===\n");
for (const r of rows) {
  console.log(`- ${r.场景}`);
  for (const [k, v] of Object.entries(r)) if (k !== "场景") console.log(`    ${k}: ${v}`);
  console.log();
}

console.log("=== 结论（对应博客 L83 / pi-ai 的 best-effort 立场）===");
console.log("1) 同一次 abort，head 式至少知道输入成本，tail 式颗粒无收——而 GPU 周期已经消耗。");
console.log("2) 就算 head 式，流首报的 output 是估值，abort 后没有修正机会 → 只能『约等于』。");
console.log("3) 没有可注入的自有 request id 去对账账单 API，误差无法事后弥合。");
console.log("   pi-ai 因此把 Usage 定义为 best-effort：个人用量够了，做面向用户的精确计费不行。");
