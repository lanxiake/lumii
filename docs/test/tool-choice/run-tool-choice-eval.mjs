/**
 * 工具选择评测 — 跑分器
 *
 * ## 与 memory-eval 的本质区别
 *
 * 那边是**离线**的（读 DB 算分数）；这边必须**跑真实回合**——测的是模型的工具选择行为，
 * 绕不开模型。代价：每个用例一个真实回合（30~90 秒），15 个用例约 15~20 分钟。
 * 所以它不进 CI，按需跑（通常在改工具面 / 提示词 / 工具描述之后）。
 *
 * ## 判据
 *
 * 从日志取两样东西：
 * - `ToolRunner] → <tool> ... params={...}` —— 工具名**与参数**（判 `rejectCommandPatterns` 要用）
 * - `tool:end toolName=<tool> isError=<bool>` —— 完成状态
 *
 * 三组断言：
 * | 断言 | 含义 | 强度 |
 * | --- | --- | --- |
 * | `expectTools` | 至少一个被调用 | 硬 |
 * | `rejectTools` | 一个都不该出现 | 硬 |
 * | `rejectCommandPatterns` | bash 命令里不该匹配这些模式 | 硬 |
 *
 * **只加不严**：不规定完整序列——同一件事有多种合理路径，评测锁底线不锁走法。
 *
 * ## 用法
 *
 *   node docs/test/tool-choice/run-tool-choice-eval.mjs            # 全部
 *   TC_ONLY=t01 node docs/test/tool-choice/run-tool-choice-eval.mjs # 只跑某个
 *   TC_COOLDOWN_MS=30000 ...                                       # 端点被压住时调大冷却
 *   TC_NO_RESTORE=1 ...                                            # 保留现场
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSession,
  logChannelAvailable,
  logCursor,
  logLinesSince,
  preflight,
  sendAndWait,
} from "../lumii-cli/lib/cli-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ONLY = process.env.TC_ONLY || "";
const NO_RESTORE = process.env.TC_NO_RESTORE === "1";
const TURN_TIMEOUT_MS = Number(process.env.TC_TURN_TIMEOUT_MS || 180000);

const SESSION_PREFIX = "[tc-choice]";

/** 探针文件写在这里（与 TC 套件一致：不与用户产物混淆，跑完即删） */
const PROBE_DIR = path.join(os.homedir(), ".lumii", "workspace");
const createdProbeFiles = [];

const evalSet = JSON.parse(fs.readFileSync(path.join(__dirname, "eval-set.json"), "utf8"));
const cases = evalSet.cases ?? [];

/**
 * 执行用例的前置（目前只有 `setup.writeFile`）。
 *
 * **为什么需要它**：第一版 t05 直接引用了一个 TC 套件的临时文件，而那个文件早被删了——
 * 模型只读到空结果，判据却说它"没调 file_edit"。**用例前提不成立时，失败长得和模型选错一模一样**。
 * 所以前置必须由用例自己造，不能依赖"上次跑剩下的东西"。
 */
function applySetup(c) {
  const s = c.setup;
  if (!s?.writeFile) return;
  const abs = path.join(PROBE_DIR, s.writeFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, s.content ?? "", "utf8");
  createdProbeFiles.push(abs);
}

function cleanupProbes() {
  for (const p of createdProbeFiles) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}
process.on("exit", cleanupProbes);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 环境类错误（应用不可达）——不是模型的失败，也不该计进通过率 */
function isEnvError(err) {
  const s = String(err);
  return /connection_failed|app_not_running|ECONNREFUSED|timed out/i.test(s);
}

/**
 * 模型侧被压住——**同样不是模型的失败**。
 *
 * 实测：并发打太高时（本套件 + 并行会话的探针同时压同一个模型端点），
 * 回合会一路跑到超时也等不到 assistant 消息，报「回合等待超时」。
 * 它和「模型选错了工具」在汇总里长得一模一样，但处置方向完全相反：
 * 前者要退避重试，后者要改工具面。
 *
 * 判据只用超时措辞，不用 `timed out`——那句太宽，会把网络的
 * `Request timed out` 也吞进来（那属于 isEnvError）。
 */
function isBusyError(err) {
  return /回合等待超时|未等到新的 assistant 消息/i.test(String(err));
}

/**
 * 可重试的两类错误及各自退避间隔。
 *
 * **为什么必须区分**：基线跑时 t12~t15 全部 `connection_failed`（应用当时忙于后台活动），
 * 它们在汇总里和"模型选错了工具"长得一样，直接把通过率从 ~73% 拉到 40%。
 * 那种数字会把人引向完全错误的结论——去查工具面，而问题在环境。
 *
 * 模型侧被压住同理，且退避要更长：端点卡住时立刻重试只会再压一次，
 * 实测同一回合连撞两次超时并不罕见。
 */
