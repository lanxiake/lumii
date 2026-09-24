// 01-session-tree.mjs — pi 风格会话 JSONL 的树解析 / 活跃路径 / 上下文窗口模拟
// 用法：node 01-session-tree.mjs [某个.jsonl]   （不带参数时用内置样例）
// 对应文章：§2.3 树与叶子、§3 三步流水线（buildContextEntries / context_edit 投影）

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// 内置样例：一条主线 + e9 处分叉；compaction 书签 + 活跃分支上的 context_edit
// ---------------------------------------------------------------------------
const SAMPLE = [
  { type: "session", version: 3, id: "sess0001", timestamp: "2026-09-23T10:00:00.000Z", cwd: "/home/dev/demo" },
  { type: "message", id: "e1", parentId: null, timestamp: 1, message: { role: "user", content: "重构 auth 模块" } },
  { type: "message", id: "e2", parentId: "e1", timestamp: 2, message: { role: "assistant", content: "[toolCall read src/auth.ts]" } },
  { type: "message", id: "e3", parentId: "e2", timestamp: 3, message: { role: "toolResult", toolName: "read", content: "…4132 字符的源码…" } },
  { type: "model_change", id: "e3b", parentId: "e3", timestamp: 4, model: "claude-sonnet-4-5" },
  { type: "message", id: "e4", parentId: "e3b", timestamp: 5, message: { role: "assistant", content: "方案：拆成 login/session/token 三块" } },
  { type: "message", id: "e5", parentId: "e4", timestamp: 6, message: { role: "user", content: "开工" } },
  { type: "message", id: "e6", parentId: "e5", timestamp: 7, message: { role: "assistant", content: "[toolCall edit src/auth.ts]" } },
  { type: "message", id: "e7", parentId: "e6", timestamp: 8, message: { role: "toolResult", toolName: "edit", content: "edit ok, 3 hunks applied" } },
  { type: "message", id: "e8", parentId: "e7", timestamp: 9, message: { role: "assistant", content: "auth.ts 第一段拆完" } },
  { type: "label", id: "e8b", parentId: "e8", timestamp: 10, label: "milestone: 拆分完成" },
  { type: "compaction", id: "c1", parentId: "e8b", timestamp: 11, firstKeptEntryId: "e5", tokensBefore: 4123,
    summary: "## Goal\n重构 auth。\n## Progress\ne5-e8 完成第一段拆分。\n## Files\nRead: src/auth.ts\nModified: src/auth.ts" },
  { type: "message", id: "e9", parentId: "c1", timestamp: 12, message: { role: "user", content: "继续第二段" } },
  { type: "message", id: "e10", parentId: "e9", timestamp: 13, message: { role: "assistant", content: "第二段完成 ✅" } },
  // —— 分叉 A（已离开，未压缩覆盖）：e9 的另一个孩子 ——
  { type: "message", id: "a1", parentId: "e9", timestamp: 14, message: { role: "user", content: "算了，先试 OAuth" } },
  { type: "message", id: "a2", parentId: "a1", timestamp: 15, message: { role: "assistant", content: "[toolCall read src/oauth.ts]" } },
  // —— 分叉 B（活跃分支，文件最后一行 = 叶子）——
  { type: "message", id: "b1", parentId: "e10", timestamp: 16, message: { role: "user", content: "补测试" } },
  { type: "message", id: "b2", parentId: "b1", timestamp: 17, message: { role: "assistant", content: "[toolCall write tests/auth.test.ts]" } },
  { type: "context_edit", id: "ce1", parentId: "b2", timestamp: 18, targetId: "e7", content: "[edit 细节已确认，长结果省略]" },
  { type: "message", id: "b3", parentId: "ce1", timestamp: 19, message: { role: "assistant", content: "测试 12 passed ✅（叶子）" } },
];

const lines = process.argv[2]
  ? readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : SAMPLE;

