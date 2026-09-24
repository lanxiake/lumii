// 03-telemetry-contract.mjs — vendor-neutral 遥测契约迷你版。
// 复刻 packages/telemetry/README.md：回调式 startSpan、无公开 end()、NOOP、
// typed schema 校验、adapter conformance suite；假想 vendor A（OTel 风格）与
// vendor B（Sentry 风格）两适配器，同一 conformance + 同一业务函数跑三家，
// 证明"换 vendor 不改业务代码"。schema 形状按 docs/telemetry-schema.md 的
// pi.ai.request 简化（起止属性分离 + 枚举值 + 基数标注）。

// ---------------- 契约（README 的 Adapter Contract 浓缩） ----------------
const STATUS = new Set(["ok", "error"]);

function makeSpan(recorder, name, parent, attributes) {
  const s = {
    name, parent, attributes: { ...attributes }, events: [], status: undefined, settled: false,
    setAttributes(a) { if (s.settled) return; for (const [k, v] of Object.entries(a)) if (v !== undefined) s.attributes[k] = v; },
    addEvent(n, a = {}) { if (!s.settled) s.events.push({ name: n, attributes: { ...a } }); },
    setStatus(st) { if (!s.settled && STATUS.has(st.status)) s.status = st; }, // last-write-wins
  };
  return s;
}

function makeContext(recorder) {
  const startSpan = async (spanOrParent, nameOrOpts, maybeCb, maybeParent) => {
    // 支持 ctx.startSpan(opts, cb) 与 span.startSpan(opts, cb) 两种
    const opts = typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts;
    const cb = maybeCb;
    const parent = typeof nameOrOpts === "string" ? maybeParent ?? spanOrParent : spanOrParent === recorder.ctx ? undefined : spanOrParent;
    const span = makeSpan(recorder, opts.name, parent?.name, opts.attributes ?? {});
    recorder.spans.push(span);
    try {
      const value = await cb(span);
      if (!span.status) span.setStatus({ status: "ok" }); // 正常完成默认 ok
      return value;
    } catch (e) {
      if (!span.status) span.setStatus({ status: "error", error: { name: e.name, message: e.message } });
      throw e; // 透传 rejection
    } finally {
      span.settled = true; // 结算后一切录制无效
    }
  };
  const ctx = { startSpan: (opts, cb) => startSpan(ctx, opts, cb) };
  recorder.ctx = ctx;
  // span 上再开子 span
  const wrap = (c) => ({ ...c });
  return ctx;
}

// （span 上开子 span 在真实契约里由 span.startSpan 完成；迷你版只做单层 + typed 层。）

// ---------------- 假 vendor A（OTel 风格）与 B（Sentry 风格） ----------------
function createVendorA() { // in-memory span tree，带 traceId
  const recorder = { spans: [], traceId: "trace-A" };
  const ctx = makeContext(recorder);
  return {
    context: ctx,
    // 归一化为 canonical RecordedTelemetrySpan
    getSpans: () => recorder.spans.map((s, i) => ({ id: i, parent: s.parent ?? null, name: s.name, attributes: s.attributes, events: s.events, status: s.status })),
  };
}
function createVendorB() { // Sentry 风格内部命名不同，但导出时翻译回 canonical
  const recorder = { spans: [], transaction: "pi" };
  const ctx = makeContext(recorder);
  return {
    context: ctx,
    getSpans: () => recorder.spans.map((s, i) => ({ id: i, parent: s.parent ?? null, name: s.name, attributes: { ...s.attributes, "_sentry.tx": recorder.transaction }, events: s.events, status: s.status })),
    // 注意：vendor 私有字段只出现在 raw 层，conformance 比较时剥掉
  };
}
const NOOP = { context: { startSpan: (o, cb) => cb({ setAttributes() {}, addEvent() {}, setStatus() {} }) }, getSpans: () => [] };

// ---------------- typed schema（telemetry-schema.md 的 pi.ai.request 简化） ----------------
const AI_REQUEST_SCHEMA = {
  name: "pi.ai.request",
  start: {
    "pi.ai.provider": { type: "string", required: true },
    "pi.ai.model": { type: "string", required: true },
    "pi.ai.streaming": { type: "boolean", required: true },
  },
  end: {
    "pi.ai.response.stop_reason": { type: "string", values: ["stop", "length", "tool_use", "error", "aborted"] },
    "pi.ai.usage.total_tokens": { type: "number" },
  },
};
function typedSpanStart(schema, ctx, startAttrs, fn) {
  for (const [k, spec] of Object.entries(schema.start)) {
    if (spec.required && !(k in startAttrs)) throw new Error(`schema: 缺必填起始属性 ${k}`);
    if (k in startAttrs && typeof startAttrs[k] !== spec.type) throw new Error(`schema: ${k} 类型应为 ${spec.type}`);
  }
  return ctx.startSpan({ name: schema.name, attributes: startAttrs }, async (span) => {
    const wrapped = { ...span, end: (endAttrs) => {
      for (const [k, spec] of Object.entries(schema.end)) {
        if (k in endAttrs) {
          if (typeof endAttrs[k] !== spec.type) throw new Error(`schema: 终止属性 ${k} 类型错`);
          if (spec.values && !spec.values.includes(endAttrs[k])) throw new Error(`schema: ${k} 非法枚举值 ${endAttrs[k]}`);
        }
      }
      span.setAttributes(endAttrs);
    } };
    return fn(wrapped);
  });
}

