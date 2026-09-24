// 01-faux-stream.mjs
// 复刻 pi-ai 统一事件流的协议形状（事件名/字段名对齐 packages/ai/src/types.ts 的
// AssistantMessageEvent 与 utils/event-stream.ts 的 EventStream）。
// 一个"假 provider"按协议异步产出事件，两个互不相识的消费者（终端渲染器 / JSONL
// 记录器）消费同一条流，演示统一事件流如何把 UI 与 provider 解耦。
// 运行：node 01-faux-stream.mjs（零依赖，无需 API key）

// ---- EventStream 迷你复刻：AsyncIterable + push/end/result() ----
class EventStream {
  constructor() {
    this.incoming = [];        // 已 push 未被消费的事件
    this.waiting = [];         // 等事件的消费者
    this.done = false;
    this._result = null;
    this._resolveResult = null;
    this.resultPromise = new Promise((r) => { this._resolveResult = r; });
  }
  push(event) {
    if (this.done) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.incoming.push(event);
  }
  end(result) {
    this.done = true;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: undefined, done: true });
    if (result !== undefined) this._resolveResult(result);
  }
  result() { return this.resultPromise; }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.incoming.length > 0) { yield this.incoming.shift(); continue; }
      if (this.done) return;
      const r = await new Promise((res) => this.waiting.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

const microtask = () => new Promise((r) => setTimeout(r, 0)); // faux 的“每 chunk 一个微任务”近似

// ---- 假 provider：按 pi-ai 事件协议形状产出一个 thinking + text + toolCall 的回合 ----
function fauxStream({ abortAfterDeltas = Infinity } = {}) {
  const s = new EventStream();
  // partial 是“活对象”：provider 原地改写它（types.ts 契约：不是事件时刻快照）
  const partial = {
    role: "assistant", provider: "faux", api: "faux", model: "faux-1",
    content: [], usage: null, stopReason: "pending", timestamp: Date.now(),
  };
  (async () => {
    s.push({ type: "start", partial });
    let deltas = 0;

    // thinking 块
    partial.content.push({ type: "thinking", thinking: "" });
    const ti = partial.content.length - 1;
    s.push({ type: "thinking_start", contentIndex: ti, partial });
    for (const d of ["用户要时间。", "先调 get_time。"]) {
      partial.content[ti].thinking += d;
      s.push({ type: "thinking_delta", contentIndex: ti, delta: d, partial });
    }
    s.push({ type: "thinking_end", contentIndex: ti, content: partial.content[ti].thinking, partial });

    // text 块
    partial.content.push({ type: "text", text: "" });
    const xi = partial.content.length - 1;
    s.push({ type: "text_start", contentIndex: xi, partial });
    for (const d of ["正在", "查询", "时间…"]) {
      if (++deltas > abortAfterDeltas) { // 模拟中途 abort：error 事件带部分内容的 error message
        partial.stopReason = "aborted";
        const err = { ...partial, errorMessage: "Request was aborted" };
        s.push({ type: "error", reason: "aborted", error: err });
        s.end(err);
        return;
      }
      partial.content[xi].text += d;
      s.push({ type: "text_delta", contentIndex: xi, delta: d, partial });
      await microtask();
    }
    s.push({ type: "text_end", contentIndex: xi, content: partial.content[xi].text, partial });

    // toolCall 块：arguments 增量解析（toolcall_delta 的 delta 是 JSON 片段）
    partial.content.push({ type: "toolCall", id: "tc_1", name: "get_time", arguments: {} });
    const ci = partial.content.length - 1;
    s.push({ type: "toolcall_start", contentIndex: ci, partial });
    for (const frag of ['{"', 'timezone', '":', '"UTC"', '}']) {
      try { partial.content[ci].arguments = JSON.parse(partial.content[ci]._raw = (partial.content[ci]._raw || "") + frag); } catch { /* 尽力而为：参数可能残缺 */ }
      s.push({ type: "toolcall_delta", contentIndex: ci, delta: frag, partial });
    }
    delete partial.content[ci]._raw;
    s.push({ type: "toolcall_end", contentIndex: ci, toolCall: partial.content[ci], partial });

    partial.stopReason = "toolUse";
    partial.usage = { input: 12, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 21, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    s.push({ type: "done", reason: "toolUse", message: partial });
    s.end(partial);
  })();
  return s;
}

// ---- 消费者 1：终端渲染器（只认事件协议，不知道 provider 是谁）----
async function terminalRenderer(stream) {
  console.log("== 终端渲染器 ==");
  for await (const ev of stream) {
    switch (ev.type) {
      case "start": process.stdout.write(`[stream: ${ev.partial.provider}/${ev.partial.model}]\n`); break;
      case "thinking_start": process.stdout.write("[thinking] "); break;
      case "thinking_delta": process.stdout.write(ev.delta); break;
      case "thinking_end": process.stdout.write("\n"); break;
      case "text_start": process.stdout.write("[text] "); break;
      case "text_delta": process.stdout.write(ev.delta); break;
      case "text_end": process.stdout.write("\n"); break;
      case "toolcall_end": console.log(`[toolcall] ${ev.toolCall.name}(${JSON.stringify(ev.toolCall.arguments)})`); break;
      case "done": console.log(`[done] reason=${ev.reason} usage=${ev.message.usage.totalTokens} tokens`); break;
      case "error": console.log(`[error] reason=${ev.reason}: ${ev.error.errorMessage}`); break;
    }
  }
}

// ---- 消费者 2：JSONL 记录器（同一协议，完全不同的用途：持久化审计）----
async function jsonlRecorder(stream) {
  const lines = [];
  for await (const ev of stream) {
    if (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta") {
      lines.push(JSON.stringify({ ev: ev.type, i: ev.contentIndex, delta: ev.delta }));
    } else if (ev.type === "done" || ev.type === "error") {
      lines.push(JSON.stringify({ ev: ev.type, reason: ev.reason }));
    }
  }
  console.log("== JSONL 记录器（同一条流的另一路消费，用于会话持久化）==");
  for (const l of lines) console.log(l);
}

// ---- 主流程 ----
const mode = process.argv[2] === "abort" ? "abort" : "full";
if (mode === "abort") {
  console.log("### 中途 abort 演示（第 2 个 text_delta 后取消）\n");
  const s = fauxStream({ abortAfterDeltas: 2 });
  await terminalRenderer(s);
  const r = await s.result(); // 关键：abort 后 result() 仍返回部分结果
  console.log(`\nresult() 保留部分产出: stopReason=${r.stopReason}`);
  console.log("保留的 content:", JSON.stringify(r.content.map((b) => ({ type: b.type, text: b.thinking ?? b.text ?? undefined }))));
} else {
  // 同一事件源，tee 后广播给两个互不相识的消费者 => 事件流解耦 UI 与 provider
  // （EventStream 单消费者，故主循环只做转发，消费者各自面对独立镜像流）
  const src = fauxStream();
  const a = new EventStream();
  const b = new EventStream();
  (async () => {
    for await (const ev of src) { a.push(ev); b.push(ev); }
    const final = await src.result();
    a.end(final); b.end(final);
  })();
  await Promise.all([terminalRenderer(a), jsonlRecorder(b)]);
  const final = await src.result();
  console.log(`\n主循环最终 result(): stopReason=${final.stopReason}, content blocks=${final.content.map((b) => b.type).join(",")}`);
}
