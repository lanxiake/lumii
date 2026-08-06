/**
 * MCP Client — Model Context Protocol 客户端
 *
 * 支持 stdio 传输（本地进程）。
 * 用于连接 MCP Server 并获取工具列表。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

/** MCP Server 配置 */
export interface McpServerConfig {
  /** MCP Server 命令 */
  readonly command: string;
  /** 命令参数 */
  readonly args?: readonly string[];
  /** 环境变量 */
  readonly env?: Readonly<Record<string, string>>;
  /** 工作目录 */
  readonly cwd?: string;
}

/** MCP 工具定义 */
export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

/** JSON-RPC 请求 */
interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 响应 */
interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

/** PATH 里按 PATHEXT 补后缀找可执行文件（Windows 的 spawn 不走 shell 时不会自动补） */
function findOnPath(command: string): string | null {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** 从 npx / npm 可执行文件位置推出同级的 npm JS 入口（bin/../node_modules/npm/bin/*.js） */
function npmJsEntry(binPath: string, script: "npx-cli.js" | "npm-cli.js"): string | null {
  const candidate = path.join(path.dirname(binPath), "node_modules", "npm", "bin", script);
  return existsSync(candidate) ? candidate : null;
}

/** spawn 的目标：可执行文件 + 需要前置的参数 */
export interface ResolvedCommand {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

/**
 * 解析 MCP Server 的启动命令
 *
 * npx / npm 优先直接跑 npx-cli.js / npm-cli.js（不走 .cmd，避免弹控制台）。
 * 解释器优先用系统 node.exe；没有再退回 Electron 的 process.execPath +
 * ELECTRON_RUN_AS_NODE。其他命令只做 PATH + PATHEXT 补全。
 */
export function resolveCommand(command: string, execPath = process.execPath): ResolvedCommand {
  const plain = { command, prefixArgs: [] as readonly string[] };

  // 已经是路径或带后缀，用户指定了什么就用什么
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) return plain;
  if (path.extname(command)) return plain;

  const found = findOnPath(command);

  if (command === "npx" || command === "npm") {
    const script = command === "npx" ? "npx-cli.js" : "npm-cli.js";
    // 先从 PATH 上的 npx/npm 旁边找 JS 入口；找不到再看自带 Node 同级的
    const entry =
      (found && npmJsEntry(found, script)) ?? npmJsEntry(execPath, script);
    if (entry) {
      // 优先系统 node.exe：CONSOLE 子系统 + windowsHide 比 Electron GUI 更稳
      const nodeExe = findOnPath("node") ?? execPath;
      return { command: nodeExe, prefixArgs: [entry] };
    }
  }

  return found ? { command: found, prefixArgs: [] } : plain;
}

/** 预加载脚本内容（与 windows-hide-spawn-preload.cjs 同源，写入临时目录以便 asar 内外都能 -r） */
const HIDE_SPAWN_PRELOAD_SOURCE = `"use strict";
(function () {
  if (process.platform !== "win32") return;
  var cp = require("child_process");
  function withHide(options) {
    if (options == null) return { windowsHide: true };
    if (typeof options !== "object") return options;
    return Object.assign({}, options, { windowsHide: true });
  }
  var origSpawn = cp.spawn;
  cp.spawn = function (command, args, options) {
    if (args != null && !Array.isArray(args)) { options = args; args = undefined; }
    return origSpawn.call(this, command, args || [], withHide(options));
  };
  var origSpawnSync = cp.spawnSync;
  cp.spawnSync = function (command, args, options) {
    if (args != null && !Array.isArray(args)) { options = args; args = undefined; }
    return origSpawnSync.call(this, command, args || [], withHide(options));
  };
  var origExecFile = cp.execFile;
  cp.execFile = function (file, args, options, callback) {
    if (typeof args === "function") { callback = args; args = undefined; options = undefined; }
    else if (typeof options === "function") { callback = options; options = undefined; }
    else if (args != null && !Array.isArray(args) && typeof args === "object") { options = args; args = undefined; }
    return origExecFile.call(this, file, args, withHide(options), callback);
  };
  var origExecFileSync = cp.execFileSync;
  cp.execFileSync = function (file, args, options) {
    if (args != null && !Array.isArray(args) && typeof args === "object") { options = args; args = undefined; }
    return origExecFileSync.call(this, file, args, withHide(options));
  };
  var origFork = cp.fork;
  cp.fork = function (modulePath, args, options) {
    if (args != null && !Array.isArray(args) && typeof args === "object") { options = args; args = undefined; }
    return origFork.call(this, modulePath, args, withHide(options));
  };
  var origExec = cp.exec;
  cp.exec = function (command, options, callback) {
    if (typeof options === "function") { callback = options; options = undefined; }
    return origExec.call(this, command, withHide(options), callback);
  };
  var origExecSync = cp.execSync;
  cp.execSync = function (command, options) {
    return origExecSync.call(this, command, withHide(options));
  };
})();
`;

/** 确保 Windows hide-spawn 预加载脚本落盘，返回绝对路径 */
function ensureHideSpawnPreload(): string {
  const dir = path.join(os.tmpdir(), "lumii-mcp");
  const file = path.join(dir, "windows-hide-spawn-preload.cjs");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, HIDE_SPAWN_PRELOAD_SOURCE, "utf8");
  } catch {
    // 写临时目录失败时退回包内文件（开发态）
    try {
      return path.join(path.dirname(fileURLToPath(import.meta.url)), "windows-hide-spawn-preload.cjs");
    } catch {
      return file;
    }
  }
  return file;
}

