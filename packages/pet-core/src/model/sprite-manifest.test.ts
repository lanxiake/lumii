import { describe, it, expect } from "vitest";
import {
  validateSpriteManifest,
  type SpriteManifest,
} from "./sprite-manifest.js";

/** 一份最小合法清单，测试中按需覆写字段 */
function validManifest(over: Partial<SpriteManifest> = {}): SpriteManifest {
  return {
    id: "demo_cat",
    rendererType: "sprite",
    canvas: { w: 64, h: 64 },
    anchor: [32, 60],
    atlas: "atlas.png",
    atlasJson: "atlas.json",
    animations: [
      {
        group: "Idle",
        index: 0,
        kind: "loop",
        fps: 8,
        frames: [{ base: "idle_00" }],
      },
    ],
    ...over,
  } as SpriteManifest;
}

/** 便捷断言：校验失败，且错误信息里出现某段文字 */
function expectRejected(input: unknown, contains?: string, opts?: unknown) {
  const r = validateSpriteManifest(input, opts as never);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.length).toBeGreaterThan(0);
    if (contains) {
      expect(r.errors.map((e) => `${e.path} ${e.message}`).join(" | ")).toContain(contains);
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// 基线
// ---------------------------------------------------------------------------

describe("validateSpriteManifest — 基线", () => {
  it("最小合法清单通过", () => {
    const r = validateSpriteManifest(validManifest());
    expect(r.ok).toBe(true);
  });

  it("程序化动画（无 frames）通过", () => {
    const r = validateSpriteManifest(
      validManifest({
        animations: [
          {
            group: "Idle",
            index: 1,
            kind: "loop",
            source: "procedural",
            params: { bob: 3, breathe: 1.02, blink: 3200 },
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("frames 与 params 混用通过", () => {
    const r = validateSpriteManifest(
      validManifest({
        animations: [
          {
            group: "Talk",
            index: 0,
            kind: "loop",
            fps: 8,
            frames: [{ base: "talk_00" }],
            params: { bob: 1 },
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("拒绝非对象输入", () => {
    for (const bad of [null, undefined, "x", 42, [], true]) {
      expectRejected(bad);
    }
  });
});

// ---------------------------------------------------------------------------
// 安全边界：params 是数据不是代码
// ---------------------------------------------------------------------------

describe("validateSpriteManifest — params 安全约束", () => {
  const withParams = (params: unknown) =>
    validManifest({
      animations: [
        { group: "Idle", index: 0, kind: "loop", source: "procedural", params: params as never },
      ],
    });

  it("拒绝字符串表达式，并指出违规字段", () => {
    for (const bad of ["sin(t)", "3", "${x}", "javascript:alert(1)"]) {
      expectRejected(withParams({ bob: bad }), "bob");
    }
  });

  it("拒绝函数值", () => {
    expectRejected(withParams({ bob: () => 1 }), "bob");
  });

  it("拒绝对象/数组值", () => {
    expectRejected(withParams({ bob: { valueOf: () => 1 } }), "bob");
    expectRejected(withParams({ bob: [1, 2] }), "bob");
  });

  it("拒绝 NaN / Infinity", () => {
    expectRejected(withParams({ bob: NaN }), "bob");
    expectRejected(withParams({ bob: Infinity }), "bob");
  });

  it("拒绝未知原语字段（防止夹带）", () => {
    expectRejected(withParams({ bob: 1, eval: 1 }));
    expectRejected(withParams({ script: "x" }));
  });

  it("拒绝 params 本身不是对象", () => {
    expectRejected(withParams("bob:3"));
    expectRejected(withParams(42));
  });

  it("接受纯数值参数（含负值）", () => {
    const r = validateSpriteManifest(withParams({ bob: 3, sway: -1.5, breathe: 1.02, blink: 3200 }));
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 结构完整性
// ---------------------------------------------------------------------------

describe("validateSpriteManifest — 结构完整性", () => {
  it("拒绝空 animations", () => {
    expectRejected(validManifest({ animations: [] }), "animations");
  });

  it("拒绝缺失 animations", () => {
    const m = validManifest();
    delete (m as { animations?: unknown }).animations;
    expectRejected(m, "animations");
  });

  it("拒绝空动画组名", () => {
    const m = validManifest({
      animations: [{ group: "", index: 0, kind: "loop", frames: [{ base: "a" }] }],
    });
    expectRejected(m, "group");
  });

  it("拒绝非法 kind", () => {
    const m = validManifest({
      animations: [{ group: "Idle", kind: "forever" as never, frames: [{ base: "a" }] }],
    });
    expectRejected(m, "kind");
  });

  it("once 型动画缺 next 时拒绝", () => {
    const m = validManifest({
      animations: [{ group: "PickUp", kind: "once", fps: 8, frames: [{ base: "p" }] }],
    });
    expectRejected(m, "next");
  });

  it("once 型动画带 next 通过", () => {
    const m = validManifest({
      animations: [
        { group: "Idle", index: 0, kind: "loop", frames: [{ base: "i" }] },
        { group: "PickUp", kind: "once", next: "Idle", fps: 8, frames: [{ base: "p" }] },
      ],
    });
    expect(validateSpriteManifest(m).ok).toBe(true);
  });

  /**
   * `durationMs` 是帧对象上的**保留键**，不是槽位引用。
   *
   * 没加进 `FRAME_RESERVED` 的话，它会走进「槽位引用」那条校验，报
   * 「槽位 durationMs 未在 slots 中声明」——一个写法完全正确的清单被拒。
   */
  describe("逐帧时长", () => {
    it("帧上的 durationMs 不被当成槽位引用", () => {
      const m = validManifest({
        animations: [
          {
            group: "Idle",
            kind: "loop",
            fps: 8,
            frames: [{ base: "i", durationMs: 280 }, { base: "i2", durationMs: 110 }],
          },
        ],
      });
      const r = validateSpriteManifest(m);
      if (!r.ok) throw new Error(r.errors.map((e) => `${e.path}: ${e.message}`).join(" | "));
      expect(r.ok).toBe(true);
    });

    it("durationMs 非正数时拒绝", () => {
      for (const bad of [0, -100, Number.NaN]) {
        const m = validManifest({
          animations: [
            { group: "Idle", kind: "loop", frames: [{ base: "i", durationMs: bad }] },
          ],
        });
        expectRejected(m, "durationMs");
      }
    });
  });

  it("拒绝空 id / 空 atlas / 空 atlasJson", () => {
    expectRejected(validManifest({ id: "" }), "id");
    expectRejected(validManifest({ atlas: "" }), "atlas");
    expectRejected(validManifest({ atlasJson: "" }), "atlasJson");
  });

  it("拒绝非法 canvas 与 anchor", () => {
    expectRejected(validManifest({ canvas: { w: 0, h: 64 } }), "canvas");
    expectRejected(validManifest({ canvas: { w: 64, h: -1 } }), "canvas");
    expectRejected(validManifest({ anchor: [999, 60] }), "anchor");
    expectRejected(validManifest({ anchor: [1] as never }), "anchor");
  });

  it("拒绝未知 rendererType", () => {
    expectRejected(validManifest({ rendererType: "live2d" as never }), "rendererType");
  });
});

// ---------------------------------------------------------------------------
// 图集交叉引用（可选：提供 atlasFrames / assets 时才校验）
// ---------------------------------------------------------------------------

describe("validateSpriteManifest — 图集交叉引用", () => {
  const manifest = validManifest({
    animations: [
      { group: "Idle", index: 0, kind: "loop", frames: [{ base: "idle_00" }, { base: "idle_01" }] },
    ],
  });

  it("帧引用不存在的图集条目 → 拒绝", () => {
    expectRejected(
      manifest,
      "idle_01",
      { atlasFrames: ["idle_00", "talk_00"] },
    );
  });

  it("全部帧都在图集中 → 通过", () => {
    const r = validateSpriteManifest(manifest, { atlasFrames: ["idle_00", "idle_01"] });
    expect(r.ok).toBe(true);
  });

  it("声明的图集文件不存在 → 拒绝", () => {
    expectRejected(manifest, "atlas.png", { assets: ["other.png", "atlas.json"] });
  });

  it("图集文件与清单都在 → 通过", () => {
    const r = validateSpriteManifest(manifest, { assets: ["atlas.png", "atlas.json"] });
    expect(r.ok).toBe(true);
  });

  it("未提供 atlasFrames / assets 时跳过交叉校验（纯函数可离线用）", () => {
    const r = validateSpriteManifest(manifest);
    expect(r.ok).toBe(true);
  });

  it("slot 部件引用不存在的图集条目 → 拒绝", () => {
    const m = validManifest({
      slots: {
        face: { kind: "layered", at: [24, 24], parts: { eyes: ["eye_open"], mouth: ["m0"] } },
      },
    });
    expectRejected(m, "eye_open", { atlasFrames: ["m0"] });
  });
});

// ---------------------------------------------------------------------------
// 错误信息质量
// ---------------------------------------------------------------------------

describe("validateSpriteManifest — 错误信息", () => {
  it("错误带可定位的 path", () => {
    const m = validManifest({
      animations: [
        { group: "Idle", index: 0, kind: "loop", frames: [{ base: "ok" }] },
        { group: "Talk", index: 0, kind: "loop", frames: [{ base: "" }] },
      ],
    });
    const r = validateSpriteManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.includes("animations[1]"))).toBe(true);
    }
  });

  it("一次报出全部错误，不是发现第一个就返回", () => {
    const m = validManifest({
      id: "",
      atlas: "",
      animations: [{ group: "", kind: "loop", frames: [{ base: "a" }] }],
    });
    const r = validateSpriteManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 2026-09-20 追加（P0-b）：两条会导致「作者以为生效了、实际没有」的规则
// ---------------------------------------------------------------------------

describe("同组内 index 必须唯一", () => {
  it("同组同 index 重复声明被拒绝", () => {
    expectRejected(
      validManifest({
        animations: [
          { group: "Idle", index: 0, kind: "loop", frames: [{ base: "a" }] },
          { group: "Idle", index: 0, kind: "loop", frames: [{ base: "b" }] },
        ],
      }),
      "重复",
    );
  });

  it("不同组可以各自有 index 0", () => {
    const r = validateSpriteManifest(
      validManifest({
        animations: [
          { group: "Idle", index: 0, kind: "loop", frames: [{ base: "a" }] },
          { group: "Talk", index: 0, kind: "loop", frames: [{ base: "a" }] },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("同组不同 index 正常通过", () => {
    const r = validateSpriteManifest(
      validManifest({
        animations: [
          { group: "Idle", index: 0, kind: "loop", frames: [{ base: "a" }] },
          { group: "Idle", index: 1, kind: "loop", frames: [{ base: "a" }] },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("帧只能引用已声明的槽位", () => {
  const withFace = () =>
    validManifest({
      slots: {
        base: { kind: "whole-frame" },
        face: { kind: "layered", at: [0, 0], parts: { eyes: ["eye_open"] } },
      },
      animations: [
        { group: "Idle", kind: "loop", frames: [{ base: "a", face: { eyes: "eye_open" } }] },
      ],
    });

  it("引用已声明的槽位通过", () => {
    expect(validateSpriteManifest(withFace()).ok).toBe(true);
  });

  it("引用未声明的槽位被拒绝（否则运行时会静默忽略）", () => {
    const m = withFace();
    (m.animations[0] as { frames: unknown[] }).frames = [
      { base: "a", 手滑写错的槽: { eyes: "eye_open" } },
    ];
    expectRejected(m, "未在 slots 中声明");
  });

  it("没有 slots 字段时，任何非 base 槽位引用都被拒绝", () => {
    expectRejected(
      validManifest({
        animations: [{ group: "Idle", kind: "loop", frames: [{ base: "a", face: { eyes: "x" } }] }],
      }),
      "未在 slots 中声明",
    );
  });

  it("slots 里声明了 base 时，帧仍可引用 base", () => {
    const r = validateSpriteManifest(withFace());
    expect(r.ok).toBe(true);
  });
});