const header = lines[0];
const entries = lines.slice(1);
console.log(`header: v${header.version} id=${header.id} cwd=${header.cwd ?? "?"}`);
console.log(`entry 总数: ${entries.length}   类型分布:`,
  Object.entries(entries.reduce((m, e) => (m[e.type] = (m[e.type] ?? 0) + 1, m), {})).map(([k, v]) => `${k}×${v}`).join("  "));

// --- 建树 + 叶子回溯（对应 buildSessionPath） --------------------------------
const byId = new Map(entries.map((e) => [e.id, e]));
const childCount = new Map();
for (const e of entries) if (e.parentId) childCount.set(e.parentId, (childCount.get(e.parentId) ?? 0) + 1);
const leaf = entries[entries.length - 1]; // 追加式写入：最后一条即当前叶子
const path = [];
for (let cur = leaf; cur; cur = cur.parentId ? byId.get(cur.parentId) : null) path.unshift(cur);
const pathSet = new Set(path.map((e) => e.id));

// --- ASCII 渲染：从根 DFS，活跃路径用 ●，分支用 ○ ---------------------------
const kids = (id) => entries.filter((e) => e.parentId === id);
console.log("\n会话树（● = 活跃路径，○ = 其他分支）：");
(function walk(id, depth, active) {
  const e = byId.get(id);
  const brief = e.message ? `${e.message.role}: ${String(e.message.content).slice(0, 28)}`
    : e.type === "compaction" ? `compaction → keep ${e.firstKeptEntryId}`
    : e.type === "context_edit" ? `context_edit → ${e.targetId}`
    : e.type === "label" ? `label "${e.label}"` : e.type;
  console.log("  ".repeat(depth) + (active ? "● " : "○ ") + `${e.id} [${e.type}] ${brief}`);
  for (const k of kids(id)) walk(k.id, depth + 1, pathSet.has(k.id));
})((path[0] ?? leaf).id, 0, true);

// --- buildContextEntries 等价实现：最新 compaction 切窗口 --------------------
const compIdx = path.map((e, i) => [e, i]).filter(([e]) => e.type === "compaction").pop();
let window = path;
if (compIdx) {
  const [comp, ci] = compIdx;
  window = [comp];
  let kept = false;
  for (let i = 0; i < ci; i++) {
    if (path[i].id === comp.firstKeptEntryId) kept = true;
    if (kept && !(path[i].type === "message" && path[i].message?.role === "system")) window.push(path[i]);
  }
  window.push(...path.slice(ci + 1));
  const dropped = path.filter((e) => !window.includes(e));
  console.log(`\n压缩窗口（最新 compaction=${comp.id}, firstKeptEntryId=${comp.firstKeptEntryId}, tokensBefore=${comp.tokensBefore}）`);
  console.log(`  活跃路径 ${path.length} 条 → 进上下文 ${window.length} 条；被裁掉 ${dropped.length} 条: ${dropped.map((e) => e.id).join(",")}`);
  console.log("  注意：被裁掉的 entry 在文件里一行未少（append-only），label/model_change 也不投影。");
}

// --- context_edit 投影：后写覆盖先写 ----------------------------------------
const edits = new Map();
for (const e of window) if (e.type === "context_edit") edits.set(e.targetId, e);
console.log(`\n投影后的模型消息序列（${window.length - window.filter((e) => !["message", "compaction", "context_edit", "custom_message", "branch_summary"].includes(e.type)).length} 条参与）：`);
for (let i = 0; i < window.length; i++) {
  const e = window[i];
  if (e.type === "compaction" && i > 0) continue; // 老 compaction 投影为空（源码注释同款）
  if (e.type === "compaction") { console.log(`  [compactionSummary] ${e.summary.split("\n")[0]} …`); continue; }
  if (e.type === "context_edit") continue; // 覆盖已应用到 target
  if (e.type !== "message") continue;
  let c = String(e.message.content).slice(0, 40);
  if (edits.has(e.id)) { c = `${edits.get(e.id).content ?? "[已省略]"}  ←(context_edit 覆盖)`; }
  console.log(`  [${e.message.role}] ${c}`);
}
console.log(`\ncontext_edit 生效数: ${edits.size}；原始文件行数不变: ${lines.length}`);
