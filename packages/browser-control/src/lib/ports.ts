import net from "node:net";
import { formatPortDiagnostics } from "./ports-format.js";
import { inspectPortUsage } from "./ports-inspect.js";
import type { PortListener, PortListenerKind, PortUsage, PortUsageStatus } from "./ports-types.js";

class PortInUseError extends Error {
  port: number;
  details?: string;

  constructor(port: number, details?: string) {
    super(`Port ${port} is already in use.`);
    this.name = "PortInUseError";
    this.port = port;
    this.details = details;
  }
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === "object" && "code" in err);
}

export async function describePortOwner(port: number): Promise<string | undefined> {
  const diagnostics = await inspectPortUsage(port);
  if (diagnostics.listeners.length === 0) {
    return undefined;
  }
  return formatPortDiagnostics(diagnostics).join("\n");
}

export async function ensurePortAvailable(port: number): Promise<void> {
  // Detect EADDRINUSE early with a friendly message.
  try {
    await new Promise<void>((resolve, reject) => {
      const tester = net
        .createServer()
        .once("error", (err) => reject(err))
        .once("listening", () => {
          tester.close(() => resolve());
        })
        .listen(port);
    });
  } catch (err) {
    if (isErrno(err) && err.code === "EADDRINUSE") {
      const details = await describePortOwner(port);
      throw new PortInUseError(port, details);
    }
    throw err;
  }
}

export async function handlePortError(err: unknown, port: number, context: string): Promise<never> {
  if (err instanceof PortInUseError || (isErrno(err) && err.code === "EADDRINUSE")) {
    const details = err instanceof PortInUseError ? err.details : await describePortOwner(port);
    console.error(`${context} failed: port ${port} is already in use.`);
    if (details) {
      console.error("Port listener details:");
      console.error(details);
    }
    console.error("Resolve by stopping the process using the port or passing --port <free-port>.");
    process.exit(1);
  }
  console.error(`${context} failed: ${String(err)}`);
  const stdout = (err as { stdout?: string })?.stdout;
  const stderr = (err as { stderr?: string })?.stderr;
  if (stdout?.trim()) {
    console.debug(`stdout: ${stdout.trim()}`);
  }
  if (stderr?.trim()) {
    console.debug(`stderr: ${stderr.trim()}`);
  }
  return process.exit(1);
}

export { PortInUseError };
export type { PortListener, PortListenerKind, PortUsage, PortUsageStatus };
export { buildPortHints, classifyPortListener, formatPortDiagnostics } from "./ports-format.js";
export { inspectPortUsage } from "./ports-inspect.js";
