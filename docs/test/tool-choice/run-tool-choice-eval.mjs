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
 * 回合结束后，取**该会话落库的 assistant 消息 parts**——一个回合的全部工具调用（名 + 完整参数）：
 * `parts[].type === 'tool'` 的 `name` / `args`。
 *
 * ⚠️ 证据来源曾是应用日志（`ToolRunner] → <tool> ... params={...}`）。2026-09-19 换源：
 * 宿主把 params 预览**截断在 200 字符**，长参数调用（cron_create 的 taskText、
 * ask_user_question、memory_manage…）行尾没有收尾 `}`，旧正则要求 `params={...}`
 * 完整闭合——这些调用被**整条静默丢掉**（实测一回合 8 条丢 3 条，t15 因此被误记成
 * 「没建任务」，而任务真在 DB 里）。日志还有渲染桥接口径问题（tool:end 类行走 UI 订阅，
 * 后台回合不落盘）。消息 parts 是应用的权威记录，无截断、无桥接。
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
  dbExec,
  dbQuery,
  fetchMessages,
  parseContentJson,
  preflight,
  sendAndWait,
  ui,
} from "../lumii-cli/lib/cli-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ONLY = process.env.TC_ONLY || "";
const NO_RESTORE = process.env.TC_NO_RESTORE === "1";
/**
 * 默认回合预算。**不能按"模型干活有多快"来定**：模型中途问用户时（评测环境无人应答），
 * 回合要等提问超时被拒答（实测 ~5 分 13 秒）+ 拒答后继续干活，合法回合也要 6~9 分钟；
 * 预算小于它，这类回合会被误判成 MODEL-BUSY 重试（2026-09-19 改 await 真回合终点后暴露）。
 * 用例可用 `turnTimeoutMs` 再放宽（t15 走提问路径，设 12 分钟）。
 */
const TURN_TIMEOUT_MS = Number(process.env.TC_TURN_TIMEOUT_MS || 600000);

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

/**
 * 用例副作用防线：快照 local_cron_jobs 的 id 集合。
 *
 * **为什么需要**：t15 是真实用户请求「建一个定时任务」——回合真的会在用户数据里
 * 建出一条 enabled=1 的任务（2026-09-19 实测：模型建了「每日9点晨间简报」自续链，
 * 明早会触发并自我重建）。本评测此前声称「不改任何全局设置」，是错的。
 */
function snapshotCronJobIds() {
  try {
    return new Set(dbQuery("SELECT id FROM local_cron_jobs").map((r) => r.id));
  } catch (err) {
    console.warn(`⚠️  无法快照定时任务（跳过清理）: ${String(err).slice(0, 120)}`);
    return null;
  }
}

/**
 * 删除用例期间新建的定时任务，返回被删的 {id, name}。
 *
 * 优先走控制口 `cron:delete`（白名单内，连带清内存定时器，与用户手动删同路径）；
 * 命令失败再退化为删行——删行同样安全：调度器触发前会重查 DB
 * （cron-scheduler.ts:1087「已从 DB 删除，跳过执行」），只是会多留一条 warn 日志。
 */
function cleanupNewCronJobs(before) {
  if (!before) return [];
  const created = dbQuery("SELECT id, name FROM local_cron_jobs")
    .filter((j) => !before.has(j.id))
    .map((j) => ({ id: j.id, name: j.name }));
  for (const j of created) {
    const r = ui(["command", "cron:delete", "--data", JSON.stringify({ id: j.id })]);
    if (r.code !== 0 || r.json?.ok === false) {
      console.warn(`⚠️  cron:delete 未成功（${j.name}），退化为删行`);
      dbExec("DELETE FROM local_cron_runs WHERE job_id = ?", j.id);
      dbExec("DELETE FROM local_cron_jobs WHERE id = ?", j.id);
    }
  }
  return created;
}

/**
 * 用例副作用防线 2：快照 agent_memories 的 id 集合。
 *
 * **为什么需要**：t15 的真实回合里模型会顺手 `memory_manage add` 记一条
 * 「AI新闻早报任务」参考（2026-09-19 实测）——任务本身被清理了，记忆却留在用户记忆库里，
 * 变成指向不存在任务的误导信息。与定时任务同属"测试不得留用户数据"红线。
 */
function snapshotMemoryIds() {
  try {
    return new Set(dbQuery("SELECT id FROM agent_memories").map((r) => r.id));
  } catch (err) {
    console.warn(`⚠️  无法快照记忆库（跳过清理）: ${String(err).slice(0, 120)}`);
    return null;
  }
}

