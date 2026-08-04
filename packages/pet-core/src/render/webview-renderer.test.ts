import { describe, it, expect } from "vitest";
import { WebViewPetRenderer } from "./webview-renderer.js";
import { type WebViewCommand } from "./webview-command.js";

function makeRenderer(): { renderer: WebViewPetRenderer; sent: WebViewCommand[] } {
  const sent: WebViewCommand[] = [];
  const renderer = new WebViewPetRenderer((raw) => sent.push(JSON.parse(raw) as WebViewCommand));
  return { renderer, sent };
}

describe("WebViewPetRenderer", () => {
  it("语义调用序列化为对应 WebViewCommand", () => {
    const { renderer, sent } = makeRenderer();
    renderer.setExpression(2);
    renderer.playMotion("Talk", 1);
    renderer.playMotion("Idle");
    renderer.playRandomMotion("Idle");
    renderer.releaseLipSync();
    renderer.resize(800, 600);
    expect(sent).toEqual([
      { type: "expression", index: 2 },
      { type: "motion", group: "Talk", index: 1 },
      { type: "motion", group: "Idle" },
      { type: "random_motion", group: "Idle" },
      { type: "release_lipsync" },
      { type: "resize", width: 800, height: 600 },
    ]);
  });

  it("口型钳制到 [0,1]，NaN 归 0", () => {
    const { renderer, sent } = makeRenderer();
    renderer.setMouthOpen(0.5);
    renderer.setMouthOpen(2);
    renderer.setMouthOpen(-1);
    renderer.setMouthOpen(Number.NaN);
    expect(sent).toEqual([
      { type: "mouth", value: 0.5 },
      { type: "mouth", value: 1 },
      { type: "mouth", value: 0 },
      { type: "mouth", value: 0 },
    ]);
  });

  it("resize 向下取整且不小于 0", () => {
    const { renderer, sent } = makeRenderer();
    renderer.resize(799.9, -5);
    expect(sent).toEqual([{ type: "resize", width: 799, height: 0 }]);
  });

  it("getMotionCount 宿主侧无法同步获知，返回 0", () => {
    const { renderer } = makeRenderer();
    expect(renderer.getMotionCount("Idle")).toBe(0);
  });
});