/**
 * 判断命令是否为 Node/Electron 解释器（可安全注入 -r 预加载）
 */
function isNodeInterpreter(command: string, execPath = process.execPath): boolean {
  const base = path.basename(command).toLowerCase();
  if (base === "node.exe" || base === "node") return true;
  if (command === execPath) return true;
  if (base === "electron.exe" || base === "electron") return true;
  return false;
}

/**
 * Windows 上给 Node 解释器注入 hide-spawn 预加载；.cmd/.bat 改走隐藏的 cmd /d /s /c
 */
function buildSpawnTarget(
  command: string,
  args: readonly string[],
  execPath = process.execPath,
): { command: string; args: string[]; envExtra: Record<string, string> } {
  if (process.platform !== "win32") {
    return { command, args: [...args], envExtra: {} };
  }

  const lower = command.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const comspec = process.env.ComSpec || "cmd.exe";
    const quoted = [command, ...args]
      .map((a) => `"${String(a).replace(/"/g, '\\"')}"`)
      .join(" ");
    return {
      command: comspec,
      args: ["/d", "/s", "/c", quoted],
      envExtra: {},
    };
  }

  if (isNodeInterpreter(command, execPath)) {
    const preload = ensureHideSpawnPreload();
    return {
      command,
      args: ["-r", preload, ...args],
      envExtra: command === execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {},
    };
  }

  return { command, args: [...args], envExtra: {} };
}

/**
 * MCP stdio 客户端
 *
 * 通过 stdio 与 MCP Server 进程通信（JSON-RPC 2.0 over stdin/stdout）。
 */
