/**
 * BashProvider — Git Bash / POSIX bash 提供者（主题4 P1）
 *
 * Windows：探测 Git Bash（消灭 cp/mv/grep/中文路径转义试错），探测顺序：
 *   常见安装目录 → **注册表** → `where bash.exe`（剔除 System32 的 WSL 占位）。
 * 非 Windows：直接用 /bin/bash。
 *
 * ⚠️ 注册表那一条不是锦上添花，它是**装到自定义目录时的唯一活路**：本机 Git 在
 * `C:\myself\dev-soft\Git`，硬编码清单五条全落空，而 Git 又**不在 PATH 上**
 * ⇒ `where bash.exe` 也找不到 ⇒ 整个 "bash everywhere" 静默退化成 cmd.exe。
 * 代价实测（2026-10-16 那份 28MB 主日志）：一天 1308 次 bash 调用里 187 次失败，
 * 失败榜前三名全是 POSIX-vs-cmd：`node -e` 引号炸掉 ×23、`ls`/`pwd`/`export`
 * 「不是内部或外部命令」×7、heredoc `<<` / 未加引号的括号；Agent 们甚至在交接笔记里
 * 把「本机是 cmd.exe，禁 node -e / heredoc」抄了下来传给下一棒。
 * 而 Windows 上**唯一与 PATH 无关**的 Git 位置记录就是这条注册表值（Git for Windows
 * 安装时自己写的）。
 *
 * 探测结果 memoize，避免每条命令重复磁盘/进程探测。
 * 从 apps/windows local-bash.ts 的 resolveGitBashPath 抽出，逻辑一致。
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ShellProvider } from "./shell-provider.js";

const isWindows = process.platform === "win32";

let cachedBashPath: string | null | undefined;

/** Git for Windows 安装时自己写的三个位置（64 位 / 用户级 / 32 位）。 */
const GIT_REG_KEYS = [
  "HKLM\\SOFTWARE\\GitForWindows",
  "HKCU\\SOFTWARE\\GitForWindows",
  "HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows",
];

/**
 * 从注册表问出 Git 的安装根目录。
 *
 * `run` 是**给测试留的缝**：`vi.mock("node:child_process")` 对 SUT 内部 import 不生效
 * （本仓踩过），所以把唯一的副作用做成可注入的。
 *
 * @returns 安装根目录（如 `C:\myself\dev-soft\Git`），问不出来则 null（**不抛**）。
 */
export function gitRootFromRegistry(
  run: (key: string) => string = (key) =>
    execFileSync("reg", ["query", key, "/v", "InstallPath"], {
      encoding: "utf-8",
      windowsHide: true,
    }),
): string | null {
  for (const key of GIT_REG_KEYS) {
    let out: string;
    try {
      out = run(key);
    } catch {
      continue; // 这个键没有（没装 / 装的是别的那个位数）—— 试下一个
    }
    // 输出形如 `    InstallPath    REG_SZ    C:\...\Git\r\n`
    const root = out.match(/InstallPath\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
    if (root) {
      return root;
    }
  }
  return null;
}

/** 从 Git 根目录推出 bash.exe（`bin\` 与 `usr\bin\` 两种布局都见过）。 */
function bashIn(root: string): string | null {
  for (const rel of ["\\bin\\bash.exe", "\\usr\\bin\\bash.exe"]) {
    if (existsSync(root + rel)) {
      return root + rel;
    }
  }
  return null;
}

function resolveBashPath(): string | null {
  if (cachedBashPath !== undefined) {
    return cachedBashPath;
  }

  if (!isWindows) {
    cachedBashPath = "/bin/bash";
    return cachedBashPath;
  }

  const candidates = [
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Git\\bin\\bash.exe`,
    process.env["ProgramFiles(x86)"] &&
      `${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "D:\\develop\\Git\\bin\\bash.exe",
    "D:\\develop\\Git\\usr\\bin\\bash.exe",
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBashPath = candidate;
      return candidate;
    }
  }

  // 注册表：**唯一与 PATH 无关**的 Git 位置（自定义安装目录时全靠它，见文件头注释）
  const regRoot = gitRootFromRegistry();
  if (regRoot) {
    const viaReg = bashIn(regRoot);
    if (viaReg) {
      cachedBashPath = viaReg;
      return viaReg;
    }
  }

  // 兜底：从 PATH 解析 bash.exe，排除 System32 下的 WSL 启动器（非 Git Bash）
  try {
    const out = execFileSync("where", ["bash.exe"], { encoding: "utf-8" });
    const found = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .find((p) => !/\\System32\\/i.test(p) && !/WindowsApps/i.test(p));
    if (found && existsSync(found)) {
      cachedBashPath = found;
      return found;
    }
  } catch {
    // where 不可用或未找到
  }

  cachedBashPath = null;
  return null;
}

export class BashProvider implements ShellProvider {
  readonly kind = "bash" as const;
  readonly encoding = "utf-8" as const;

  resolve(): string | null {
    return resolveBashPath();
  }

  buildArgs(command: string): string[] {
    return ["-c", command];
  }
}
