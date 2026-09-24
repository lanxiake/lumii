// 02-toy-compactor.mjs — pi 风格压缩器：切点/双摘要/累积文件账本/append-only 落盘
// 对应文章 §5.1-§5.5。token 估算与阈值同用真实公式，数值按比例缩小到玩具级。

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DIR = join(tmpdir(), "pi-course-05-compactor");
mkdirSync(DIR, { recursive: true });
const FILE = join(DIR, "session.jsonl");

// 与 compaction.ts 同源的不等式；数值缩小便于 40 条消息触发
const SETTINGS = { reserveTokens: 600, keepRecentTokens: 900 };
const CONTEXT_WINDOW = 2000;
const estTokens = (s) => Math.ceil(s.length / 4); // chars/4 粗估（与 pi 同款）
const shouldCompact = (ctx) => ctx > CONTEXT_WINDOW - SETTINGS.reserveTokens;

// --- 合成会话：8 个 user span，工具结果大小悬殊（种子固定，输出可复现） -------
let seed = 42;
const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
const entries = [];
let prev = null;
const push = (e) => { entries.push({ ...e, id: e.id ?? `m${entries.length}`, parentId: prev }); prev = e.id ?? entries[entries.length - 1].id; };
for (let span = 0; span < 5; span++) {
  push({ type: "message", message: { role: "user", content: `任务 ${span}: 检查并修改模块 ${span}（附带上下文膨胀测试）` } });
  push({ type: "message", message: { role: "assistant", content: `[toolCall read src/mod${span}.ts]` } });
  push({ type: "message", message: { role: "toolResult", toolName: "read", content: "x".repeat(900 + rnd(1200)) } });
  push({ type: "message", message: { role: "assistant", content: `[toolCall bash] grep -rn handle${span}` } });
  push({ type: "message", message: { role: "toolResult", toolName: "bash", content: ("hit " + span + " ").repeat(60 + rnd(80)) } });
  push({ type: "message", message: { role: "assistant", content: `[toolCall edit src/mod${span}.ts] 重命名 handle${span}→on${span}` } });
  push({ type: "message", message: { role: "toolResult", toolName: "edit", content: "ok" } });
  push({ type: "message", message: { role: "assistant", content: `模块 ${span} 完成` } });
}
const writeAll = () => writeFileSync(FILE, [JSON.stringify({ type: "session", version: 3, id: "demo0001", cwd: "/demo" }), ...entries.map(JSON.stringify)].join("\n") + "\n");

