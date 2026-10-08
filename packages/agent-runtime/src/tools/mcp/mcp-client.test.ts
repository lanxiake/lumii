import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  describeEarlyExit,
  listWellKnownCliBinDirs,
  McpStdioClient,
  resolveCommand,
  resolveMcpRequestTimeoutMs,
} from "./mcp-client";

describe("describeEarlyExit", () => {
  it("9009 + python：说明命令未找到并提示 Store 占位程序", () => {
    const message = describeEarlyExit(9009, "python", "");
    expect(message).toContain("找不到可执行的命令「python」");
    expect(message).toContain("code=9009");
    expect(message).toContain("Microsoft Store");
    expect(message).not.toContain("进程提前退出");
  });

  it("127 + 其他命令：说明命令未找到，不误导到 Store", () => {
    const message = describeEarlyExit(127, "foo-mcp", "sh: foo-mcp: not found");
    expect(message).toContain("找不到可执行的命令「foo-mcp」");
    expect(message).not.toContain("Microsoft Store");
    expect(message).toContain("not found");
  });

  it("其他退出码保留原文案并带上 stderr", () => {
    expect(describeEarlyExit(1, "node", "boom\n")).toBe("MCP Server 进程提前退出（code=1）：boom");
    expect(describeEarlyExit(null, "node", "")).toBe("MCP Server 进程提前退出（code=null）");
  });
});

describe("resolveCommand", () => {
  it("npx 直接跑 npx-cli.js，优先系统 node", () => {
    const fakeExec = process.execPath;
    const { command, prefixArgs } = resolveCommand("npx", fakeExec);

    // 本机装了 Node 就一定能找到 npx-cli.js；找不到时才允许退回可执行文件
    if (prefixArgs.length > 0) {
      expect(path.basename(prefixArgs[0]!)).toBe("npx-cli.js");
      expect(existsSync(prefixArgs[0]!)).toBe(true);
      // 有系统 node 时用 node.exe，否则退回传入的 execPath
      const nodeFromPath = existsSync(command) && path.basename(command).toLowerCase().startsWith("node");
      expect(nodeFromPath || command === fakeExec).toBe(true);
    } else {
      expect(command).toMatch(/npx/);
    }
  });

  it("npm 同理走 npm-cli.js", () => {
    const { prefixArgs } = resolveCommand("npm");
    if (prefixArgs.length > 0) expect(path.basename(prefixArgs[0]!)).toBe("npm-cli.js");
  });

  it("已带路径或后缀的命令原样返回，不加前置参数", () => {
    for (const cmd of ["C:/tools/foo.exe", "./run.sh", "foo.cmd"]) {
      expect(resolveCommand(cmd)).toEqual({ command: cmd, prefixArgs: [] });
    }
  });

  it("找不到的命令原样返回，交给 spawn 报错", () => {
    expect(resolveCommand("lumii-no-such-command-xyz")).toEqual({
      command: "lumii-no-such-command-xyz",
      prefixArgs: [],
    });
  });

  it("PATH 上的普通命令解析成绝对路径", () => {
    const { command, prefixArgs } = resolveCommand("node");
    expect(prefixArgs).toEqual([]);
    expect(path.isAbsolute(command)).toBe(true);
  });

  it("PATH 没有时仍能从 well-known extraDirs 解析（uv 装在 ~/.local/bin）", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lumii-mcp-cli-"));
    const stem = "lumii-fake-uvx";
    const fileName = process.platform === "win32" ? `${stem}.exe` : stem;
    writeFileSync(path.join(dir, fileName), "");
    const { command, prefixArgs } = resolveCommand(stem, process.execPath, [dir]);
    expect(prefixArgs).toEqual([]);
    expect(path.basename(command).toLowerCase()).toBe(fileName.toLowerCase());
    expect(path.dirname(command)).toBe(dir);
  });

  it("well-known CLI 目录包含用户 .local/bin", () => {
    expect(listWellKnownCliBinDirs()).toContain(path.join(os.homedir(), ".local", "bin"));
  });
});

describe("resolveMcpRequestTimeoutMs", () => {
  it("不传/非法值回退默认 30s", () => {
    expect(DEFAULT_MCP_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(resolveMcpRequestTimeoutMs(undefined)).toBe(30_000);
    expect(resolveMcpRequestTimeoutMs(0)).toBe(30_000);
    expect(resolveMcpRequestTimeoutMs(-5)).toBe(30_000);
    expect(resolveMcpRequestTimeoutMs(Number.NaN)).toBe(30_000);
  });

  it("正数原样返回（长任务 Server 调大）", () => {
    expect(resolveMcpRequestTimeoutMs(360_000)).toBe(360_000);
  });
});

describe("McpStdioClient", () => {
  it("命令不存在时 reject，不抛未捕获异常", async () => {
    const client = new McpStdioClient({ command: "lumii-no-such-command-xyz" });
    await expect(client.start()).rejects.toThrow(/启动 MCP Server 失败/);
  });

  it("按配置的 requestTimeoutMs 超时（不再固定 30s）", async () => {
    // 桩服务：握手后永不响应 initialize，只能靠本地超时收场
    const client = new McpStdioClient({
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"],
      requestTimeoutMs: 250,
    });
    const startedAt = Date.now();
    try {
      await expect(client.start()).rejects.toThrow(/timeout/i);
      // 明显小于默认 30s，证明用了配置值
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      await client.stop().catch(() => {});
    }
  });
});
