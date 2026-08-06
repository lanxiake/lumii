import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpStdioClient, resolveCommand } from "./mcp-client";

describe("resolveCommand", () => {
  it("npx 交给自带 Node 跑 npx-cli.js，不依赖系统 npx 可执行文件", () => {
    const fakeExec = process.execPath;
    const { command, prefixArgs } = resolveCommand("npx", fakeExec);

    // 本机装了 Node 就一定能找到 npx-cli.js；找不到时才允许退回可执行文件
    if (prefixArgs.length > 0) {
      expect(path.basename(prefixArgs[0]!)).toBe("npx-cli.js");
      expect(existsSync(prefixArgs[0]!)).toBe(true);
      expect(command).toBe(fakeExec);
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
});

describe("McpStdioClient", () => {
  it("命令不存在时 reject，不抛未捕获异常", async () => {
    const client = new McpStdioClient({ command: "lumii-no-such-command-xyz" });
    await expect(client.start()).rejects.toThrow(/启动 MCP Server 失败/);
  });
});
