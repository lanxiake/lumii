/**
 * MCP Client — Model Context Protocol 客户端
 *
 * 支持 stdio 传输（本地进程）。
 * 用于连接 MCP Server 并获取工具列表。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";

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
 * npx / npm 优先用**客户端自带的 Node**（Electron 的 process.execPath 配
 * ELECTRON_RUN_AS_NODE）直接跑 npx-cli.js，这样用户机器上没装 Node 也能拉包，
 * 也绕开了 Windows 上 .cmd 找不到的问题。找不到 npm 的 JS 入口时退回 PATH 查找。
 *
 * 其他命令只做 PATH + PATHEXT 补全，不改语义。
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
    if (entry) return { command: execPath, prefixArgs: [entry] };
  }

  return found ? { command: found, prefixArgs: [] } : plain;
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
    const usingBundledNode = command === process.execPath;

    this.process = spawn(command, [...prefixArgs, ...(this.config.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // 让 Electron 的 execPath 当纯 Node 用，否则会又起一个应用窗口
        ...(usingBundledNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        ...this.config.env,
      },
      cwd: this.config.cwd,
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error("Failed to create stdio pipes for MCP server process");
    }

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

    // 初始化握手；spawn 失败时直接以 spawnFailed 的错误结束，不必等握手超时
    const initResult = (await Promise.race([
      this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mtbot-agent-runtime", version: "0.1.0" },
      }),
      spawnFailed,
    ])) as any;

    // 提取服务器说明（如果有）
    if (initResult?.serverInfo?.instructions) {
      this._instructions = initResult.serverInfo.instructions;
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
