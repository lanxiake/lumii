// wordcount.mjs — SKILL.md 的支持脚本（技能正文可指示模型运行它）
import { readFileSync } from "node:fs";
const text = process.argv[2] ? readFileSync(process.argv[2], "utf8") : "";
const words = text.trim().split(/\s+/).filter(Boolean).length;
console.log(`words=${words} chars=${text.length} lines=${text.split("\n").length}`);
