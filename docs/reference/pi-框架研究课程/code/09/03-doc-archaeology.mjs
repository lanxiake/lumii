// 03-doc-archaeology.mjs — 对本地 pi 克隆跑真实统计（全部只读）：
// pico 系列文档标题/行数、durable src 结构与 LOC、git log 中 durable/pico/harness 时间线。
// 用法: node 03-doc-archaeology.mjs [仓库路径]  （默认: temp/pi-course-research/pi）

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = process.argv[2] ?? "C:\\Users\\75791\\.lumii\\workspace\\temp\\pi-course-research\\pi";
if (!existsSync(join(REPO, ".git"))) { console.error(`未找到 git 仓库: ${REPO}`); process.exit(1); }
const git = (...args) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).stdout.trim();

const lineCount = (p) => readFileSync(p, "utf8").split(/\r?\n/).length - 1;
const firstLine = (p) => readFileSync(p, "utf8").split(/\r?\n/, 1)[0];

// 1) pico 系列文档：标题 + 行数（扫描 agent/docs 与 durable/docs）
console.log("=== pico 系列设计文档（标题 / 行数）===");
const docDirs = ["packages/agent/docs", "packages/agent/docs/pico", "packages/durable/docs"];
const rows = [];
for (const dir of docDirs) {
  const abs = join(REPO, dir);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs).filter((f) => f.endsWith(".md") && f.includes("pico"))) {
    const p = join(abs, f);
    rows.push([`${dir}/${f}`, firstLine(p), lineCount(p)]);
  }
}
rows.sort((a, b) => b[2] - a[2]);
for (const [p, t, n] of rows) console.log(`  ${String(n).padStart(5)}  ${t.padEnd(38)} ${p}`);
console.log(`  合计 ${rows.reduce((a, r) => a + r[2], 0)} 行；harness.md 参照: ${lineCount(join(REPO, "packages/agent/docs/harness.md"))} 行`);

// 2) durable src 结构与 LOC
console.log("\n=== packages/durable/src 结构与 LOC ===");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const files = walk(join(REPO, "packages/durable/src")).filter((f) => f.endsWith(".ts") && !f.includes("test"));
let total = 0;
for (const f of files) { const n = lineCount(f); total += n; console.log(`  ${String(n).padStart(5)}  ${relative(join(REPO, "packages/durable/src"), f).replaceAll("\\", "/")}`); }
console.log(`  ${String(total).padStart(5)}  TOTAL`);

// 3) git 时间线：durable 包提交 + harness 关键词
console.log("\n=== durable 包提交时间线（最近 12 条）===");
console.log(git("log", "--date=short", "--pretty=  %ad %h %s", "-12", "--", "packages/durable"));
console.log("\n=== 关键锚点 ===");
const first = (path) => git("log", "--reverse", "--date=short", "--pretty=%ad %h %s", "--", path).split("\n")[0];
console.log("  harness.md 首现 : " + first("packages/agent/docs/harness.md"));
console.log("  durable 包首现  : " + first("packages/durable"));
console.log("  chord 包首现    : " + first("packages/chord"));
console.log("  durable 相关提交总数: " + git("rev-list", "--count", "HEAD", "--", "packages/durable"));
console.log("  版本: " + git("describe", "--tags") + " ; tag 数: " + git("tag").split("\n").length);
