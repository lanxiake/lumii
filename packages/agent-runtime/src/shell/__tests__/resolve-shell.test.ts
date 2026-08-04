import { describe, it, expect } from "vitest";
import { resolveShell } from "../resolve-shell.js";
import { BashProvider } from "../bash-provider.js";
import { PowerShellProvider } from "../powershell-provider.js";
import { CmdProvider } from "../cmd-provider.js";

describe("providers buildArgs/encoding", () => {
  it("BashProvider: -c command, utf-8", () => {
    const p = new BashProvider();
    expect(p.kind).toBe("bash");
    expect(p.encoding).toBe("utf-8");
    expect(p.buildArgs("ls -la")).toEqual(["-c", "ls -la"]);
  });

  it("PowerShellProvider: -NoProfile -Command, utf-8", () => {
    const p = new PowerShellProvider();
    expect(p.kind).toBe("powershell");
    expect(p.encoding).toBe("utf-8");
    expect(p.buildArgs("Get-Item")).toEqual(["-NoProfile", "-Command", "Get-Item"]);
  });

  it("CmdProvider: /c command, cp936", () => {
    const p = new CmdProvider();
    expect(p.kind).toBe("cmd");
    expect(p.encoding).toBe("cp936");
    expect(p.buildArgs("dir")).toEqual(["/c", "dir"]);
  });
});

describe("resolveShell", () => {
  it("显式 shell → 跳过探测，按 bash 语义构造", () => {
    const r = resolveShell({ command: "echo hi", explicitShell: "/custom/sh" });
    expect(r.shellPath).toBe("/custom/sh");
    expect(r.args).toEqual(["-c", "echo hi"]);
    expect(r.encoding).toBe("utf-8");
    expect(r.kind).toBe("bash");
    expect(r.isCmdFallback).toBe(false);
  });

  it("默认偏好 bash → 解析出可执行 shell 并带 -c", () => {
    const r = resolveShell({ command: "ls" });
    // 无论 bash 命中还是 cmd 降级，命令都被正确包裹
    expect(r.shellPath).toBeTruthy();
    if (r.kind === "bash") {
      expect(r.args).toEqual(["-c", "ls"]);
      expect(r.encoding).toBe("utf-8");
    } else {
      // Windows 上无 bash → cmd 降级
      expect(r.kind).toBe("cmd");
      expect(r.args).toEqual(["/c", "ls"]);
      expect(r.encoding).toBe("cp936");
      expect(r.isCmdFallback).toBe(true);
    }
  });
});
