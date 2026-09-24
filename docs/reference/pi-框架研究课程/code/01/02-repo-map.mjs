#!/usr/bin/env node
// 02-repo-map.mjs — 扫描 pi monorepo 的 packages/，输出包大小、内部依赖与分层
// 零依赖，Node >= 20。用法：node 02-repo-map.mjs [仓库路径]
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_REPO =
  "C:/Users/75791/.lumii/workspace/temp/pi-course-research/pi";
const repo = resolve(process.argv[2] ?? DEFAULT_REPO);
if (!existsSync(join(repo, "packages"))) {
  console.error(`[错误] 在 ${repo} 下找不到 packages/ 目录。`);
  console.error("请先克隆：git clone --filter=blob:none https://github.com/earendil-works/pi");
  process.exit(1);
}

// 递归统计 src/ 下的 TypeScript 源文件数与字节数
function srcStats(dir) {
  let files = 0,
    bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const s = srcStats(p);
      files += s.files;
      bytes += s.bytes;
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      files++;
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}

// 收集包：packages/*/ 与 packages/*/*/（如 session-backends/sqlite-node）
const pkgs = [];
for (const d1 of readdirSync(join(repo, "packages"), { withFileTypes: true })) {
  if (!d1.isDirectory()) continue;
  const p1 = join(repo, "packages", d1.name);
  const add = (dir, label) => {
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) return;
    const j = JSON.parse(readFileSync(pj, "utf8"));
    const deps = { ...j.dependencies, ...j.peerDependencies };
    const internal = Object.keys(deps)
      .filter((k) => k.startsWith("@earendil-works/"))
      .map((k) => k.replace("@earendil-works/", ""));
    const external = Object.keys(deps).length - internal.length;
    const s = srcStats(join(dir, "src"));
    pkgs.push({ label, name: j.name.replace("@earendil-works/", ""), internal, external, ...s });
  };
  add(p1, d1.name);
  for (const d2 of readdirSync(p1, { withFileTypes: true }))
    if (d2.isDirectory()) add(join(p1, d2.name), `${d1.name}/${d2.name}`);
}

// 按内部依赖做拓扑分层：layer = 1 + max(layer of deps)
const byName = new Map(pkgs.map((p) => [p.name, p]));
function layer(p, seen = new Set()) {
  if (p._layer !== undefined) return p._layer;
  if (seen.has(p.name)) return 0; // 防环
  seen.add(p.name);
  const deps = p.internal.map((n) => byName.get(n)).filter(Boolean);
  p._layer = deps.length ? 1 + Math.max(...deps.map((d) => layer(d, seen))) : 0;
  return p._layer;
}
for (const p of pkgs) layer(p);

const kb = (b) => (b / 1024).toFixed(0).padStart(6) + " KB";
console.log("包名".padEnd(34) + "src TS".padStart(8) + "  src 体量  层  内部依赖 -> 外部依赖数");
"-".repeat(100);
for (const p of [...pkgs].sort((a, b) => a._layer - b._layer || b.bytes - a.bytes)) {
  console.log(
    p.label.padEnd(34) + String(p.files).padStart(6) + "  " + kb(p.bytes) + "   " +
      p._layer + "   [" + (p.internal.join(", ") || "无") + "] -> " + p.external
  );
}
console.log("");
console.log("分层解读：层 0 = 不依赖任何 Pi 包（可独立复用）；层 N = 依赖层 < N 的包。");
console.log("注意 chord 在层 0 —— 它是独立的应用组合运行时，不依赖任何其它 Pi 包。");
