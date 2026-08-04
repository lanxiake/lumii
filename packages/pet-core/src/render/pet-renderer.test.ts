import { describe, it, expect } from "vitest";
import type { PetCoreRenderer, PetMotionPlayedInfo } from "./pet-renderer.js";

/**
 * pet-renderer 是纯接口（无运行时导出），此处用一个最小 mock 实现做
 * 编译期结构性校验：能赋给 PetCoreRenderer 即证明接口签名可被后端实现。
 * 同时以 spy 记录调用，验证语义方法可正常派发（守护未来签名变更）。
 */
function createMockRenderer(): {
  readonly renderer: PetCoreRenderer;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const renderer: PetCoreRenderer = {
    setExpression: (i) => void calls.push(`expr:${i}`),
    playMotion: (g, i) => void calls.push(`motion:${g}:${i ?? "rand"}`),
    playRandomMotion: (g) => void calls.push(`randMotion:${g}`),
    getMotionCount: () => 0,
    setMouthOpen: (v) => void calls.push(`mouth:${v}`),
    releaseLipSync: () => void calls.push("release"),
    resize: (w, h) => void calls.push(`resize:${w}x${h}`),
  };
  return { renderer, calls };
}

describe("PetCoreRenderer 接口契约", () => {
  it("最小 mock 可满足接口并派发语义调用", () => {
    const { renderer, calls } = createMockRenderer();
    renderer.setExpression(2);
    renderer.playMotion("Talk", 1);
    renderer.playRandomMotion("Idle");
    renderer.setMouthOpen(0.6);
    renderer.releaseLipSync?.();
    renderer.resize(800, 600);
    expect(calls).toEqual([
      "expr:2",
      "motion:Talk:1",
      "randMotion:Idle",
      "mouth:0.6",
      "release",
      "resize:800x600",
    ]);
  });

  it("releaseLipSync 为可选，省略时不影响接口成立", () => {
    const renderer: PetCoreRenderer = {
      setExpression: () => {},
      playMotion: () => {},
      playRandomMotion: () => {},
      getMotionCount: () => 0,
      setMouthOpen: () => {},
      resize: () => {},
    };
    expect(renderer.releaseLipSync).toBeUndefined();
  });

  it("PetMotionPlayedInfo 携带 group/index，fileName 可选", () => {
    const info: PetMotionPlayedInfo = { group: "Talk", index: 3, fileName: "motion/04.motion3.json" };
    expect(info.group).toBe("Talk");
    expect(info.index).toBe(3);
    const minimal: PetMotionPlayedInfo = { group: "Idle", index: 0 };
    expect(minimal.fileName).toBeUndefined();
  });
});