export class McpStdioClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private _initialized = false;
  private _instructions?: string;

  constructor(private readonly config: McpServerConfig) {
    super();
  }

  get initialized(): boolean {
    return this._initialized;
  }

  /** 获取服务器提供的说明文档（如果有） */
  getInstructions(): string | undefined {
    return this._instructions;
  }

  /** 启动 MCP Server 进程并初始化 */
  async start(): Promise<void> {
    if (this.process) return;

    const { command, prefixArgs } = resolveCommand(this.config.command);
    const target = buildSpawnTarget(
      command,
      [...prefixArgs, ...(this.config.args ?? [])],
    );
    const usingBundledNode =
      target.command === process.execPath || Boolean(target.envExtra.ELECTRON_RUN_AS_NODE);
    /** 握手前累计的 stderr，失败时拼进错误信息 */
    let stderrBuf = "";

    this.process = spawn(target.command, target.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // 让 Electron 的 execPath 当纯 Node 用，否则会又起一个应用窗口
        ...(usingBundledNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        ...target.envExtra,
        ...this.config.env,
      },
      cwd: this.config.cwd,
      // Windows 上不隐藏控制台会弹出大量黑窗口（npx/node 子进程尤其明显）
      windowsHide: true,
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error("Failed to create stdio pipes for MCP server process");
    }

    this.process.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    /**
     * spawn 失败（命令不存在、没有执行权限）会走 error 事件
     *
     * 必须在 await 握手前就挂上：ChildProcess 的 error 没有监听者时会抛成
     * 未捕获异常直接崩主进程，而 stdin 已经断开，握手只会等到 EPIPE 或超时。
     */
    const spawnFailed = new Promise<never>((_, reject) => {
      this.process?.once("error", (err: Error) => {
        reject(new Error(`启动 MCP Server 失败（${this.config.command}）：${err.message}`));
      });
    });

    /** 握手完成前进程退出时带上 stderr，便于 UI 展示真实原因 */
    const exitedEarly = new Promise<never>((_, reject) => {
      this.process?.once("exit", (code) => {
        if (this._initialized) return;
        const detail = stderrBuf.trim();
        reject(
          new Error(
            detail
              ? `MCP Server 进程提前退出（code=${code}）：${detail.slice(0, 500)}`
              : `MCP Server 进程提前退出（code=${code}）`,
          ),
        );
      });
    });

    // 逐行读取 stdout（每行一个 JSON-RPC 消息）
    this.readline = createInterface({ input: this.process.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    this.process.on("exit", (code) => {
      this.emit("exit", code);
      this.cleanup();
    });

    this.process.on("error", (err) => {
      // EventEmitter 的 "error" 没有监听者时会抛出，转发前先确认有人接
      if (this.listenerCount("error") > 0) this.emit("error", err);
      this.cleanup();
    });

    // 初始化握手；spawn 失败 / 提前退出时不必等握手超时
    let initResult: unknown;
    try {
      initResult = await Promise.race([
        this.sendRequest("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mtbot-agent-runtime", version: "0.1.0" },
        }),
        spawnFailed,
        exitedEarly,
      ]);
    } catch (err) {
      const detail = stderrBuf.trim();
      if (detail && err instanceof Error && !err.message.includes(detail.slice(0, 80))) {
        throw new Error(`${err.message}\n${detail.slice(0, 500)}`);
      }
      throw err;
    }

    // 提取服务器说明（如果有）
    const typed = initResult as { serverInfo?: { instructions?: string } } | null;
    if (typed?.serverInfo?.instructions) {
      this._instructions = typed.serverInfo.instructions;
    }

    // 发送 initialized 通知
    this.sendNotification("notifications/initialized", {});
    this._initialized = true;
  }

  /** 获取 MCP Server 暴露的工具列表 */
  async listTools(): Promise<readonly McpToolDefinition[]> {
    const result = (await this.sendRequest("tools/list", {})) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  /** 调用 MCP 工具 */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.sendRequest("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    return result;
  }

  /** 停止 MCP Server 进程 */
  async stop(): Promise<void> {
    if (!this.process) return;

    try {
      this.sendNotification("notifications/cancelled", {});
    } catch {
      // 忽略
    }

    this.process.kill();
    this.cleanup();
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const settle = (fn: typeof resolve | typeof reject, value: unknown) => {
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          fn(value);
        }
      };

      // 超时定时器 — 在 settle 时清除，避免泄漏
      const timer = setTimeout(() => {
        settle(reject, new Error(`MCP request timeout: ${method}`));
      }, 30000);

      this.pending.set(id, {
        resolve: (v) => settle(resolve, v),
        reject: (e) => settle(reject, e),
        timer,
      });

      const line = JSON.stringify(request) + "\n";
      this.process?.stdin?.write(line, (err) => {
        if (err) {
          settle(reject, err);
        }
      });
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const notification = {
      jsonrpc: "2.0" as const,
      method,
      params,
    };
    this.process?.stdin?.write(JSON.stringify(notification) + "\n");
  }

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)!;
        if (msg.error) {
          entry.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          entry.resolve(msg.result);
        }
      }
    } catch {
      // 非 JSON 行（如 stderr 泄漏到 stdout），忽略
    }
  }

  private cleanup(): void {
    this.readline?.close();
    this.readline = null;
    this.process = null;
    this._initialized = false;

    // 收集所有待处理请求后清空，避免迭代中删除
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(new Error("MCP server process terminated"));
    }
  }
}