const RETRY_POLICY = [
  { match: isEnvError, delayMs: 8000, label: 'ENV-ERROR' },
  { match: isBusyError, delayMs: 30000, label: 'MODEL-BUSY' },
];

function classify(err) {
  return RETRY_POLICY.find((p) => p.match(err)) ?? null;
}

function withEnvRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      const policy = classify(err);
      if (!policy) throw err; // 真失败（断言炸了等）——不重试
      if (i < attempts - 1) sleep(policy.delayMs);
    }
  }
  throw lastErr;
}

/** 从日志行里抽工具调用（名字 + 参数） */
function toolCalls(lines) {
  const out = [];
  for (const l of lines) {
    // 贪婪 `.*` 到行尾：params 是嵌套 JSON，非贪婪会在第一个 `}` 处截断
    // （`{"filePath":"a","opt":{"x":1}}` 会被切成半截，JSON.parse 失败后
    //   bashCommands 只能退化成按原文匹配——那对 rejectCommandPatterns 是漏判）
    const m = l.match(/ToolRunner\]\s*→\s*(\S+)\s*\([^)]*\)\s*params=(\{.*\})\s*$/);
    if (m) out.push({ tool: m[1], rawParams: m[2] });
  }
  return out;
}

/** bash 命令文本（从 params JSON 里取 command 字段；解析失败返回空串） */
function bashCommands(calls) {
  const cmds = [];
  for (const c of calls) {
    if (c.tool !== "bash") continue;
    try {
      const p = JSON.parse(c.rawParams);
      if (typeof p.command === "string") cmds.push(p.command);
    } catch {
      cmds.push(c.rawParams); // 解析失败就按原文匹配，宁可多判不可漏判
    }
  }
  return cmds;
}

const results = [];

function runCase(c) {
  applySetup(c); // 前置由用例自己造，不依赖"上次跑剩下的东西"
  // 每个用例用**独立会话**：工具选择受上下文影响（上一轮的对话会改变模型的倾向），
  // 共用会话会让后跑的用例被前面的对话污染，而那种失败看起来像"模型选错了工具"。
  const sk = createSession(`选择评测 ${c.id}`, { prefix: SESSION_PREFIX });
  const cursor = logCursor();
  sendAndWait(sk, c.prompt, { timeoutMs: TURN_TIMEOUT_MS });
  const lines = logLinesSince(cursor);
  const calls = toolCalls(lines);
  const tools = calls.map((x) => x.tool);
  const cmds = bashCommands(calls);

  const problems = [];

  const expect = c.expectTools ?? [];
  if (expect.length && !expect.some((t) => tools.includes(t))) {
    problems.push(`期望调用 ${expect.join(" / ")} 之一，实际工具序列：[${tools.join(", ") || "无"}]`);
  }

  const reject = c.rejectTools ?? [];
  const hitReject = reject.filter((t) => tools.includes(t));
  if (hitReject.length) problems.push(`调用了不该用的工具：${hitReject.join(", ")}`);

  for (const pat of c.rejectCommandPatterns ?? []) {
    const re = new RegExp(pat);
    const bad = cmds.filter((cmd) => re.test(cmd));
    if (bad.length) problems.push(`bash 命令命中禁止模式 /${pat}/：${bad[0].slice(0, 90)}`);
  }

  const pass = problems.length === 0;
  results.push({ id: c.id, category: c.category, pass, tools, problems });
  console.log(
    `${pass ? "✅" : "❌"} [${c.id}] ${pass ? "PASS" : "FAIL — " + problems.join("；")}`,
  );
  if (pass) console.log(`     工具序列：${tools.join(" > ") || "（无工具调用）"}`);
}

// ────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────

console.log(`\n🧪 工具选择评测 —— ${cases.length} 个用例，回合超时 ${TURN_TIMEOUT_MS}ms\n`);

if (!logChannelAvailable()) {
  console.error("❌ 日志通道不可用——本评测依赖 tool:end 事件，无法降级运行");
  process.exit(3);
}
const pf = preflight();
if (!pf.ok) {
  console.error(`❌ 环境不就绪：${pf.problems.join("；")}`);
  console.error("   若刚 dev:restart 过，等约 20 秒再跑；否则先启动客户端。\n");
  process.exit(3);
}

const todo = ONLY ? cases.filter((c) => c.id.startsWith(ONLY)) : cases;
if (!todo.length) {
  console.error(`❌ TC_ONLY=${ONLY} 没有匹配的用例`);
  process.exit(1);
}

