import { describe, it, expect, vi } from "vitest";
import type { AgentDefinition } from "../../types/agent-definition.js";
import type {
  SkillInfo,
  CustomAgentInfo,
  UserDeviceInfo,
  McpServerHint,
  ContextFile,
} from "../../prompt/system-prompt-builder.js";
import type { PromptContextProvider } from "../types.js";
import { assembleSystemPrompt } from "../prompt-assembly.js";

function skill(id: string): SkillInfo {
  return { id, name: id, description: `${id} desc`, location: `skills/${id}/SKILL.md` } as SkillInfo;
}

function fakePromptContext(over: Partial<{
  skills: SkillInfo[];
  customAgents: CustomAgentInfo[];
  devices: UserDeviceInfo[];
  soul: string | undefined;
  contextFiles: ContextFile[];
  mcp: McpServerHint[];
}> = {}): PromptContextProvider {
  return {
    getSkills: vi.fn(async () => over.skills ?? []),
    getCustomAgents: vi.fn(async () => over.customAgents ?? []),
    getUserDevices: vi.fn(async () => over.devices ?? []),
    getSoulContent: vi.fn(async () => over.soul),
    getContextFiles: vi.fn(() => over.contextFiles ?? []),
    getMcpServerHints: vi.fn(() => over.mcp ?? []),
  };
}

function def(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "a1",
    name: "Assistant",
    description: "",
    systemPrompt: "You are a helpful assistant.",
    ...over,
  } as AgentDefinition;
}

describe("assembleSystemPrompt", () => {
  it("初次构建返回非空 staticPrompt 与 fullPrompt", async () => {
    const out = await assembleSystemPrompt({
      definition: def(),
      promptContext: fakePromptContext({ skills: [skill("writing")] }),
      toolNames: ["file_read", "web_search"],
      cwd: "/tmp",
      osInfo: "win32 x64",
      modelId: "m1",
    });
    expect(out.initial.staticPrompt.length).toBeGreaterThan(0);
    expect(out.initial.fullPrompt).toContain(out.initial.staticPrompt);
  });

  it("bundledSkills 强制并入并去重（即使技能未在全局列表）", async () => {
    const out = await assembleSystemPrompt({
      definition: def({ bundledSkills: ["pptx", "writing"] }),
      promptContext: fakePromptContext({ skills: [skill("writing"), skill("research")] }),
      toolNames: ["file_read"],
    });
    const ids = out.effectiveSkills.map((s) => s.id);
    // pptx 不在全局列表，但因 bundled 不会被加入（mergeBundledSkills 只并入已存在的）；
    // writing 在全局，bundled 提前 → 顺序在前且去重
    expect(ids).toEqual(["writing", "research"]);
    expect(out.bundledSkillIds).toEqual(["pptx", "writing"]);
  });

  it("无 bundledSkills 时 effectiveSkills 等于全局技能，bundledSkillIds 为 undefined", async () => {
    const out = await assembleSystemPrompt({
      definition: def(),
      promptContext: fakePromptContext({ skills: [skill("a"), skill("b")] }),
      toolNames: [],
    });
    expect(out.effectiveSkills.map((s) => s.id)).toEqual(["a", "b"]);
    expect(out.bundledSkillIds).toBeUndefined();
  });

  it("buildPrompt 每轮可传 currentModelId / skillActivations 重建", async () => {
    const out = await assembleSystemPrompt({
      definition: def(),
      promptContext: fakePromptContext(),
      toolNames: ["file_read"],
      modelId: "default-model",
    });
    const r1 = out.buildPrompt(undefined, "switched-model");
    expect(r1.fullPrompt).toContain("switched-model");
  });

  it("getActiveTasks 在每次 buildPrompt 调用时实时读取", async () => {
    const getActiveTasks = vi.fn(() => []);
    const out = await assembleSystemPrompt({
      definition: def(),
      promptContext: fakePromptContext(),
      toolNames: [],
      getActiveTasks,
    });
    // initial 调用一次
    expect(getActiveTasks).toHaveBeenCalledTimes(1);
    out.buildPrompt();
    expect(getActiveTasks).toHaveBeenCalledTimes(2);
  });

  it("getSoulContentLive 存在时 buildPrompt 每轮读最新 soul", async () => {
    let liveSoul = "SOUL_V1";
    const pc: PromptContextProvider = {
      ...fakePromptContext({ soul: "SOUL_SNAPSHOT" }),
      getSoulContentLive: () => liveSoul,
    };
    // soul 仅在 agent systemPrompt 为内建短提示时作为 identity 注入
    const out = await assembleSystemPrompt({
      definition: def({ systemPrompt: "You are MtBot, a helpful AI assistant." }),
      promptContext: pc,
      toolNames: [],
    });
    expect(out.initial.fullPrompt).toContain("SOUL_V1");
    liveSoul = "SOUL_V2_小红_7岁";
    expect(out.buildPrompt().fullPrompt).toContain("SOUL_V2_小红_7岁");
    expect(out.buildPrompt().fullPrompt).not.toContain("SOUL_SNAPSHOT");
  });
});

