// 03-skills-disclosure.mjs — 技能渐进披露的 token 账 + prompt 模板替换语义
// 对应文章 §7。skills.md：常驻注入只有 name+description+path，正文按需加载。

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), "pi-course-05-skills");
const estTokens = (s) => Math.ceil(s.length / 4);

// --- 生成一个真实的 skill 目录结构：SKILL.md(frontmatter+长正文) + scripts/ ----
mkdirSync(join(ROOT, "pdf-lite", "scripts"), { recursive: true });
const BODY = "To extract text from a PDF, run scripts/extract.mjs with the file path. " +
  "Handle encrypted PDFs by prompting for a password first. For scanned documents, fall back to OCR via tesseract. ".repeat(60);
writeFileSync(join(ROOT, "pdf-lite", "SKILL.md"),
  `---\nname: pdf-lite\ndescription: Extract text and metadata from PDF files; handles encryption and scanned documents.\n---\n\n# pdf-lite\n\n${BODY}\n`);
writeFileSync(join(ROOT, "pdf-lite", "scripts", "extract.mjs"), 'console.log("text");\n');
// 11 个陪跑技能，让常驻账更真实
const NAMES = ["xlsx-slim", "ical-sync", "invoice-read", "yt-transcribe", "qr-ops", "csv-join", "doc-diff", "font-check", "ical-invite", "s3-presign", "log-scan"];
for (const n of NAMES) {
  mkdirSync(join(ROOT, n), { recursive: true });
  writeFileSync(join(ROOT, n, "SKILL.md"),
    `---\nname: ${n}\ndescription: ${"Small helper skill that does one specific job well. ".repeat(3)}\n---\n\n# ${n}\n\n${BODY.slice(0, 800)}\n`);
}

// --- 解析 frontmatter（只要 name/description，两行 YAML 的退化情形） ----------
function readSkill(dir) {
  const raw = readFileSync(join(ROOT, dir, "SKILL.md"), "utf8");
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)[1];
  const name = /name:\s*(.+)/.exec(fm)?.[1]?.trim();
  const description = /description:\s*(.+)/.exec(fm)?.[1]?.trim();
  return { name, description, full: raw };
}
const skills = [...NAMES, "pdf-lite"].map(readSkill);

// --- 常驻注入：模拟系统提示词里的技能索引段 ----------------------------------
const indexBlock = "\nAvailable skills:\n" +
  skills.map((s) => `- ${s.name}: ${s.description} (instructions: ${join(ROOT, s.name, "SKILL.md")})`).join("\n");
const fullLoad = skills.find((s) => s.name === "pdf-lite").full;

console.log(`技能数: ${skills.length}（skills.md 限制: name≤64, description≤1024 字符）`);
console.log(`常驻索引（name+description+path ×${skills.length}）: ${indexBlock.length} 字符 ≈ ${estTokens(indexBlock)} tok`);
console.log(`pdf-lite 全文: ${fullLoad.length} 字符 ≈ ${estTokens(fullLoad)} tok`);
console.log(`单技能全文/常驻 比值: ${(estTokens(fullLoad) / (estTokens(indexBlock) / skills.length)).toFixed(1)}×`);
console.log(`→ 100 个技能的常驻成本 ≈ ${Math.round((estTokens(indexBlock) / skills.length) * 100)} tok；若全部全文加载 ≈ ${estTokens(fullLoad) * 100} tok`);
console.log("渐进披露的本质：为『可能用到』付费，而不是为『一定用到』付费。\n");

// --- prompt 模板替换：$1/$@/${1:-def}/${@:-def}/${@:N}/${@:N:L}（shell 式引号） --
function splitArgs(input) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(input))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
function expand(template, args) {
  let s = template;
  s = s.replace(/\$\{(\d+):-([^}]*)\}/g, (_, i, d) => args[Number(i) - 1] || d);
  s = s.replace(/\$\{@:-(.*?)\}/g, (_, d) => args.join(" ") || d);
  s = s.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, n, len) => (len === undefined ? args.slice(Number(n) - 1) : args.slice(Number(n) - 1, Number(n) - 1 + Number(len))).join(" "));
  s = s.replace(/\$(\d+)/g, (_, i) => args[Number(i) - 1] ?? "");
  s = s.replace(/\$(?:@|ARGUMENTS)/g, args.join(" "));
  return s;
}
const TPL = `Review $1 (focus: ${"$"}{2:-correctness, security}). Full request: $@. Extra: ${"$"}{@:2}`;
const cases = [
  "",
  `"API compatibility" perf`,
  'auth "input validation" sql-injection trailing',
];
console.log("模板: " + TPL);
for (const c of cases) {
  const args = splitArgs(c);
  console.log(`\n  输入: ${c ? c : "(空，走默认值)"}`);
  console.log(`  参数: ${JSON.stringify(args)}`);
  console.log(`  展开: ${expand(TPL, args)}`);
}
// 断言（跑不到这里就说明语义错了）
const a1 = expand(TPL, splitArgs(cases[0]));
if (!a1.includes("focus: correctness, security") || !a1.includes("Extra: ")) throw new Error("默认值/切片语义错误");
const a2 = expand(TPL, splitArgs(cases[2]));
if (!a2.includes("Review auth") || !a2.includes("focus: input validation") || !a2.includes("Extra: input validation sql-injection trailing")) throw new Error("$1/$2/${@:N} 语义错误");
console.log("\n断言通过：默认值、$1/$2 位置参数、$@ 全参、${@:N} 切片均符合 prompt-templates.md 语义表。");
