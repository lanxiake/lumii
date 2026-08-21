import type { ResolvedBrowserConfig } from "./config.js";
import {
  createBrowserControlContext,
  startBrowserControlServer,
} from "./control-service.js";
import { createBrowserRouteDispatcher } from "./dispatcher.js";

function formatCliCommand(command: string): string {
  return command;
}

/**
 * 进程内回退分支所需的配置提供者。
 *
 * 移除 Gateway 后本包不再自行读取配置文件（原 loadConfig 已删除），
 * 配置一律由宿主构造并注入 —— 与 startBrowserControlServer(resolved) 的契约一致。
 * 未注册时相对路径请求无法自举服务，会给出明确错误而非静默失败。
 */
let resolvedConfigProvider: (() => ResolvedBrowserConfig | null) | null = null;

export function setBrowserControlConfigProvider(
  provider: (() => ResolvedBrowserConfig | null) | null,
): void {
  resolvedConfigProvider = provider;
}

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function enhanceBrowserFetchError(url: string, err: unknown, timeoutMs: number): Error {
  const hint = isAbsoluteHttp(url)
    ? "If this is a sandboxed session, ensure the sandbox browser is running and try again."
    : `Start (or restart) the MtBot gateway (MtBot.app menubar, or \`${formatCliCommand("mtbot gateway")}\`) and try again.`;
  const msg = String(err);
  const msgLower = msg.toLowerCase();
  const looksLikeTimeout =
    msgLower.includes("timed out") ||
    msgLower.includes("timeout") ||
    msgLower.includes("aborted") ||
    msgLower.includes("abort") ||
    msgLower.includes("aborterror");
  if (looksLikeTimeout) {
    return new Error(
      `Can't reach the mtbot browser control service (timed out after ${timeoutMs}ms). ${hint}`,
    );
  }
  return new Error(`Can't reach the mtbot browser control service. ${hint} (${msg})`);
}

async function fetchHttpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 5000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchBrowserJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 5000;
  try {
    if (isAbsoluteHttp(url)) {
      return await fetchHttpJson<T>(url, { ...init, timeoutMs });
    }
    const resolved = resolvedConfigProvider?.() ?? null;
    if (!resolved) {
      throw new Error(
        "browser control config provider not registered; " +
          "call setBrowserControlConfigProvider() or use an absolute http(s) URL",
      );
    }
    const started = await startBrowserControlServer(resolved);
    if (!started) {
      throw new Error("browser control disabled");
    }
    const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
    const parsed = new URL(url, "http://localhost");
    const query: Record<string, unknown> = {};
    for (const [key, value] of parsed.searchParams.entries()) {
      query[key] = value;
    }
    let body = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep as string
      }
    }
    const dispatchPromise = dispatcher.dispatch({
      method:
        init?.method?.toUpperCase() === "DELETE"
          ? "DELETE"
          : init?.method?.toUpperCase() === "POST"
            ? "POST"
            : "GET",
      path: parsed.pathname,
      query,
      body,
    });

    const result = await (timeoutMs
      ? Promise.race([
          dispatchPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out")), timeoutMs),
          ),
        ])
      : dispatchPromise);

    if (result.status >= 400) {
      const message =
        result.body && typeof result.body === "object" && "error" in result.body
          ? String((result.body as { error?: unknown }).error)
          : `HTTP ${result.status}`;
      throw new Error(message);
    }
    return result.body as T;
  } catch (err) {
    throw enhanceBrowserFetchError(url, err, timeoutMs);
  }
}