// ---------------- 业务代码（对 vendor 一无所知） ----------------
async function doAiRequest(telemetry, userPrompt) {
  return typedSpanStart(AI_REQUEST_SCHEMA, telemetry.context,
    { "pi.ai.provider": "faux", "pi.ai.model": "faux-1", "pi.ai.streaming": true },
    async (span) => {
      span.addEvent("retry.scheduled", { attempt: 1 });
      span.end({ "pi.ai.response.stop_reason": "stop", "pi.ai.usage.total_tokens": 42 });
      return `answer to: ${userPrompt}`;
    });
}

// ---------------- conformance suite（README 清单的可执行浓缩） ----------------
// recordsSpans=false 的适配器（如 NOOP——README 明言其 "does not inspect or retain
// names, attributes, events, or statuses"）只检查透传语义，不检查录制内容。
function conformance(name, adapter, { recordsSpans = true } = {}) {
  const fails = [];
  const assert = (cond, msg) => { if (!cond) fails.push(`${name}: ${msg}`); };
  return { run: async () => {
    const r = adapter();
    const value = await r.context.startSpan({ name: "probe" }, async (s) => {
      s.setAttributes({ a: 1 }); s.setAttributes({ a: 2, b: undefined });
      s.setStatus({ status: "ok" }); s.setStatus({ status: "error", error: { name: "X", message: "y" } });
      return "V";
    });
    assert(value === "V", "返回值必须透传");
    let threw = null;
    await r.context.startSpan({ name: "boom" }, async () => { throw new Error("boom!"); }).catch((e) => (threw = e));
    assert(threw?.message === "boom!", "rejection 原样透传");
    if (recordsSpans) {
      const [sp] = r.getSpans();
      assert(sp.attributes.a === 2, "setAttributes 后写覆盖");
      assert(!("b" in sp.attributes), "undefined 属性被忽略");
      assert(sp.status.status === "error", "setStatus last-write-wins");
      const sp2 = r.getSpans().find((s) => s.name === "boom");
      assert(sp2.status.status === "error", "抛出自动记 error");
    }
    return fails;
  } };
}

// ---------------- 演示：三家适配器跑同一业务 + 同一 conformance ----------------
console.log("=== conformance suite ===");
for (const [name, factory, opts] of [["vendor-A(OTel式)", createVendorA, {}], ["vendor-B(Sentry式)", createVendorB, {}], ["NOOP", () => NOOP, { recordsSpans: false }]]) {
  const fails = await conformance(name, factory, opts).run();
  console.log(`  ${name}: ${fails.length === 0 ? "PASS（契约语义一致）" : "FAIL " + fails.join("; ")}`);
  if (fails.length) process.exitCode = 1;
}

console.log("\n=== 同一业务函数流经三个 vendor ===");
const results = {};
const canonical = {};
for (const [name, factory] of [["vendor-A", createVendorA], ["vendor-B", createVendorB], ["NOOP", () => NOOP]]) {
  const adapter = factory();
  results[name] = await doAiRequest(adapter, "什么是复制状态");
  canonical[name] = adapter.getSpans().map(({ attributes, ...rest }) => ({
    ...rest, attributes: Object.fromEntries(Object.entries(attributes).filter(([k]) => !k.startsWith("_"))) ,
  }));
}
console.log("  业务返回值三家一致:", new Set(Object.values(results)).size === 1, JSON.stringify(results["vendor-A"]));
const strip = (o) => JSON.stringify(o.map(({ id, parent, name, events, status, attributes }) => ({ parent, name, events, status, attributes })));
console.log("  A vs B 语义字段（name/parent/attributes/events/status）一致:", strip(canonical["vendor-A"]) === strip(canonical["vendor-B"]));
const rawB = createVendorB();
await doAiRequest(rawB, "raw");
console.log("  B 的 vendor 私有能力（_sentry.tx）只存在于 raw 层:", JSON.stringify(rawB.getSpans()[0].attributes["_sentry.tx"]));

console.log("\n=== schema 守门演示（业务写错属性立刻炸）===");
try {
  await doAiRequestErr();
} catch (e) { console.log("  按预期拒绝:", e.message); }
async function doAiRequestErr() {
  return typedSpanStart(AI_REQUEST_SCHEMA, createVendorA().context,
    { "pi.ai.provider": "faux", "pi.ai.model": "faux-1", "pi.ai.streaming": "yes" }, // boolean 写错
    async () => 1);
}
