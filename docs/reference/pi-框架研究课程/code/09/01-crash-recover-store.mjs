// 01-crash-recover-store.mjs — intent/effect/settlement 三段记账 + 孤儿恢复的迷你复刻。
// 语义对照 packages/agent/docs/harness.md §0.3 规则 4、§0.5 crash-mid-tool、§4.5 孤儿表。
// oplog.jsonl 是"磁盘"：两趟 runner 只通过读这个文件重建认知（模拟进程重启）。
// 副作用账本 side_effects.log 用来证明：replay:"never" 的效果绝不重跑。

import { appendFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";

const DIR = new URL("./01-run/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const OPLOG = DIR + "oplog.jsonl";
const SIDE = DIR + "side_effects.log";

// —— "磁盘"清理，保证可重复运行 ——
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

let seq = 0;
function nextSeq() {
  if (existsSync(OPLOG)) {
    const max = Math.max(0, ...readFileSync(OPLOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).seq));
    if (max > seq) seq = max;
  }
  return ++seq;
}
const log = (rec) => appendFileSync(OPLOG, JSON.stringify({ seq: nextSeq(), ...rec }) + "\n");
const readLog = () => (existsSync(OPLOG) ? readFileSync(OPLOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const doEffect = (opId, line) => appendFileSync(SIDE, `${opId}: ${line}\n`); // 不可重放的"副作用"

// —— 工作负载：4 个操作，后两个要留给"重启后" ——
const OPS = [
  { id: "op-1", name: "写报告头", replay: "safe", effect: () => doEffect("op-1", "report header written") },
  { id: "op-2", name: "发送 HTTP", replay: "never", effect: () => doEffect("op-2", "HTTP POST sent") },
  { id: "op-3", name: "删除过期迁移", replay: "never", effect: (cp) => { cp("已删 3/5 个文件"); doEffect("op-3", "rm executed"); throw new Error("☠ OOM killer：效果已发生，settlement 未落盘"); } },
  { id: "op-4", name: "跑测试（只读）", replay: "safe", effect: () => doEffect("op-4", "tests executed") },
];

function runOp(op) {
  log({ type: "intent", opId: op.id, replay: op.replay });                 // 预记账：正要做 X
  const checkpoint = (content) => log({ type: "checkpoint", opId: op.id, content }); // 有界进度，可替换
  try {
    op.effect(checkpoint);
  } catch (e) {
    throw Object.assign(e, { opId: op.id });                               // 崩溃：intent 在盘上，settle 不在
  }
  log({ type: "settled", opId: op.id });
  console.log(`  [run] ${op.id} ${op.name} → settled`);
}

// —— 从盘上重建认知：每个 op 的持久状态 ——
function project() {
  const st = new Map();
  for (const r of readLog()) {
    const s = st.get(r.opId) ?? { intent: false, settled: false, replay: null, checkpoints: [] };
    if (r.type === "intent") { s.intent = true; s.replay = r.replay; }
    if (r.type === "checkpoint") s.checkpoints.push(r.content);
    if (r.type === "settled") s.settled = true;
    st.set(r.opId, s);
  }
  return st;
}

const sideLines = () => (existsSync(SIDE) ? readFileSync(SIDE, "utf8").trim().split("\n") : []);

// ══ 第一趟：跑到 op-3 中途崩溃 ══
console.log("══ pass 1（崩溃前）══");
try {
  for (const op of OPS.slice(0, 3)) runOp(op);
} catch (e) {
  console.log(`  ${e.message}`);
}
const before = sideLines();
console.log(`  副作用账本现有 ${before.length} 行:`, JSON.stringify(before));

// ══ 第二趟：进程"重启"，只读 oplog 判定 ══
console.log("\n══ pass 2（重启后，仅凭 oplog 判定）══");
const state = project();
for (const op of OPS) {
  const s = state.get(op.id);
  if (!s || !s.intent) continue;               // 从未受理：跳过（op-4 走正常新执行路径）
  if (s.settled) { console.log(`  [skip] ${op.id} 已 settled，不重放`); continue; }
  // 孤儿：intent 在、settle 不在（§4.5 tool 行）
  if (s.replay === "never") {
    const cp = s.checkpoints.at(-1) ?? "(无已提交 checkpoint)";
    log({ type: "settled", opId: op.id, synthetic: `interrupted: 最新已提交进度=${cp}；更新的输出可能缺失，外部结果未知` });
    console.log(`  [orphan] ${op.id} replay=never → 绝不重执行；合成 interrupted（保留进度 "${cp}" + 警告）`);
  } else {
    console.log(`  [orphan] ${op.id} replay=safe → 用持久化参数重新执行`);
    runOp(op);
  }
}
for (const op of OPS.filter((o) => !(state.get(o.id)?.intent))) runOp(op); // 未开始的操作续跑

// ══ 验收：副作用账本与操作账本 ══
const after = sideLines();
console.log("\n══ 账本核对 ══");
for (const id of ["op-1", "op-2", "op-3", "op-4"]) {
  console.log(`  ${id} 副作用行数（崩溃后→重启后）: ${before.filter((l) => l.startsWith(id + ":")).length} → ${after.filter((l) => l.startsWith(id + ":")).length}`);
}
console.log(`  never 类操作零重复执行: ${after.filter((l) => l.startsWith("op-3:")).length === 1}`);
console.log("\n  oplog 全文：");
for (const r of readLog()) console.log("   ", JSON.stringify(r));
rmSync(DIR, { recursive: true, force: true });
