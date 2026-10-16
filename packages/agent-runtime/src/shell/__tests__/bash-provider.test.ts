import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { BashProvider, gitRootFromRegistry } from "../bash-provider.js";
import { CmdProvider } from "../cmd-provider.js";

/**
 * 注册表那条探测：装到**自定义目录**的 Git 全靠它（硬编码清单会全落空、PATH 上又没有）。
 * 本机就是这种（`C:\myself\dev-soft\Git`），代价是 bash 工具**静默**退化成 cmd.exe。
 *
 * ⚠️ 判据取"注册表说的那个根目录"，不是写死的 `C:\Program Files\Git` —— 后者只在
 * 装了默认位置的那台机器上为真，换一台就假绿。
 */

/** `reg query` 的真实输出长相（前导空行 + 多个空格分隔）。 */
const REAL_SHAPE = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\r\n" +
  "    InstallPath    REG_SZ    C:\\myself\\dev-soft\\Git\r\n\r\n";

describe("gitRootFromRegistry", () => {
  it("从 reg query 的输出里解析出安装根目录", () => {
    expect(gitRootFromRegistry(() => REAL_SHAPE)).toBe("C:\\myself\\dev-soft\\Git");
  });

  it("第一个键没装 → 落到下一个键（用户级那份）", () => {
    const seen: string[] = [];
    const r = gitRootFromRegistry((k) => {
      seen.push(k);
      if (seen.length === 1) {
        throw new Error("reg: 系统找不到指定的注册表项或值。");
      }
      return "    InstallPath    REG_SZ    D:\\Git\r\n";
    });
    expect(r).toBe("D:\\Git");
    expect(seen[1]).toBe("HKCU\\SOFTWARE\\GitForWindows");
  });

  it("一个键都没有 → null（不抛：这台机器就是没装 Git）", () => {
    expect(gitRootFromRegistry(() => {
      throw new Error("nope");
    })).toBeNull();
  });

  it("有键但没写出路径 → null（不当成根目录用）", () => {
    expect(gitRootFromRegistry(() => "InstallPath    REG_SZ\r\n")).toBeNull();
  });
});

describe("BashProvider 真机探测", () => {
  // ⚠️ 这台机器没装 Git 时**响亮跳过**（汇总里看得见），而不是把断言跳过掉当通过。
  const regRoot = gitRootFromRegistry();
  const hasGit = Boolean(regRoot);

  it.skipIf(!hasGit)("注册表里那个根目录底下确实有 bash.exe（探测才有意义）", () => {
    expect(existsSync(`${regRoot}\\bin\\bash.exe`) ||
      existsSync(`${regRoot}\\usr\\bin\\bash.exe`)).toBe(true);
  });

  it.skipIf(!hasGit)("BashProvider 解析出的就是它 —— 而不是退化成 cmd", () => {
    const r = new BashProvider().resolve();
    expect(r).toBeTruthy();
    // 硬编码清单里没有这个目录（否则本文件说的那个 bug 就不存在了）—— 这条同时是
    // "探测确实走了注册表那条路"的判据。
    expect(r!.toLowerCase().startsWith(regRoot!.toLowerCase())).toBe(true);
    expect(r!.toLowerCase()).toContain("bash.exe");
    expect(new CmdProvider().resolve()).toBeTruthy(); // 降级路仍然在
  });

  // ⚠️ **这一条才是真的**。上面那条在本机是**不够的**：这个测试进程的 PATH 里有 Git
  // （开发终端加的），于是 `where bash.exe` 也能找到 —— 把注册表那段删掉它照样绿。
  // 客户端是**从资源管理器起**的，PATH 上没有 Git，`where` 那条路必死。
  // 所以这里把 PATH 剥成只剩 System32，复现客户端那个环境。
  it.skipIf(!hasGit)("PATH 上没有 Git 时也找得到（客户端就是这种环境）", async () => {
    const savedPath = process.env.Path;
    const savedPATH = process.env.PATH;
    try {
      process.env.Path = "C:\\Windows\\System32;C:\\Windows";
      process.env.PATH = process.env.Path;
      // 模块里有 memo（`cachedBashPath`），不清模块就是拿上一次的结果——那样这条也是假的
      vi.resetModules();
      const fresh = await import("../bash-provider.js");
      const r = new fresh.BashProvider().resolve();
      expect(r?.toLowerCase().startsWith(regRoot!.toLowerCase())).toBe(true);
    } finally {
      process.env.Path = savedPath;
      process.env.PATH = savedPATH;
      vi.resetModules();
    }
  });

  it("真机跑一条真命令（补上「解析得出来、却跑不起来」那一格）", () => {
    const r = new BashProvider().resolve();
    if (!r) {
      return; // 这台机器没 bash：上面两条已经响亮跳过，这里不该再假装验过
    }
    const out = execFileSync(r, ["-c", "echo bash-ok"], { encoding: "utf-8" });
    expect(out.trim()).toBe("bash-ok");
  });
});