// --- findCutPoint：从新往旧累加，绝不切 toolResult（§5.2） -------------------
function findCutPoint(list, startIdx) {
  let acc = 0;
  for (let i = list.length - 1; i >= startIdx; i--) {
    acc += estTokens(JSON.stringify(list[i]));
    if (acc >= SETTINGS.keepRecentTokens) {
      for (let j = i; j >= startIdx; j--) { // 找最近合法切点
        const e = list[j];
        if (e.type === "message" && e.message.role !== "toolResult") return j;
      }
    }
  }
  return startIdx;
}
// --- split turn：切点不在 span 开头 → 双摘要合并（§5.3） ---------------------
function turnStartIdx(list, cut) {
  for (let j = cut; j >= 0; j--) if (list[j].type === "message" && list[j].message.role === "user") return j;
  return cut;
}
// --- 机械文件账本：从工具调用推导，跨压缩累积（§5.5） ------------------------
function fileOpsFrom(list, ops = { read: new Set(), modified: new Set() }) {
  for (const e of list) {
    if (e.type !== "message") continue;
    const c = String(e.message.content);
    if (e.message.role === "assistant") {
      const r = c.match(/\[toolCall read ([^\]]+)\]/), w = c.match(/\[toolCall edit ([^\]]+)\]/);
      if (r) ops.read.add(r[1]);
      if (w) ops.modified.add(w[1]);
    }
  }
  return ops;
}
function makeSummary(list, prevSummary, prevDetails) {
  const ops = fileOpsFrom(list, { read: new Set(prevDetails?.readFiles ?? []), modified: new Set(prevDetails?.modifiedFiles ?? []) });
  const head = prevSummary ? `<previous-summary>\n${prevSummary.split("\n").slice(0, 2).join(" ")} …(迭代更新)\n</previous-summary>\n` : "";
  return head + `## Goal\n${list.find((e) => e.type === "message" && e.message.role === "user")?.message.content.slice(0, 30)} …\n` +
    `## Progress\n共 ${list.filter((e) => e.type === "message" && e.message.role === "assistant").length} 次 assistant 动作\n` +
    `## Files\nRead: ${[...ops.read].join(", ")}\nModified: ${[...ops.modified].join(", ")}`;
}
// --- 一轮压缩 + append-only 落盘（§5.4） --------------------------------------
function compactRound(tag, startIndex) {
  const tokensBefore = entries.reduce((a, e) => a + estTokens(JSON.stringify(e)), 0);
  const cut = findCutPoint(entries, startIndex);
  const ts = turnStartIdx(entries, cut);
  const isSplit = cut !== ts;
  const summarized = entries.slice(startIndex, cut);
  const prefix = isSplit ? entries.slice(ts, cut) : [];
  const prevComp = [...entries].reverse().find((e) => e.type === "compaction");
  let summary = makeSummary(summarized, prevComp?.summary, prevComp?.details);
  if (isSplit) summary += "\n## Turn Prefix (split turn)\n" + makeSummary(prefix, null, prevComp?.details);
  const opsForEntry = fileOpsFrom([...(prevComp ? entries.slice(0, entries.indexOf(prevComp) + 1) : []), ...summarized, ...prefix], { read: new Set(prevComp?.details?.readFiles ?? []), modified: new Set(prevComp?.details?.modifiedFiles ?? []) });
  const entry = { type: "compaction", id: `comp_${tag}`, parentId: entries[entries.length - 1].id,
    firstKeptEntryId: entries[cut].id, tokensBefore, summary,
    details: { readFiles: [...opsForEntry.read], modifiedFiles: [...opsForEntry.modified] } };
  const before = readFileSync(FILE, "utf8");
  entries.push(entry); writeAll();
  const after = readFileSync(FILE, "utf8");
  const windowList = [entry, ...entries.slice(cut, entries.length - 1)];
  const tokensAfter = windowList.reduce((a, e) => a + estTokens(JSON.stringify(e)), 0);
  console.log(`\n[压缩 ${tag}] splitTurn=${isSplit}`);
  console.log(`  摘要(${estTokens(summary)} tok) 尾部: ${summary.split("\n").slice(-2).join(" | ")}`);
  console.log(`  全文件估算: ${tokensBefore} → 投影窗口 ${tokensAfter} tok（含已被前轮裁掉的段，故只作量级参考）`);
  console.log(`  压缩段 ${summarized.length + prefix.length} 条，firstKeptEntryId=${entry.firstKeptEntryId}`);
  console.log(`  append-only 校验: 追加前 ${before.split("\n").length - 1} 行 → 追加后 ${after.split("\n").length - 1} 行（本轮净增 ${after.split("\n").length - before.split("\n").length} 行；前缀逐字节一致 = ${after.startsWith(before)} ← append-only 的铁证）`);
}

// --- 跑两轮：第一轮常规，追加 12 条后第二轮验证迭代摘要与账本累积 -------------
writeAll();
let total = entries.reduce((a, e) => a + estTokens(JSON.stringify(e)), 0);
console.log(`消息数 ${entries.length}，估算 ${total} tok，窗口 ${CONTEXT_WINDOW}，阈值 ${CONTEXT_WINDOW - SETTINGS.reserveTokens}`);
console.log(`shouldCompact = ${shouldCompact(total)}`);
compactRound("1", 0);

const start2 = entries.length; // 第二轮只摘要 comp_1 之后新增的消息
for (let span = 8; span < 10; span++) {
  push({ type: "message", message: { role: "user", content: `任务 ${span}: 收尾与集成测试` } });
  push({ type: "message", message: { role: "assistant", content: `[toolCall read tests/auth.test.ts]` } });
  push({ type: "message", message: { role: "toolResult", toolName: "read", content: "y".repeat(1400 + rnd(600)) } });
  push({ type: "message", message: { role: "assistant", content: `[toolCall edit tests/integration.ts] 新增用例` } });
  push({ type: "message", message: { role: "toolResult", toolName: "edit", content: "ok" } });
}
compactRound("2", start2);
const finalComp = entries[entries.findLastIndex((e) => e.type === "compaction")];
console.log(`\n迭代验证: 第 2 条摘要含 <previous-summary> = ${finalComp.summary.includes("<previous-summary>")}`);
console.log(`账本累积: readFiles=${finalComp.details.readFiles.length} 个, modifiedFiles=${finalComp.details.modifiedFiles.length} 个（第 1 条 compaction 的清单已并入）`);
console.log(`原始文件总行数: ${readFileSync(FILE, "utf8").split("\n").length - 1}（40 条消息 + 追加的 compaction 全部共存）`);
