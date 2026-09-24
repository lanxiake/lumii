// 01-tool-token-census.mjs
// pi 内置工具上下文注入普查：从本地克隆逐字抽取每个工具的
//   (a) API 注入面：tools 数组里的 description + 参数 schema（每次请求都发）
//   (b) 提示词注入面：promptSnippet + promptGuidelines（烘进 <tools>/<rules> 段）
// 估算 token = 字符数/4（英文 BPE 粗略近似，上界估计）。
// 取证文件：packages/coding-agent/src/core/tools/{read,bash,powershell,edit,write,grep,find,ls}.ts
// 对比数据出处：mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/（实测值）
// 运行：node 01-tool-token-census.mjs [仓库路径]（零依赖，Node>=20）
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.argv[2] ?? "C:/Users/75791/.lumii/workspace/temp/pi-course-research/pi";
const TOOLS_DIR = join(REPO, "packages/coding-agent/src/core/tools");

// 注册表取证：src/core/tools/index.ts 的 allToolNames = { read, bash, powershell, edit, write, grep, find, ls }
// 默认启用取证：src/core/system-prompt.ts L58  selectedTools ?? ["read","bash","edit","write"]
const TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const DEFAULT = new Set(["read", "bash", "edit", "write"]);

// 描述模板里的插值常量（源码原值）
const CONSTS = {
  "${DEFAULT_MAX_LINES}": "2000",
  "${DEFAULT_MAX_BYTES / 1024}": "50",
  "${DEFAULT_LIMIT}": "1000", // find 的 DEFAULT_LIMIT = 1000
  "${GREP_MAX_LINE_LENGTH}": "500",
  "${config.shellName}": "bash", // bash.ts L239：工具描述由 shell 配置模板生成
};
const resolveConsts = (s) => s.replace(/\$\{[^}]*\}/g, (m) => CONSTS[m] ?? m);

// 平衡大括号抽取：从 Type.Object( 后的第一个 { 开始
function extractBraced(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(from, i + 1); }
  }
  return "";
}

// 工具级 description：从 name/label: "<name>" 起，取第一个 description 值（转义感知）。
// schema 字段级 description 不会被误捕：工具定义里 schema 以常量名引用（parameters: readSchema）。
function extractToolDescription(src, name) {
  const descRe = /description:\s*(?:\r?\n\s*)?(?:`((?:[^`\\]|\\[\s\S]*)*)`|"((?:[^"\\]|\\[\s\S]*)*)"|'((?:[^'\\]|\\[\s\S]*)*)')/;
  const clean = (m) => (m ? (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\([`"'\\])/g, "$1").replace(/\r?\n\s+/g, " ") : "");
  // 前向：name/label 之后的第一个 description
  const idx = src.search(new RegExp(`(?:name|label):\\s*"${name}",`));
  if (idx >= 0) {
    const d = descRe.exec(src.slice(idx, idx + 2500));
    if (d) return clean(d);
  }
  // 兜底（bash：description 在工厂里、先于 name 出现）：全文取第一个长描述
  // （schema 字段级 description 都 <70 字符，不会与 80+ 字符的工具描述混淆）
  for (const m of src.matchAll(new RegExp(descRe, "g"))) {
    const s = clean(m);
    if (s.length >= 80) return s;
  }
  return "";
}

function census(name) {
  const src = readFileSync(join(TOOLS_DIR, `${name}.ts`), "utf8").replace(/\r\n/g, "\n");
  const desc = resolveConsts(extractToolDescription(src, name));
  // schema：文件内全部 Type.Object 块（edit 有嵌套 schema，一并计入）
  const schemas = [];
  for (const m of src.matchAll(/Type\.Object\(\s*\{/g)) schemas.push(extractBraced(src, src.indexOf("{", m.index)));
  const schema = schemas.join("\n");
  // (b) 提示词贡献
  const snippet = src.match(/snippet:\s*"([^"]*)"/)?.[1] ?? "";
  const gl = src.match(/guidelines:\s*\[((?:[^"'\[\]]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*)\]/)?.[1] ?? "";
  const guidelines = [...gl.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("; ");
  return { name, descChars: desc.length, schemaChars: schema.length, promptChars: snippet.length + guidelines.length, default: DEFAULT.has(name) };
}

const tok = (n) => Math.ceil(n / 4);
const rows = TOOLS.map(census);
// powershell 是对 createBashTool 的 Windows 包装（powershell.ts 复用 bash 工厂）：
// 无独立 description/schema 源码时，按继承 bash 计，并在表中标 †。
{
  const ps = rows.find((r) => r.name === "powershell");
  const bs = rows.find((r) => r.name === "bash");
  if (ps && bs && ps.descChars === 0 && ps.schemaChars === 0) {
    ps.descChars = bs.descChars; ps.schemaChars = bs.schemaChars; ps.inherit = true;
  }
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log("pi 内置工具上下文注入普查  (est tokens = chars/4)");
console.log("取证: " + TOOLS_DIR);
console.log("");
console.log(pad("tool", 12) + padL("desc", 7) + padL("schema", 8) + padL("API tok", 8) + padL("prompt tok", 11) + "   默认");
console.log("-".repeat(58));
let dAPI = 0, dPR = 0, aAPI = 0, aPR = 0;
for (const r of rows) {
  const api = tok(r.descChars) + tok(r.schemaChars), pr = tok(r.promptChars);
  aAPI += api; aPR += pr;
  if (r.default) { dAPI += api; dPR += pr; }
  console.log(pad(r.name + (r.default ? "*" : r.inherit ? "†" : " "), 12) + padL(r.descChars, 7) + padL(r.schemaChars, 8) + padL(api, 8) + padL(pr, 11) + "   " + (r.default ? "yes" : ""));
}
console.log("-".repeat(58));
console.log(`默认四工具(read/bash/edit/write)  API 注入 ≈ ${dAPI} tok   提示词注入 ≈ ${dPR} tok   合计 ≈ ${dAPI + dPR} tok`);
console.log(`八工具全开                        API 注入 ≈ ${aAPI} tok   提示词注入 ≈ ${aPR} tok   合计 ≈ ${aAPI + aPR} tok`);
console.log("");
console.log("MCP 对比（2025-11-02 博客实测，tools 数组固定注入）：");
const PW = 13693, CD = 17978, RD = 225;
console.log(`  Playwright MCP      21 tools ≈ ${PW} tok（占 ~200k 窗口 6.8%）`);
console.log(`  Chrome DevTools MCP 26 tools ≈ ${CD} tok（占 9.0%）`);
console.log(`  作者 browser-ctl    4 脚本 + README ${RD} tok（按需读取，非常驻）`);
console.log("");
console.log(`pi 默认四工具合计是 Playwright MCP 的 ${((dAPI + dPR) / PW * 100).toFixed(1)}%，Chrome DevTools 的 ${((dAPI + dPR) / CD * 100).toFixed(1)}%`);
console.log("");
console.log("口径说明：");
console.log("  pi API 面 = description 原文 + Type.Object schema 源码近似（JSON 序列化后同量级）；");
console.log("  pi 提示词面 = promptSnippet + guidelines（进 <tools>/<rules> 段）；MCP 数字为整个 tools[] 序列化。");
console.log("  † powershell 是 createBashTool 的 Windows 包装（powershell.ts 复用 bash 工厂与 schema），按继承 bash 计。");
console.log("  chars/4 对英文偏保守，方向性结论不受影响。");
