/**
 * `security` 专用 Agent 的结构性护栏（设计 §5.4）。
 *
 * 这些护栏**只有代码能守**——技能是散文，拦不住工具调用。所以每一条都写成一个断言：
 * 摘掉哪个工具、谁不能自动用它、它的 systemPrompt 里红线还在不在。
 *
 * 特别记一条踩过的坑：设计原文写 `isActive: false` 来表示「默认关闭」，
 * 但实测发现内置 Agent 的 `isEnabled` 直接取自 `def.isActive`，而
 * `updateAgentRecord` 只改用户 Agent —— **没有任何路径能把它打开**。
 * 设成 false 等于「永久不存在」，护栏白做。所以这里反过来守住：
 * 它必须 `isActive: true`，靠「不被自动路由」实现按需。
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_DEFINITIONS, findBuiltInAgent } from "../definitions.js";

const SECURITY = findBuiltInAgent("security");

describe("security Agent 存在且可被显式调用", () => {
  it("已注册且启用（否则显式 spawn 也会被拒，等于能力不存在）", () => {
    expect(SECURITY).toBeDefined();
    expect(SECURITY?.isActive).toBe(true);
  });

  it("不进会话选择器（它不是日常聊天入口）", () => {
    expect(SECURITY?.selectable).toBeFalsy();
  });

  it("不能派生子 Agent，也不能转交（红线跟着 systemPrompt 走，派出去就没了）", () => {
    expect(SECURITY?.canSpawnSubAgents).toBe(false);
    const denied = new Set(SECURITY?.disallowedTools ?? []);
    for (const t of ["spawn_agent", "pipeline_run", "send_message", "propose_dev_handoff"]) {
      expect(denied.has(t), `disallowedTools 必须包含 ${t}`).toBe(true);
    }
  });

  it("工具白名单里没有 pipeline_run / spawn_agent（双保险，白名单与黑名单都要干净）", () => {
    const tools = new Set(SECURITY?.tools ?? []);
    expect(tools.has("pipeline_run")).toBe(false);
    expect(tools.has("spawn_agent")).toBe(false);
  });

  it("不给写删除能力的工具面（加固补丁只改文件，不需要删/移/建目录之外的破坏面）", () => {
    const tools = new Set(SECURITY?.tools ?? [])
    // file_edit / file_write 是补丁必需；但「整目录删除」这类没有对应工具，
    // 这里守的是「不要因为方便把 file_move / file_copy 之类顺手加进来」——
    // 加进来就要能解释为什么安全验证需要它
    for (const t of ['file_move', 'file_copy', 'file_mkdir']) {
      expect(tools.has(t), `${t} 不该在安全 Agent 的工具面里`).toBe(false)
    }
  })

  it("给了观察与取证需要的工具面（缺了它连第一次取证都做不了）", () => {
    const tools = new Set(SECURITY?.tools ?? []);
    for (const t of ["browser_navigate", "browser_eval", "bash", "file_read", "grep"]) {
      expect(tools.has(t), `${t} 应在白名单里`).toBe(true)
    }
  });
});

describe("security 的红线写在 systemPrompt 里", () => {
  const prompt = SECURITY?.systemPrompt ?? "";

  it("要求先确认归属，且第三方目标按「不是你的」处理", () => {
    expect(prompt).toContain("归属");
    expect(prompt).toMatch(/第三方|别人的/);
  });

  it("产物是防御资产：明确不做免杀 / C2 / exploit 二进制", () => {
    expect(prompt).toMatch(/免杀/);
    expect(prompt).toMatch(/C2/);
    expect(prompt).toMatch(/exploit/);
  });

  it("越界请求要明确拒绝并给替代路径，不是模棱两可地绕过去", () => {
    expect(prompt).toContain("拒绝");
    expect(prompt).toMatch(/替代|方向/);
  });
});

describe("其它内置 Agent 不受影响", () => {
  it("delegatable 的两位常驻专家仍是 chronicler / info-curator", () => {
    // 与 apps/windows/src/main/index.ts 的 delegatableSystemAgentIds 保持一致。
    // 两者不同步 = 「团队里看得见但 spawn 不了」或反过来。
    const resident = BUILTIN_AGENT_DEFINITIONS.filter(
      (d) => d.selectable && d.id !== "assistant" && d.id !== "code-dev",
    ).map((d) => d.id);
    expect(resident).toEqual(["chronicler", "info-curator"]);
  });

  it("**security 不能进团队列表**：它按需加载，发现路径在技能文档里", () => {
    // 团队列表的实现在 apps/windows/src/main/index.ts 的 delegatableSystemAgentIds，
    // 这里守不住那个数组本身，但守得住「它不该被当成常驻专家」这个结论——
    // 想把它加进去的人得先来改这条测试，也就会先看到这段理由。
    expect(SECURITY?.id).toBe("security");
    expect(SECURITY?.selectable).toBeFalsy();
    // 常驻专家的判据是 selectable（见上一条）；security 明确不在其中
    const residentIds = BUILTIN_AGENT_DEFINITIONS.filter(
      (d) => d.selectable && d.id !== "assistant" && d.id !== "code-dev",
    ).map((d) => d.id);
    expect(residentIds).not.toContain("security");
  });
});
