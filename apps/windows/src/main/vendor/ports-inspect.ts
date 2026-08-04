/**
 * 端口占用探测（灵栖/Lumii 独立版精简实现）。
 *
 * 原 gateway 版本依赖 lsof / globals / logger 等跨平台链路；本客户端仅在 Windows
 * 运行，故用 node:net 探测 + `netstat`/`tasklist` 解析占用进程，零内部依赖。
 */
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PortListener = {
  pid?: number;
  command?: string;
  commandLine?: string;
  user?: string;
  address?: string;
};

export type PortUsageStatus = "free" | "busy" | "unknown";

export type PortUsage = {
  port: number;
  status: PortUsageStatus;
  listeners: PortListener[];
  hints: string[];
  detail?: string;
  errors?: string[];
};

/** 用 node:net 尝试监听端口，成功即空闲。 */
function probeFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

/** 解析 netstat 输出，收集监听该端口的 PID。 */
async function findListeners(port: number): Promise<PortListener[]> {
  const listeners: PortListener[] = [];
  const seen = new Set<number>();
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const cols = line.trim().split(/\s+/);
      // Proto  Local            Foreign          State       PID
      const local = cols[1] ?? "";
      if (!local.endsWith(`:${port}`)) continue;
      const pid = Number(cols[cols.length - 1]);
      if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
      seen.add(pid);
      listeners.push({ pid, address: local, commandLine: await resolveCommandLine(pid) });
    }
  } catch {
    // netstat 不可用时返回空列表，由调用方按 unknown 处理
  }
  return listeners;
}

/** 用 tasklist 拿到进程命令行（失败返回 undefined）。 */
async function resolveCommandLine(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "wmic",
      ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const match = stdout.match(/CommandLine=(.*)/);
    const cmd = match?.[1]?.trim();
    return cmd || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 探测端口占用状态。free = 可绑定；busy = 有监听进程；unknown = 探测失败。
 */
export async function inspectPortUsage(port: number): Promise<PortUsage> {
  const errors: string[] = [];
  let free: boolean;
  try {
    free = await probeFree(port);
  } catch (err) {
    errors.push(`probe failed: ${String(err)}`);
    return { port, status: "unknown", listeners: [], hints: [], errors };
  }

  if (free) {
    return { port, status: "free", listeners: [], hints: [] };
  }

  const listeners = await findListeners(port);
  return {
    port,
    status: "busy",
    listeners,
    hints: listeners.length ? [] : [`端口 ${port} 被占用，但未能解析监听进程`],
    errors: errors.length ? errors : undefined,
  };
}