/**
 * 删除用例期间新建的记忆条目，返回被删的 {id, snippet}。
 *
 * 只按 id 差集删——用例期间必须由用例自身写入才算数（评测跑的是用户本机的应用，
 * 后台若有其它写记忆的活，其 id 会落进差集被误删；当前 autonomous-tick 是关的，
 * 且这是"宁可清干净"的取向，故接受并用注释留痕）。
 * 局限：模型若**去重更新**了一条已存在的记忆（实测 add 相同内容会更新而非新建），
 * 变更不在差集里、不会回滚——遇到再补手段。
 */
function cleanupNewMemories(before) {
  if (!before) return [];
  const created = dbQuery("SELECT id, substr(content, 1, 50) AS snippet FROM agent_memories")
    .filter((m) => !before.has(m.id))
    .map((m) => ({ id: m.id, snippet: m.snippet }));
  for (const m of created) dbExec("DELETE FROM agent_memories WHERE id = ?", m.id);
  return created;
}

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

/**
 * 抽本回合的工具调用（名字 + 完整参数），来源 = 落库的 assistant 消息 parts。
 *
 * 为什么不解析日志见文件头「判据」：日志把 params 截断在 200 字符
 * （logging-hook.ts:23 `JSON.stringify(params).slice(0, 200)`），长参数调用整条丢失。
 */
function toolCallsOfTurn(sk) {
  const items = fetchMessages(sk, 10);
  let last = null;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.role === "assistant") {
      last = items[i];
      break;
    }
  }
  const parts = parseContentJson(last)?.parts;
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((p) => p && p.type === "tool" && typeof p.name === "string")
    .map((p) => ({ tool: p.name, params: p.args ?? {} }));
}

/** bash 命令文本（parts 里的 args.command 是完整原文，无截断） */
function bashCommands(calls) {
  const cmds = [];
  for (const c of calls) {
    if (c.tool !== "bash") continue;
    if (typeof c.params?.command === "string") cmds.push(c.params.command);
  }
  return cmds;
}

const results = [];

function runCase(c) {
  applySetup(c); // 前置由用例自己造，不依赖"上次跑剩下的东西"
  // 每个用例用**独立会话**：工具选择受上下文影响（上一轮的对话会改变模型的倾向），
  // 共用会话会让后跑的用例被前面的对话污染，而那种失败看起来像"模型选错了工具"。
  const sk = createSession(`选择评测 ${c.id}`, { prefix: SESSION_PREFIX });
  const jobsBefore = snapshotCronJobIds();
  const memoriesBefore = snapshotMemoryIds();
  // 用例级超时：提问挂起的回合（评测环境无人应答，问句要等超时被拒答、模型才继续）
  // 需要比默认 600s 更宽的预算，见 eval-set 里 t15 的 turnTimeoutMs。
  const turnTimeoutMs = c.turnTimeoutMs ?? TURN_TIMEOUT_MS;

  let calls, tools, cmds;
  let cleanedJobs = [];
  let cleanedMemories = [];
  try {
    sendAndWait(sk, c.prompt, { timeoutMs: turnTimeoutMs });
    // 回合终点（is_streaming=0）落定后消息 parts 才完整——见 cli-harness sendAndWait
    calls = toolCallsOfTurn(sk);
    tools = calls.map((x) => x.tool);
    cmds = bashCommands(calls);
  } finally {
    // 副产物清理放 finally：用例失败（throw）时同样不能把用户数据留在被改动状态
    if (!NO_RESTORE) {
      cleanedJobs = cleanupNewCronJobs(jobsBefore);
      cleanedMemories = cleanupNewMemories(memoriesBefore);
    }
  }

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
  if (cleanedJobs.length || cleanedMemories.length) {
    const parts = [];
    if (cleanedJobs.length) parts.push(`定时任务 ${cleanedJobs.map((j) => j.name).join("、")}`);
    if (cleanedMemories.length) parts.push(`记忆条目 ${cleanedMemories.length} 条`);
    console.log(`     🧹 已清理用例期间的用户数据副产物：${parts.join("；")}`);
  }
}

// ────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────

console.log(`\n🧪 工具选择评测 —— ${cases.length} 个用例，回合超时 ${TURN_TIMEOUT_MS}ms\n`);

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

console.log(
  NO_RESTORE
    ? "ℹ️  TC_NO_RESTORE=1：用例期间新建的定时任务/记忆条目**保留现场**（不清理，仅供检查）"
    : "ℹ️  本评测不切全局设置；用例期间产生的用户数据副产物（定时任务走控制口 cron:delete、记忆条目删 id 差集）已在用例内清理。",
);

process.exit(passed === results.length ? 0 : 1);
