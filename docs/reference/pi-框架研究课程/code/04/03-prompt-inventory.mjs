// 03-prompt-inventory.mjs
// "提示词即代码"审查清点：按 packages/coding-agent/src/core/system-prompt.ts 的
// buildSystemPromptSections()/buildRules() 逻辑，用默认配置重建 pi 的系统提示词，
// 分段统计行数/词数/估算 token，并逐条列出全部 bullet（规则/工具行）。
// 各工具的 snippet/guidelines 在运行时直接从源码文件提取（不手抄，避免版本漂移）。
// 运行：node 03-prompt-inventory.mjs [仓库路径]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.argv[2] ?? "C:/Users/75791/.lumii/workspace/temp/pi-course-research/pi";
const SRC = join(REPO, "packages/coding-agent/src/core/system-prompt.ts");
const TOOL = (n) => join(REPO, "packages/coding-agent/src/core/tools", `${n}.ts`);

const src = readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");

// --- 从源码提取各工具提示词贡献（snippet + guidelines），与 census 相同口径 ---
function contribution(name) {
  const s = readFileSync(TOOL(name), "utf8").replace(/\r\n/g, "\n");
  const snippet = s.match(/snippet:\s*"([^"]*)"/)?.[1] ?? name;
  const gl = s.match(/guidelines:\s*\[((?:[^"'\[\]]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*)\]/)?.[1] ?? "";
  return { snippet, guidelines: [...gl.matchAll(/"([^"]*)"/g)].map((m) => m[1]) };
}

// --- 默认配置（取证：system-prompt.ts L58 selectedTools ?? ["read","bash","edit","write"]）---
const selected = ["read", "bash", "edit", "write"];
const contrib = Object.fromEntries(selected.map((t) => [t, contribution(t)]));

// preamble（system-prompt.ts buildSystemPromptSections 内原文）
const preamble = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

// <tools> 段（同函数内模板）
const toolsSection = selected.map((t) => `- ${t}: ${contrib[t].snippet}`).join("\n")
  + "\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.";

// <rules> 段（buildRules() 逻辑：默认工具集下 hasBash && !grep/!find/!ls => 第一条规则成立）
const rules = [];
rules.push("Use bash for file operations like ls, rg, find");
for (const t of selected) for (const g of contrib[t].guidelines) rules.push(g);
rules.push("Be concise in your responses");
rules.push("Show file paths clearly when working with files");
const rulesSection = rules.map((r) => `- ${r}`).join("\n");

// <docs> 段（system-prompt.ts L153 原文模板，路径函数以占位符代替）
const docsSection =
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n" +
  "- Main documentation: <repo>/packages/coding-agent/README.md\n" +
  "- Additional docs: <repo>/packages/coding-agent/docs/\n" +
  "- Examples: <repo>/packages/coding-agent/examples/ (extensions, custom tools, SDK)\n" +
  "- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory\n" +
  "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)\n" +
  "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing\n" +
  "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";

const sections = [
  ["(untagged) preamble", preamble],
  ["<tools>", toolsSection],
  ["<rules>", rulesSection],
  ["<docs>", docsSection],
  ["(cwd, conditional)", "(omitted for default inventory)"],
];

const tok = (s) => Math.ceil(s.length / 4);
const words = (s) => s.trim().split(/\s+/).length;

console.log("pi 默认系统提示词重建清单（buildSystemPromptSections 的默认输出形状）");
console.log("源: packages/coding-agent/src/core/system-prompt.ts + 各工具 SystemPromptContribution");
console.log("");
let totChars = 0;
for (const [name, body] of sections) {
  const lines = body.split("\n").length;
  totChars += body.length;
  console.log(`${name.padEnd(22)} ${String(lines).padStart(3)} 行  ${String(words(body)).padStart(4)} 词  ≈${String(tok(body)).padStart(4)} tok`);
}
console.log("-".repeat(58));
console.log(`默认提示词合计 ≈ ${tok(preamble) + tok(toolsSection) + tok(rulesSection) + tok(docsSection)} tok（不含运行时插值与项目上下文）`);
console.log("");
console.log("bullet 逐条清单（可审计面）：");
let i = 0;
for (const t of selected) console.log(`  ${String(++i).padStart(2)}. [tools] ${t}: ${contrib[t].snippet}`);
for (const r of rules) console.log(`  ${String(++i).padStart(2)}. [rules] ${r}`);
console.log("");
console.log("审查要点：");
console.log("- <tools> 行与 <rules> 是 buildRules() 按启用工具集【生成】的：关掉 bash 则第 6 条");
console.log("  \"Use bash for file operations...\" 自动消失——提示词是工具集的纯函数，这是\"提示词即代码\"的字面实现。");
console.log("- <docs> 段专供\"agent 自我解释/自我扩展\"：文档与示例路径直接给出（README 自我扩展定位）。");
console.log("- 作者 2025-11-30 引 cchistory：Claude 系 harness 系统提示词可达 ~10,000 tokens；");
console.log("  博客称 pi 提示词+工具定义合计 <1000 tokens（L384，2025-11 版式）。当前 master 的 <docs> 段");
console.log("  比博客引述版本更长，与实验 01 的默认四工具 API 面合计仍在 ~1.2k tok 量级——");
console.log("  比对照组小一个数量级的结论不变。");
console.log("- 每条规则都应能回答\"防御哪个失败模式\"：答不出的规则，就是 Claude Code 提示词里的那 9,000 tokens。");
