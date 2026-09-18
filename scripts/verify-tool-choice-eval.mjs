/**
 * 校验工具选择评测集的**自洽性**。
 *
 * ## 为什么需要它
 *
 * 评测集里写错工具名时，`expectTools` 断言会**永远不命中**——而"不命中"在汇总里
 * 看起来和"模型没选对"一模一样，于是整条评测**静默失效**，还需要人去"修模型"。
 * 这比没有评测更糟：它给出的是错误的行动方向。
 *
 * 同源的做法见 `docs/test/memory-eval`——那份评测集的 `_comment` 里记着
 * "通过脚本校验过每个字面量确实存在于库中"。那边校验"语料存在"，这里校验"工具名存在"。
 *
 * ## 校验什么
 *
 * 1. `expectTools` 的每个名字**必须**真实存在（内置注册表或宿主注册器）——
 *    写错了不会有任何提示，所以必须在这里拦。
 * 2. `rejectTools` 的**不存在**是合法的（t13 就是专测"模型臆造工具名"），
 *    但要**打印出来**让人确认那是本意，而不是手滑。
 * 3. `id` 唯一、`rejectCommandPatterns` 是合法正则、必备字段齐全。
 *
 * 运行：node scripts/verify-tool-choice-eval.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_SET = path.join(ROOT, "docs/test/tool-choice/eval-set.json");
const BUILT_IN_DIR = path.join(ROOT, "packages/agent-runtime/src/tools/built-in");
const HOST_DIR = path.join(ROOT, "apps/windows/src/main/agent-runtime");

/**
 * 从 tool-names.ts 解析 `XXX_TOOL_NAME = "实际名字"`，供解析常量化 name 用。
 *
 * 为什么需要：有些工具写 `name: ASK_USER_QUESTION_TOOL_NAME` 而不是字面量，
 * 只扫字面量的正则会**把它们当成不存在**——本脚本第一版就漏了 4 个，
 * 并把已接线的 execute_skill 报成"不存在"。
 * 这类"扫描器自己有盲区"的问题与 host-tool-prompt-coverage 那次同源：
 * **扫不到不等于不存在**，报错方向恰好是反的（会让人去删一个对的引用）。
 */