const MAX_CONSECUTIVE_BLOCKED = 3;

/**
 * 用例之间的冷却。
 *
 * **为什么需要**：本套件的"单个用例"远不止一次模型往返——实测单个回合最多发出
 * 22 次工具调用（t09），每次都是一次往返。连着跑会持续压同一个模型端点，
 * 而并行会话的探针也在压它。压过头就会整批回合超时（实测 t04/t05 双双
 * 「回合等待超时（180000ms）」），那既浪费时间又把通过率算错。
 * 冷却把压力摊开，是**降低评测自身并发**的主要手段。
 */
const COOLDOWN_MS = Number(process.env.TC_COOLDOWN_MS || 10000);

let consecutiveBlocked = 0;
let aborted = false;

for (let i = 0; i < todo.length; i++) {
  const c = todo[i];
  if (i > 0 && COOLDOWN_MS > 0) sleep(COOLDOWN_MS);
  try {
    withEnvRetry(() => runCase(c));
    consecutiveBlocked = 0;
  } catch (err) {
    const policy = classify(err);
    results.push({
      id: c.id,
      category: c.category,
      pass: false,
      blocked: policy?.label ?? null,
      tools: [],
      problems: [String(err).slice(0, 160)],
    });
    console.error(
      policy
        ? `⚠️  [${c.id}] ${policy.label}（重试 3 次仍失败——不计入通过率） — ${String(err).slice(0, 160)}`
        : `❌ [${c.id}] ERROR — ${String(err).slice(0, 160)}`,
    );

    if (policy) {
      consecutiveBlocked++;
      if (consecutiveBlocked >= MAX_CONSECUTIVE_BLOCKED) {
        console.error(
          `\n⛔ 连续 ${consecutiveBlocked} 条被环境/模型侧挡住，不再继续。`,
        );
        console.error(
          `   ENV-ERROR 多见于应用在做后台重活（实测踩过：palace-vector 后台补齐期间控制口不响应，` +
            `而日志里它在正常打进度、看起来不像故障）。`,
        );
        console.error(
          `   MODEL-BUSY 多见于并发过高——本套件、并行会话的探针、应用自身在压同一个模型端点。` +
            `调大 TC_COOLDOWN_MS（当前 ${COOLDOWN_MS}ms）后重跑。`,
        );
        console.error(`   剩余 ${todo.length - i - 1} 条不再跑：继续只会重复同样的失败。`);
        aborted = true;
        break;
      }
    }
  }
}

// ────────────────────────────────────────────────
// 汇总
// ────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const blocked = results.filter((r) => r.blocked);
const blockedCount = blocked.length;
/** 被环境/模型侧挡住的**不计入分母**——它们反映的不是模型的选法 */
const graded = results.length - blockedCount;

const byCategory = new Map();
for (const r of results) {
  if (r.blocked) continue;
  const k = r.category ?? "(未分类)";
  const v = byCategory.get(k) ?? { pass: 0, total: 0 };
  v.total++;
  if (r.pass) v.pass++;
  byCategory.set(k, v);
}

console.log("\n=== 按类别 ===");
for (const [k, v] of byCategory) console.log(`  ${k.padEnd(18)} ${v.pass}/${v.total}`);

const pct = graded > 0 ? ((passed / graded) * 100).toFixed(1) : "0.0";
console.log(`\n通过 ${passed}/${graded}（${pct}%）`);
if (aborted) {
  console.log(
    `⛔ 本次**因连续被挡住提前终止**，统计只覆盖已跑的 ${results.length}/${todo.length} 条——` +
      `这个数字不能当基线用，等条件恢复后重跑。`,
  );
}
if (blockedCount > 0) {
  const byLabel = new Map();
  for (const r of blocked) byLabel.set(r.blocked, [...(byLabel.get(r.blocked) ?? []), r.id]);
  for (const [label, ids] of byLabel) {
    console.log(
      `⚠️  另有 ${ids.length} 条 ${label} 未计入（${ids.join(", ")}）` +
        (label === "MODEL-BUSY"
          ? `——模型端点被压住（并发过高）。它们不是模型的失败，调大 TC_COOLDOWN_MS 后重跑补齐。`
          : `——应用当时不可达。同样不算模型的失败，要重跑补齐。`),
    );
  }
}
console.log();

if (!NO_RESTORE) {
  console.log("ℹ️  本评测不改任何全局设置，无需恢复现场（TC_NO_RESTORE 在当前实现下无副作用）");
}

process.exit(passed === results.length ? 0 : 1);
