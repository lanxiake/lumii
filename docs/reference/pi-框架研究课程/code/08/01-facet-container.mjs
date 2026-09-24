// 01-facet-container.mjs — 迷你 Chord：facets 声明 provides/requires，host 校验依赖图、
// 按拓扑序激活、逆依赖序释放。复刻 packages/chord/README.md 的 Plugin/Facets/Services 语义。
// （API 名为教学用简化版，非 chord 真实导出名；真实语义见 README "Plugins"/"Facets" 节。）

class FacetHost {
  constructor() { this.facets = []; this.providers = new Map(); this.activated = []; }

  // 同步装配：先收齐全部声明，再统一校验（README: "After every plugin has declared
  // its shape, a host validates the complete dependency graph"）
  add(facet) { this.facets.push(facet); return this; }

  #validate() {
    const provided = new Set();
    for (const f of this.facets) for (const s of f.provides ?? []) provided.add(s);
    const missing = [];
    for (const f of this.facets)
      for (const s of f.requires ?? [])
        if (!provided.has(s)) missing.push(`${f.name} -> ${s}`);
    if (missing.length) throw new Error(`missing services: ${missing.join(", ")}`);
    // 循环依赖检测：在 facet 图上跑 DFS（requires 的服务由谁 provide，就连一条边）
    const providerOf = new Map();
    for (const f of this.facets) for (const s of f.provides ?? []) providerOf.set(s, f.name);
    const byName = new Map(this.facets.map((f) => [f.name, f]));
    const state = new Map(); // 0=visiting 1=done
    const visit = (n, path) => {
      if (state.get(n) === 1) return;
      if (state.get(n) === 0) throw new Error(`cycle: ${[...path, n].join(" -> ")}`);
      state.set(n, 0);
      for (const s of byName.get(n).requires ?? []) {
        const p = providerOf.get(s);
        if (p && p !== n) visit(p, [...path, n]);
      }
      state.set(n, 1);
    };
    for (const f of this.facets) visit(f.name, []);
  }

  // 拓扑序激活：provider 先于 consumer（README: "activates providers before consumers"）
  async start() {
    this.#validate();
    const providerOf = new Map();
    for (const f of this.facets) for (const s of f.provides ?? []) providerOf.set(s, f.name);
    const done = new Set();
    const byName = new Map(this.facets.map((f) => [f.name, f]));
    const startOne = async (f) => {
      if (done.has(f.name)) return;
      for (const s of f.requires ?? []) {
        const p = providerOf.get(s);
        if (p && p !== f.name) await startOne(byName.get(p));
      }
      const instance = await (f.setup ? f.setup(this) : {});
      for (const s of f.provides ?? []) this.providers.set(s, instance ?? {});
      done.add(f.name);
      this.activated.push(f.name);
      console.log(`  [activate] ${f.name}  provides=[${(f.provides ?? []).join(",")}]`);
    };
    for (const f of this.facets) await startOne(f);
  }

  service(name) { return this.providers.get(name); }

  // 逆激活序释放（README: "disposes resources in reverse dependency order"）
  async stop() {
    for (const name of [...this.activated].reverse()) {
      const f = this.facets.find((x) => x.name === name);
      await (f.dispose ?? (() => {}))();
      console.log(`  [dispose] ${name}`);
    }
  }
}

// —— 演示 1：agent-worker facet 与 ui facet 共享 state-service ——
console.log("=== 装配：worker + ui 共享 state-service ===");
const host = new FacetHost();
host.add({
  name: "state-service", provides: ["state"],
  async setup() { const v = { transcript: [] }; return { append: (m) => v.transcript.push(m), all: () => v.transcript }; },
  async dispose() { console.log("    state-service: 存储已关闭"); },
});
host.add({
  name: "agent-worker", requires: ["state"], provides: ["agent"],
  async setup(h) {
    const state = h.service("state");
    state.append("hello from worker");
    console.log("    agent-worker: harness 不跨进程边界，只写 state");
    return { prompt: (m) => { state.append(m); return `echo: ${m}`; } };
  },
  async dispose() { console.log("    agent-worker: drive 已停止"); },
});
host.add({
  name: "ui", requires: ["state", "agent"],
  async setup(h) { console.log(`    ui: 渲染 ${h.service("state").all().length} 条 transcript，prompt=`, h.service("agent").prompt("hi")); },
  async dispose() { console.log("    ui: 渲染器已卸载"); },
});
await host.start();
console.log("  激活序:", host.activated.join(" -> "));
console.log("  state 内容:", JSON.stringify(host.service("state").all()));
await host.stop();

// —— 演示 2：缺服务被 host 拒绝 ——
console.log("\n=== 装配：ui 需要不存在的 service ===");
try {
  const bad = new FacetHost();
  bad.add({ name: "lonely-ui", requires: ["nonexistent"] });
  await bad.start();
} catch (e) { console.log("  按预期拒绝:", e.message); }

// —— 演示 3：循环依赖被检测 ——
console.log("\n=== 装配：a<->b 循环依赖 ===");
try {
  const cyc = new FacetHost();
  cyc.add({ name: "a", provides: ["A"], requires: ["B"] });
  cyc.add({ name: "b", provides: ["B"], requires: ["A"] });
  await cyc.start();
} catch (e) { console.log("  按预期拒绝:", e.message); }
