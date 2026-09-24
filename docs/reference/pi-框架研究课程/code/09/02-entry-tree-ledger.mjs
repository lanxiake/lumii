// 02-entry-tree-ledger.mjs — harness.md 四部分状态的迷你实现：
// 不可变 entry 树（write-once + parentId）/ bound typed values / Branch tip / usage ledger。
// 对照 harness.md §0.2、§1.3、§1.6、§2.3、§9.1 不变量 1/2/4/9。

class Durable {
  constructor() {
    this.entries = new Map();       // id -> entry（write-once）
    this.values = new Map();        // "kind:ns/key" -> { type, value }
    this.ledger = [];               // append-only UsageRow
    this.stats = { input: 0, output: 0, messageCount: 0 }; // 维护式投影
    this.seq = 0;
  }
  // 原子事务（§3.4）：全部先算好，任何一项非法 = 整笔作废
  tx(writes) {
    const adding = new Set(); // 本事务内将存在的 entry id（先写者可作后写者之父）
    const staged = writes.map((w) => {
      if (w.kind === "entry") {
        if (this.entries.has(w.id) || adding.has(w.id)) throw new Error(`corruption: entry id 复用 ${w.id}`);
        if (w.parentId !== null && !this.entries.has(w.parentId) && !adding.has(w.parentId)) throw new Error(`corruption: 缺失父 ${w.parentId}`);
        adding.add(w.id);
        return w;
      }
      if (w.kind === "set") {
        const addr = `value:${w.ns}/${w.key}`;
        const old = this.values.get(addr);
        if (old && old.type !== w.type) throw new Error(`corruption: ${addr} 类型不符（${old.type} vs ${w.type}）`);
        return w;
      }
      if (w.kind === "usage") {
        if (this.entries.has(w.usageId) || this.ledger.some((r) => r.usageId === w.usageId)) throw new Error("corruption: usage id 复用");
        return w;
      }
      throw new Error("unknown write");
    });
    for (const w of staged) {
      this.seq++;
      if (w.kind === "entry") { this.entries.set(w.id, { id: w.id, parentId: w.parentId, ...w.payload }); if (w.payload.type === "message") this.stats.messageCount++; }
      if (w.kind === "set") this.values.set(`value:${w.ns}/${w.key}`, { type: w.type, value: w.value });
      if (w.kind === "usage") { this.ledger.push({ usageId: w.usageId, entryId: w.entryId, input: w.input, output: w.output }); this.stats.input += w.input; this.stats.output += w.output; }
    }
  }
  setTip(branch, entryId) { this.tx([{ kind: "set", ns: "pi.branch.tip", key: branch, type: "entryId", value: entryId }]); }
  getTip(branch) { return this.values.get(`value:pi.branch.tip/${branch}`)?.value ?? null; }
  chain(tipId) { const out = []; for (let id = tipId; id !== null; id = this.entries.get(id).parentId) out.push(this.entries.get(id)); return out.reverse(); }
}

const d = new Durable();
// 共享历史：频道里的旧消息
d.tx([
  { kind: "entry", id: "e1", parentId: null, payload: { type: "message", text: "用户: 这个仓库的迁移文件好乱" } },
  { kind: "entry", id: "e2", parentId: "e1", payload: { type: "message", text: "助手: 确实，过期的有 5 个" } },
]);
d.setTip("alpha", "e2");
d.setTip("beta", "e2"); // 两个分支从同一 entry 分叉：共享前缀，什么都不复制（不变量 6）

// alpha：走"删除+测试"的路
d.tx([
  { kind: "entry", id: "a1", parentId: "e2", payload: { type: "message", text: "助手(alpha): 我来删过期迁移" } },
  { kind: "usage", usageId: "u-a1", entryId: "a1", input: 1200, output: 90 },
]);
d.setTip("alpha", "a1");
// beta：走"只做报告"的路
d.tx([
  { kind: "entry", id: "b1", parentId: "e2", payload: { type: "message", text: "助手(beta): 我先列清单" } },
  { kind: "usage", usageId: "u-b1", entryId: "b1", input: 800, output: 60 },
]);
d.setTip("beta", "b1");

// 分叉后各自记账，聚合互不污染（各自 parent 链上的 entry ∈ 该分支历史）
const sum = (tip) => { const ids = new Set(d.chain(tip).map((e) => e.id)); return d.ledger.filter((r) => ids.has(r.entryId)).reduce((a, r) => ({ input: a.input + r.input, output: a.output + r.output }), { input: 0, output: 0 }); };
console.log("=== 分支树 ===");
console.log("e1 ── e2 ─┬─ a1   (alpha tip =", d.getTip("alpha"), ")");
console.log("          └─ b1   (beta  tip =", d.getTip("beta"), ")");
console.log("alpha 聚合:", JSON.stringify(sum("a1")), " beta 聚合:", JSON.stringify(sum("b1")));

// getStats 投影 == 账本求和（§1.6：conformance 断言的等式）
const ledgerSum = d.ledger.reduce((a, r) => ({ input: a.input + r.input, output: a.output + r.output }), { input: 0, output: 0 });
console.log("stats 投影 == ledger 求和:", d.stats.input === ledgerSum.input && d.stats.output === ledgerSum.output, JSON.stringify(d.stats));

// 守护演示：三类 corruption 都被原子事务拒收
console.log("\n=== corruption 拒收（整笔作废）===");
for (const bad of [
  [{ kind: "entry", id: "a1", parentId: "e2", payload: { type: "message", text: "id 复用" } }],
  [{ kind: "entry", id: "x9", parentId: "ghost", payload: { type: "message", text: "缺父" } }],
  [{ kind: "set", ns: "pi.branch.tip", key: "alpha", type: "number", value: 7 }], // 与 entryId 地址类型冲突
]) {
  const before = d.seq;
  try { d.tx(bad); console.log("  未拦截 ✗"); } catch (e) { console.log(`  拒收: ${e.message}（seq 未动: ${d.seq === before}）`); }
}

// 不变量 8 检查：删光"操作自有值"后仍是一棵完整树 + 账本
d.tx([{ kind: "set", ns: "pi.op.state", key: "op-1", type: "json", value: { phase: "running" } }]);
d.values.delete("value:pi.op.state/op-1"); // 终态事务删操作自有值
const treeOk = [...d.entries.values()].every((e) => e.parentId === null || d.entries.has(e.parentId));
console.log("\n删光操作自有值后：树完整 =", treeOk, "，账本行数 =", d.ledger.length, "（永不删除）");