function loadNameConstants() {
  const map = new Map();
  const p = path.join(BUILT_IN_DIR, "tool-names.ts");
  if (!fs.existsSync(p)) return map;
  const src = fs.readFileSync(p, "utf8");
  for (const m of src.matchAll(/export const (\w+)\s*=\s*"([a-z][a-z0-9_]*)"/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

/**
 * 读 `ALL_BUILT_IN_TOOL_CONFIGS` 的成员（`xxxToolConfig,`）。
 *
 * **必须以注册表为准，不能"定义了就算"**：`bing-search-tool.ts` 定义了 config 却没进数组，
 * `wiki-tools.ts` 的 `wikiCaptureToolConfig` 是明确下线的（数组旁有注释）。
 * 第一版按"文件里有 name 字段就算"扫出 57 个，比实际多 2 个——
 * 方向恰好是危险的：把**未注册**的当存在，评测集里写这些名字会被放行。
 */
function loadRegisteredConfigVars() {
  const p = path.join(BUILT_IN_DIR, "index.ts");
  if (!fs.existsSync(p)) return null;
  const src = fs.readFileSync(p, "utf8");
  // ⚠️ 锚点必须带 `export const ` —— 裸找 `ALL_BUILT_IN_TOOL_CONFIGS` 会先命中
  // 注释里的那处（"@deprecated 已从 ALL_BUILT_IN_TOOL_CONFIGS 下线"），
  // 于是把已下线的 wikiCaptureToolConfig 当成了注册成员（实测多算 1 个）。
  const start = src.indexOf("export const ALL_BUILT_IN_TOOL_CONFIGS");
  if (start < 0) return null;
  const end = src.indexOf("];", start);
  const body = src.slice(start, end < 0 ? undefined : end);
  const vars = new Set([...body.matchAll(/(\w+ToolConfig),/g)].map((m) => m[1]));
  vars.delete("ALL_BUILT_IN_TOOL_CONFIGS"); // 防锚点自身被匹配进来
  return vars;
}

/** 扫内置工具名：`  name: "xxx"` 或 `  name: XXX_TOOL_NAME`（常量），且 config 在注册表里 */
function scanBuiltInToolNames() {
  const consts = loadNameConstants();
  const registeredVars = loadRegisteredConfigVars();
  const names = new Set();
  for (const f of fs.readdirSync(BUILT_IN_DIR)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const src = fs.readFileSync(path.join(BUILT_IN_DIR, f), "utf8");
    // 切出每个 `export const xxxToolConfig = { ... name: ... }` 块，块内找 name
    for (const m of src.matchAll(/export const (\w+ToolConfig)\b[\s\S]{0,600}?^\s{2}name:\s*(?:"([a-z][a-z0-9_]*)"|([A-Z][A-Z0-9_]*))/gm)) {
      const [, varName, literal, constName] = m;
      if (registeredVars && !registeredVars.has(varName)) continue; // 未进注册表 → 不算
      const resolved = literal ?? consts.get(constName);
      if (resolved) names.add(resolved);
    }
  }
  return names;
}

/** 扫宿主注册的工具名（与 host-tool-prompt-coverage.test.ts 同口径） */
function scanHostToolNames() {
  const names = new Set();
  for (const f of fs.readdirSync(HOST_DIR)) {
    if (!f.startsWith("bridge-") || !f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const src = fs.readFileSync(path.join(HOST_DIR, f), "utf8");
    for (const m of src.matchAll(/^\s+name:\s*['"]([a-z][a-z0-9_]{2,})['"]/gm)) names.add(m[1]);
  }
  return names;
}

const builtIn = scanBuiltInToolNames();
const host = scanHostToolNames();
const registered = new Set([...builtIn, ...host]);

const evalSet = JSON.parse(fs.readFileSync(EVAL_SET, "utf8"));
const cases = evalSet.cases ?? [];
const problems = [];
const notes = [];

if (cases.length === 0) problems.push("cases 为空——评测集没有用例");

const seenIds = new Set();
for (const c of cases) {
  const where = `[${c.id ?? "<无 id>"}]`;

  if (!c.id) problems.push(`${where} 缺 id`);
  if (seenIds.has(c.id)) problems.push(`${where} id 重复`);
  seenIds.add(c.id);
  if (!c.prompt) problems.push(`${where} 缺 prompt`);
  if (!c.why) problems.push(`${where} 缺 why——判据必须能追溯到提示词/工具描述原文`);

  for (const t of c.expectTools ?? []) {
    if (!registered.has(t)) {
      problems.push(
        `${where} expectTools 里的 "${t}" **不存在**——这条断言永远不会命中，` +
          `而汇总里看起来会和"模型没选对"一样。${builtIn.size} 内置 + ${host.size} 宿主里没有它。`,
      );
    }
  }

  for (const t of c.rejectTools ?? []) {
    if (!registered.has(t)) {
      // 合法但要说出来：t13 专测"模型臆造工具名"，reject 不存在的名字正是它的目的
      notes.push(`${where} rejectTools 含不存在的 "${t}"（若这条就是测「不该臆造」，属预期）`);
    }
  }

  for (const p of c.rejectCommandPatterns ?? []) {
    try {
      new RegExp(p);
    } catch (e) {
      problems.push(`${where} rejectCommandPatterns 里的 ${JSON.stringify(p)} 不是合法正则：${e.message}`);
    }
  }

  if (!(c.expectTools ?? []).length && !(c.rejectTools ?? []).length && !(c.rejectCommandPatterns ?? []).length) {
    problems.push(`${where} 三组判据全空——它不会有任何断言`);
  }
}

console.log(`评测集：${cases.length} 个用例`);
console.log(`工具名池：${builtIn.size} 内置 + ${host.size} 宿主 = ${registered.size}`);
console.log();
for (const n of notes) console.log("ℹ️  " + n);
if (notes.length) console.log();

if (problems.length) {
  console.error("❌ 校验失败：");
  for (const p of problems) console.error("   " + p);
  process.exit(1);
}
console.log("✅ 评测集自洽（工具名存在、id 唯一、正则合法、判据非空）");
