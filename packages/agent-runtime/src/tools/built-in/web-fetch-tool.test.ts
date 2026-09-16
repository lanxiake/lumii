import { describe, expect, it } from "vitest";
import { webFetchToolConfig } from "./web-fetch-tool.js";
import type { ToolExecutionContext } from "../../types/tool.js";

/** 只需要 fetch 一个能力；其余字段与用例无关 */
function ctxWith(fetchImpl: ToolExecutionContext["fetch"]): ToolExecutionContext {
  return { fetch: fetchImpl } as never;
}

async function runFetch(status: number, body: string) {
  try {
    await webFetchToolConfig.execute(
      "tc",
      { url: "https://example.com/a" },
      ctxWith(async () => ({ status, body })),
    );
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("web_fetch 失败信息", () => {
  it("status=0 时带出宿主分类好的原因，而不是只说 HTTP 0", async () => {
    const msg = await runFetch(0, "连接超时（10 秒内没建立起连接）（UND_ERR_CONNECT_TIMEOUT）");

    expect(msg).toContain("连接超时");
    expect(msg).toContain("UND_ERR_CONNECT_TIMEOUT");
    expect(msg).toContain("https://example.com/a");
    // 关键：给出出路，否则模型会对着同一个死域名反复重试
    expect(msg).toMatch(/不可达/);
  });

  it("status=0 且 body 为空时也有可读结论", async () => {
    const msg = await runFetch(0, "");
    expect(msg).toContain("连接层失败");
  });

  it("404 提示先确认真实链接、不要拼 URL", async () => {
    const msg = await runFetch(404, "<html><body>Not Found</body></html>");
    expect(msg).toBe(
      "HTTP 404: https://example.com/a 页面不存在（链接已失效，或 URL 有误）。先用 web_search 确认真实链接，不要凭记忆拼 URL。",
    );
  });

  it("403 / 429 / 5xx 各给一句可执行的下一步", async () => {
    expect(await runFetch(403, "")).toMatch(/拒绝访问/);
    expect(await runFetch(429, "")).toMatch(/限流/);
    expect(await runFetch(503, "")).toMatch(/服务端出错/);
  });

  it("非 0 状态码不把站点错误页 HTML 塞进错误信息（那是噪声）", async () => {
    const msg = await runFetch(500, "<html><body>" + "x".repeat(5000) + "</body></html>");
    expect(msg).not.toContain("<html>");
    expect(msg!.length).toBeLessThan(200);
  });

  it("2xx 正常返回正文，不受失败分支影响", async () => {
    const result = await webFetchToolConfig.execute(
      "tc",
      { url: "https://example.com/a" },
      ctxWith(async () => ({ status: 200, body: "<html><title>T</title><p>hello</p></html>" })),
    );
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("hello");
  });
});
