/**
 * MCP Client — Model Context Protocol 客户端
 *
 * 支持 stdio 传输（本地进程）。
 * 用于连接 MCP Server 并获取工具列表。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
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

    this.process = spawn(this.config.command, [...(this.config.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
      cwd: this.config.cwd,
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error("Failed to create stdio pipes for MCP server process");
    }

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
      this.emit("error", err);
      this.cleanup();
    });

    // 初始化握手
    const initResult = (await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mtbot-agent-runtime", version: "0.1.0" },
    })) as any;

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
