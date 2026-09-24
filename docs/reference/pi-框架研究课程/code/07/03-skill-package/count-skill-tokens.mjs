// count-skill-tokens.mjs
// 分发单元视角算"渐进披露"的账（与第 5 篇正文的账同源，视角不同）：
// skills.md 规定常驻注入只有 name + description（+路径），SKILL.md 正文与
// scripts/ 只在模型判断相关后按需加载。本脚本扫描 skills/*/SKILL.md，
// 按 chars/4 估算两种模式的注入量差值。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "skills");
const est = (s) => Math.ceil(s.length / 4);

const skills = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());
console.log(`扫描 ${root.replace(process.cwd() + "/", "")} 下 ${skills.length} 个技能\n`);
console.log("skill        常驻注入(estimate)  全文加载(estimate)  节省");
console.log("-".repeat(66));

let totResident = 0;
let totFull = 0;
for (const name of skills) {
	const raw = readFileSync(join(root, name, "SKILL.md"), "utf8");
	const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
	const fields = Object.fromEntries(
		(fm?.[1] ?? "").split("\n").filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]),
	);
	// 常驻注入形状（skills.md）：name + description + 指向 SKILL.md 的路径
	const resident = `${fields.name}\n${fields.description}\n${join(root, name, "SKILL.md")}`;
	// 全文加载：SKILL.md 正文 + 支持脚本（模型按需读文件，这里都算上）
	let full = raw;
	try {
		full += readFileSync(join(root, name, "scripts", "wordcount.mjs"), "utf8");
	} catch { /* 无脚本则只算正文 */ }
	const r = est(resident);
	const f = est(full);
	totResident += r;
	totFull += f;
	console.log(`${fields.name.padEnd(12)} ≈${String(r).padStart(6)} tok      ≈${String(f).padStart(6)} tok     ${(100 * (1 - r / f)).toFixed(1)}%`);
}
console.log("-".repeat(66));
console.log(`合计         ≈${totResident} tok      ≈${totFull} tok      ${(100 * (1 - totResident / totFull)).toFixed(1)}%`);
console.log("\n结论：技能数量不敏感（常驻只随 name+description 增长）；");
console.log("未命中的技能全文一个 token 都不进上下文——这就是分发单元粒度下的渐进披露。");
