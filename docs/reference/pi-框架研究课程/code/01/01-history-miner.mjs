#!/usr/bin/env node
// 01-history-miner.mjs — 对本地 pi 仓库克隆做 git 考古
// 零依赖，Node >= 20。用法：node 01-history-miner.mjs [仓库路径]
// 默认仓库路径为课程研究用的本地克隆；也可传入任意 pi 克隆。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_REPO =
  "C:/Users/75791/.lumii/workspace/temp/pi-course-research/pi";
const repo = resolve(process.argv[2] ?? DEFAULT_REPO);

function die(msg) {
  console.error(`[错误] ${msg}`);
  console.error("");
  console.error("本实验需要一个 pi 仓库的本地克隆（只读即可）。克隆方法：");
  console.error(`  git clone --filter=blob:none https://github.com/earendil-works/pi "${repo}"`);
  console.error("然后把路径作为参数传入：node 01-history-miner.mjs /path/to/pi");
  process.exit(1);
}

if (!existsSync(repo)) die(`路径不存在：${repo}`);
const git = (args) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
try {
  git(["rev-parse", "--git-dir"]);
} catch {
  die(`不是一个 git 仓库：${repo}`);
}

const line = (ch = "-", n = 62) => console.error(ch.repeat(n));

// ---- 1. 总览 ----
const total = +git(["rev-list", "--count", "HEAD"]).trim();
const first = git(["log", "--reverse", "--format=%ad %h %s", "--date=short"])
  .split("\n")[0];
const last = git(["log", "-1", "--format=%ad %h %s", "--date=short"]).trim();
const tags = +git(["tag"]).split("\n").filter(Boolean).length;

line("=");
console.error(`仓库：${repo}`);
console.error(`总提交数：${total}    tag 数：${tags}`);
console.error(`首次提交：${first}`);
console.error(`最新提交：${last}`);

// ---- 2. 月度提交分布 ----
line();
console.error("月度提交数：");
const months = new Map();
for (const d of git(["log", "--format=%ad", "--date=format:%Y-%m"]).split("\n"))
  if (d.trim()) months.set(d, (months.get(d) ?? 0) + 1);
const maxMonth = Math.max(...months.values());
for (const [m, n] of [...months.entries()].sort()) {
  const bar = "#".repeat(Math.round((n / maxMonth) * 40));
  console.error(`  ${m}  ${String(n).padStart(4)}  ${bar}`);
}

// ---- 3. 各 packages/* 首次出现 ----
line();
console.error("各包首次出现的提交（目录首次进入历史的时间）：");
const pkgDir = (name) =>
  git(["log", "--reverse", "--format=%ad %h %s", "--date=short", `--`, `packages/${name}`])
    .split("\n")[0] ?? "(无)";
const dirs = [
  ...new Set(
    git(["ls-files", "packages/"])
      .split("\n")
      .map((f) => f.split("/")[1])
      .filter(Boolean)
  ),
].sort();
for (const name of dirs) console.error(`  ${name.padEnd(16)} ${pkgDir(name)}`);

// ---- 4. commit 主题词频 top20 ----
line();
console.error("commit 主题词频 top20（去掉 conventional-commit 前缀与停用词）：");
const STOP = new Set(
  ("the and for to in of a an with on from by is are as at that this it its be when not " +
    "add adds added fix fixes fixed update updates updated use using used new all more " +
    "support supports some into their them they we you your or if then than so such " +
    "agent ai coding pi packages package commit first second also can could would will " +
    "have has had was were been being do does done only just now here there what which " +
    "merge release unreleased changelog closes pull push tag tags version bump").split(" ")
);
const counts = new Map();
for (const subj of git(["log", "--format=%s"]).split("\n")) {
  const clean = subj
    .toLowerCase()
    .replace(/^\w+(\([^)]*\))?!?:\s*/, "") // feat:/fix(x): 前缀
    .replace(/[^a-z0-9 ]+/g, " ");
  for (const w of clean.split(" "))
    if (w.length > 2 && !STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
}
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
for (const [w, n] of top) console.error(`  ${String(n).padStart(4)}  ${w}`);
line("=");
