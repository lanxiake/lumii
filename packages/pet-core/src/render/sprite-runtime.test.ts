import { describe, it, expect } from "vitest";
import {
  adaptiveScale,
  animatedIndices,
  applyFrameRef,
  applyOverrides,
  findAnimation,
  motionCount,
  motionGroups,
  mouthLevelIndex,
  randomAnimationIndex,
  resolveSpriteRuntime,
  snapPixelScale,
  type SlotState,
} from "./sprite-runtime.js";
import type { SpriteManifest, SpriteSlotDef } from "../model/sprite-manifest.js";

const layered: Record<string, SpriteSlotDef> = {
  face: { kind: "layered", at: [0, 0], parts: { eyes: ["eye_open", "eye_shut"], mouth: ["m0", "m1"] } },
  scene: { kind: "layered", at: [0, 0], parts: { prop: ["none"] } },
};

const base = (over: Partial<SpriteManifest> = {}): SpriteManifest =>
  ({
    id: "demo",
    rendererType: "sprite",
    canvas: { w: 128, h: 128 },
    anchor: [64, 118],
    atlas: "atlas.png",
    atlasJson: "atlas.json",
    animations: [
      { group: "Idle", kind: "loop", fps: 8, frames: [{ base: "idle_00" }, { base: "idle_01" }] },
    ],
    ...over,
  }) as SpriteManifest;

describe("applyFrameRef — 帧增量语义", () => {
  const start: SlotState = { base: "idle_00", layered: { face: { eyes: "eye_open", mouth: "m0" } } };

  it("只声明 base 时其余槽位沿用", () => {
    const next = applyFrameRef(start, { base: "idle_01" }, layered);
    expect(next.base).toBe("idle_01");
    expect(next.layered.face).toEqual({ eyes: "eye_open", mouth: "m0" });
  });

  it("对象写法只改指定部件类别", () => {
    const next = applyFrameRef(start, { face: { eyes: "eye_shut" } }, layered);
    expect(next.base).toBe("idle_00");
    expect(next.layered.face).toEqual({ eyes: "eye_shut", mouth: "m0" });
  });

  it("唯一部件类别的槽位支持字符串简写", () => {
    const s: SlotState = { base: "x", layered: { scene: { prop: "none" } } };
    const next = applyFrameRef(s, { scene: "none" }, layered);
    expect(next.layered.scene).toEqual({ prop: "none" });
  });

  it("字符串简写在多类别槽位上无法判断类别 → 忽略（清单校验会拦下）", () => {
    const next = applyFrameRef(start, { face: "eye_shut" }, layered);
    expect(next.layered.face).toEqual({ eyes: "eye_open", mouth: "m0" });
  });

  it("未声明的槽位被忽略，且不改动已有状态", () => {
    const next = applyFrameRef(start, { 不存在的槽: { x: "y" } }, layered);
    expect(next.layered).toEqual(start.layered);
  });

  it("不修改传入的状态（纯函数）", () => {
    const before = JSON.stringify(start);
    applyFrameRef(start, { base: "z", face: { eyes: "eye_shut" } }, layered);
    expect(JSON.stringify(start)).toBe(before);
  });
});

describe("resolveSpriteRuntime — 默认姿态", () => {
  it("base 取所有动画里第一处声明", () => {
    const rt = resolveSpriteRuntime(base());
    expect(rt.defaultState.base).toBe("idle_00");
  });

  it("首帧只声明面部时，未声明的 base 取默认", () => {
    const rt = resolveSpriteRuntime(
      base({
        slots: layered,
        animations: [
          {
            group: "Blink",
            kind: "loop",
            fps: 8,
            frames: [{ base: "idle_00" }, { face: { eyes: "eye_shut" } }],
          },
        ],
      }),
    );
    expect(rt.animationsByGroup.get("Blink")![0]!.frames[1].base).toBe("idle_00");
  });

  it("分层槽取首个部件作为默认", () => {
    const rt = resolveSpriteRuntime(base({ slots: layered }));
    expect(rt.defaultState.layered.face).toEqual({ eyes: "eye_open", mouth: "m0" });
  });

  it("帧之间沿用，但动画之间不继承", () => {
    const rt = resolveSpriteRuntime(
      base({
        slots: layered,
        animations: [
          {
            group: "A",
            kind: "loop",
            frames: [{ base: "a0", face: { eyes: "eye_shut" } }],
          },
          {
            group: "B",
            kind: "loop",
            frames: [{ base: "b0" }],
          },
        ],
      }),
    );
    // 第二个动画的首帧回到默认（eye_open），而不是继承 A 的 eye_shut
    expect(rt.animationsByGroup.get("B")![0]!.frames[0].layered.face.eyes).toBe("eye_open");
  });

  it("没有 slots 时退化为整体帧方案", () => {
    const rt = resolveSpriteRuntime(base());
    expect(rt.defaultState.layered).toEqual({});
  });
});

describe("resolveSpriteRuntime — 组与 index", () => {
  it("未声明 index 时按声明顺序编号", () => {
    const rt = resolveSpriteRuntime(
      base({
        animations: [
          { group: "Idle", kind: "loop", frames: [{ base: "a" }] },
          { group: "Idle", kind: "loop", frames: [{ base: "b" }] },
        ],
      }),
    );
    expect(motionCount(rt, "Idle")).toBe(2);
    expect(findAnimation(rt, "Idle", 0)!.frames[0].base).toBe("a");
    expect(findAnimation(rt, "Idle", 1)!.frames[0].base).toBe("b");
  });

  it("显式 index 落在指定位置", () => {
    const rt = resolveSpriteRuntime(
      base({
        animations: [
          { group: "Idle", index: 2, kind: "loop", frames: [{ base: "c" }] },
          { group: "Idle", index: 0, kind: "loop", frames: [{ base: "a" }] },
        ],
      }),
    );
    expect(findAnimation(rt, "Idle", 0)!.frames[0].base).toBe("a");
    expect(findAnimation(rt, "Idle", 2)!.frames[0].base).toBe("c");
  });

  it("显式 index 与自动编号混用：声明过的位置不被自动编号占掉", () => {
    const rt = resolveSpriteRuntime(
      base({
        animations: [
          { group: "Idle", index: 1, kind: "loop", frames: [{ base: "b" }] },
          { group: "Idle", kind: "loop", frames: [{ base: "auto" }] },
        ],
      }),
    );
    expect(findAnimation(rt, "Idle", 1)!.frames[0].base).toBe("b");
    // 自动编号接在显式 index 之后
    expect(findAnimation(rt, "Idle", 2)!.frames[0].base).toBe("auto");
  });

  it("index 越界返回 null，组不存在返回 0", () => {
    const rt = resolveSpriteRuntime(base());
    expect(findAnimation(rt, "Idle", 99)).toBeNull();
    expect(findAnimation(rt, "没有这个组")).toBeNull();
    expect(motionCount(rt, "没有这个组")).toBe(0);
  });

  it("显式 index 留出的空位被保留：取到空位返回 null，不压缩成前一个", () => {
    const rt = resolveSpriteRuntime(
      base({
        animations: [{ group: "Idle", index: 3, kind: "loop", frames: [{ base: "d" }] }],
      }),
    );
    expect(findAnimation(rt, "Idle", 0)).toBeNull();
    expect(findAnimation(rt, "Idle", 3)!.frames[0].base).toBe("d");
    // 计数与随机播放只看有效位
    expect(motionCount(rt, "Idle")).toBe(1);
    expect(animatedIndices(rt, "Idle")).toEqual([3]);
  });

  it("随机取 index 只在有效位里选", () => {
    const rt = resolveSpriteRuntime(
      base({
        animations: [
          { group: "Idle", index: 1, kind: "loop", frames: [{ base: "b" }] },
          { group: "Idle", index: 4, kind: "loop", frames: [{ base: "e" }] },
        ],
      }),
    );
    expect(animatedIndices(rt, "Idle")).toEqual([1, 4]);
    // rand 可注入，取端点也落在有效位上
    expect(randomAnimationIndex(rt, "Idle", () => 0)).toBe(1);
    expect(randomAnimationIndex(rt, "Idle", () => 0.999)).toBe(4);
    expect(randomAnimationIndex(rt, "没有这个组")).toBe(-1);
  });

  it("枚举组名", () => {
    const rt = resolveSpriteRuntime(
      base({
        animations: [
          { group: "Idle", kind: "loop", frames: [{ base: "a" }] },
          { group: "Talk", kind: "loop", frames: [{ base: "a" }] },
        ],
      }),
    );
    expect(motionGroups(rt).sort()).toEqual(["Idle", "Talk"]);
  });
});

describe("resolveSpriteRuntime — 来源与参数", () => {
  it("有 frames 判为 frames，只有 params 判为 procedural", () => {
    const rt = resolveSpriteRuntime(
      base({
        animations: [
          { group: "Idle", kind: "loop", frames: [{ base: "a" }], params: { breathe: 1.02 } },
          { group: "Breathe", kind: "loop", params: { breathe: 1.02 } },
        ],
      }),
    );
    expect(rt.animationsByGroup.get("Idle")![0]!.source).toBe("frames");
    expect(rt.animationsByGroup.get("Breathe")![0]!.source).toBe("procedural");
  });

  it("frames 与 params 并存（帧序列 + 程序化叠加）", () => {
    // 用 breathe 而不是 bob 当例子：Idle 的 bob 会被「待机不许浮动」规则丢掉
    //（见文件末尾那组用例），拿它当例子会读成"规则没生效"
    const rt = resolveSpriteRuntime(
      base({ animations: [{ group: "Idle", kind: "loop", frames: [{ base: "a" }], params: { breathe: 1.02 } }] }),
    );
    const anim = rt.animationsByGroup.get("Idle")![0]!;
    expect(anim.frames).toHaveLength(1);
    expect(anim.params).toEqual({ breathe: 1.02 });
  });

  it("fps 缺省为 8", () => {
    const rt = resolveSpriteRuntime(
      base({ animations: [{ group: "Idle", kind: "loop", frames: [{ base: "a" }] }] }),
    );
    expect(rt.animationsByGroup.get("Idle")![0]!.fps).toBe(8);
  });

  /**
   * 逐帧时长：四到六帧能不能读成一段动作，靠的就是首尾停得久、中间走得快。
   * 均速播一段挥手只是匀速抖动。
   */
  describe("逐帧时长", () => {
    it("帧上声明了 durationMs 就透传，按下标对齐", () => {
      const rt = resolveSpriteRuntime(
        base({
          animations: [
            {
              group: "Idle",
              kind: "loop",
              fps: 8,
              frames: [
                { base: "a", durationMs: 280 },
                { base: "b", durationMs: 110 },
                { base: "c", durationMs: 320 },
              ],
            },
          ],
        }),
      );
      expect(rt.animationsByGroup.get("Idle")![0]!.durationsMs).toEqual([280, 110, 320]);
    });

    /**
     * 「没声明」必须与「声明成 0」分得开：返回 `undefined` 让播放器走均速，
     * 而不是给一个全零数组（那样每一帧都是 0 毫秒 = 瞬跳）。
     */
    it("一帧都没声明时是 undefined，不是全零数组", () => {
      const rt = resolveSpriteRuntime(
        base({ animations: [{ group: "Idle", kind: "loop", frames: [{ base: "a" }, { base: "b" }] }] }),
      );
      expect(rt.animationsByGroup.get("Idle")![0]!.durationsMs).toBeUndefined();
    });

    it("只声明了部分帧时，未声明的那几帧留 0（播放器回落到均速）", () => {
      const rt = resolveSpriteRuntime(
        base({
          animations: [
            { group: "Idle", kind: "loop", frames: [{ base: "a", durationMs: 300 }, { base: "b" }] },
          ],
        }),
      );
      expect(rt.animationsByGroup.get("Idle")![0]!.durationsMs).toEqual([300, 0]);
    });
  });

  it("透传 once 的 next", () => {
    const rt = resolveSpriteRuntime(
      base({
        animations: [
          { group: "Idle", kind: "loop", frames: [{ base: "a" }] },
          { group: "Jump", kind: "once", next: "Idle", frames: [{ base: "b" }] },
        ],
      }),
    );
    expect(rt.animationsByGroup.get("Jump")![0]!.next).toBe("Idle");
    expect(rt.animationsByGroup.get("Jump")![0]!.kind).toBe("once");
  });
});

describe("mouthLevelIndex — 口型取档", () => {
  it("按档数等分，末档夹住", () => {
    expect(mouthLevelIndex(0, 4)).toBe(0);
    expect(mouthLevelIndex(0.24, 4)).toBe(0);
    expect(mouthLevelIndex(0.25, 4)).toBe(1);
    expect(mouthLevelIndex(0.5, 4)).toBe(2);
    expect(mouthLevelIndex(0.75, 4)).toBe(3);
    expect(mouthLevelIndex(1, 4)).toBe(3);
  });

  it("档数由模型自定（像素风常见 2 档）", () => {
    expect(mouthLevelIndex(0.4, 2)).toBe(0);
    expect(mouthLevelIndex(0.5, 2)).toBe(1);
    expect(mouthLevelIndex(1, 2)).toBe(1);
  });

  it("越界与非法值夹到合法范围", () => {
    expect(mouthLevelIndex(-1, 4)).toBe(0);
    expect(mouthLevelIndex(2, 4)).toBe(3);
    expect(mouthLevelIndex(NaN, 4)).toBe(0);
  });

  it("没有口型档的模型返回 -1", () => {
    expect(mouthLevelIndex(0.5, 0)).toBe(-1);
  });
});

describe("snapPixelScale — 像素缩放吸附", () => {
  it("吸附到 ≥1 的整数", () => {
    expect(snapPixelScale(1)).toBe(1);
    expect(snapPixelScale(1.4)).toBe(1);
    expect(snapPixelScale(1.6)).toBe(2);
    expect(snapPixelScale(3)).toBe(3);
  });

  it("小于 1 也至少为 1（像素素材不允许缩小到非整数倍）", () => {
    expect(snapPixelScale(0.3)).toBe(1);
    expect(snapPixelScale(0)).toBe(1);
    expect(snapPixelScale(-2)).toBe(1);
    expect(snapPixelScale(NaN)).toBe(1);
  });
});

describe("adaptiveScale — 自适应缩放", () => {
  it("未超限时保持请求的缩放", () => {
    expect(adaptiveScale(100, 1000, 2, false)).toBe(2);
  });

  it("超出视口 78% 时压回上限（与 Live2D 后端同口径）", () => {
    const s = adaptiveScale(1000, 1000, 1, false);
    expect(s).toBeCloseTo(0.78, 5);
  });

  it("像素模型取整", () => {
    expect(adaptiveScale(100, 1000, 2.4, true)).toBe(2);
    // 超限后压到 0.78 → 取整为 1（像素模型不缩到 1 倍以下）
    expect(adaptiveScale(1000, 1000, 1, true)).toBe(1);
  });
});

describe("applyOverrides — 表情/口型叠加在帧之上", () => {
  const frame: SlotState = {
    base: "body_01",
    layered: { face: { eyes: "eye_open", mouth: "m0" } },
  };

  it("无覆盖时原样返回", () => {
    expect(applyOverrides(frame, [])).toBe(frame);
  });

  it("覆盖指定部件，其余保持帧的值", () => {
    const out = applyOverrides(frame, [{ slot: "face", cat: "mouth", part: "m3" }]);
    expect(out).toEqual({ base: "body_01", layered: { face: { eyes: "eye_open", mouth: "m3" } } });
  });

  it("不修改传入的帧（纯函数）—— 这是它存在的理由", () => {
    const before = JSON.stringify(frame);
    applyOverrides(frame, [{ slot: "face", cat: "eyes", part: "eye_happy" }]);
    expect(JSON.stringify(frame)).toBe(before);
  });

  it("多条覆盖按顺序应用，后写的赢", () => {
    const out = applyOverrides(frame, [
      { slot: "face", cat: "mouth", part: "m1" },
      { slot: "face", cat: "mouth", part: "m2" },
    ]);
    expect(out.layered.face.mouth).toBe("m2");
  });

  it("表情与口型可以同时覆盖（场景 B 的核心组合）", () => {
    const out = applyOverrides(frame, [
      { slot: "face", cat: "eyes", part: "eye_happy" },
      { slot: "face", cat: "mouth", part: "m2" },
    ]);
    expect(out.layered.face).toEqual({ eyes: "eye_happy", mouth: "m2" });
    expect(out.base).toBe("body_01");
  });

  it("覆盖出现的新槽位会被建出来", () => {
    const out = applyOverrides(frame, [{ slot: "scene", cat: "prop", part: "ball" }]);
    expect(out.layered.scene).toEqual({ prop: "ball" });
  });

  it("空部件名跳过（不当成清空）", () => {
    const out = applyOverrides(frame, [{ slot: "face", cat: "mouth", part: "" }]);
    expect(out.layered.face.mouth).toBe("m0");
  });
});

describe("adaptiveScale — 视口占比上限可调（sprite 桌宠比 Live2D 小得多）", () => {
  it("默认上限沿用 Live2D 口径 0.78", () => {
    // 自然高 1000，视口 1000 → 压到 0.78
    expect(adaptiveScale(1000, 1000, 1, false)).toBeCloseTo(0.78, 5)
  });

  it("传入更小的上限时按新上限压", () => {
    expect(adaptiveScale(1000, 1000, 1, false, 0.35)).toBeCloseTo(0.35, 5)
  });

  it("未超上限时上限值不影响结果", () => {
    expect(adaptiveScale(56, 1400, 2, true, 0.35)).toBe(2)
    expect(adaptiveScale(56, 1400, 2, true, 0.78)).toBe(2)
  });

  it("上限会把配大的 scale 兜住（0.35 × 视口高 / 画布高）", () => {
    // 画布 100、视口 1000、请求 10 倍 → 1000px，远超 350px 上限 → 压到 3.5
    expect(adaptiveScale(100, 1000, 10, false, 0.35)).toBeCloseTo(3.5, 5)
    // 像素模型再取整
    expect(adaptiveScale(100, 1000, 10, true, 0.35)).toBe(4)
  });
});

describe("待机不许浮动 —— 规则在解析层生效", () => {
  /** 造一个带程序化参数的清单：Idle 声明 bob/sway，另有一组声明 bob（不该被动） */
  const withParams = (idle: Record<string, number>) =>
    resolveSpriteRuntime(
      base({
        animations: [
          { group: "Idle", kind: "loop", fps: 8, frames: [{ base: "idle_00" }], params: idle } as never,
          {
            group: "Float",
            kind: "loop",
            fps: 8,
            frames: [{ base: "idle_00" }],
            params: { bob: 9 },
          } as never,
        ],
      }),
    )

  it("Idle 的 bob / sway 被丢掉，breathe 与 blink 保留", () => {
    const model = withParams({ bob: 9, sway: 1.5, breathe: 1.02, blink: 3200 })
    const idle = findAnimation(model, "Idle", 0)
    expect(idle?.params).toEqual({ breathe: 1.02, blink: 3200 })
    expect(model.idleDriftStripped).toEqual(["Idle:bob=9", "Idle:sway=1.5"])
  })

  it("组名大小写不影响判据（idle / Idle 都算待机）", () => {
    const model = resolveSpriteRuntime(
      base({
        animations: [
          { group: "idle_a", kind: "loop", fps: 8, frames: [{ base: "idle_00" }], params: { bob: 3 } } as never,
        ],
      }),
    )
    expect(findAnimation(model, "idle_a", 0)?.params?.bob).toBeUndefined()
    expect(model.idleDriftStripped).toEqual(["idle_a:bob=3"])
  })

  it("不叫 idle 的组不动它——想飘就得用别的名字，那也就不叫待机了", () => {
    const model = withParams({ breathe: 1.01 })
    expect(findAnimation(model, "Float", 0)?.params).toEqual({ bob: 9 })
    expect(model.idleDriftStripped).toEqual([])
  })

  it("本来就干净的模型：记录为空，参数原样（引用也不换）", () => {
    const model = withParams({ breathe: 1.01 })
    const idle = findAnimation(model, "Idle", 0)
    expect(idle?.params).toEqual({ breathe: 1.01 })
    expect(model.idleDriftStripped).toEqual([])
  })

  it("bob: 0 与 sway: 0 不算“越界”，不做无谓的记录", () => {
    const model = withParams({ bob: 0, sway: 0, breathe: 1.01 })
    expect(model.idleDriftStripped).toEqual([])
    expect(findAnimation(model, "Idle", 0)?.params).toEqual({ bob: 0, sway: 0, breathe: 1.01 })
  })

  it("Idle 没有 params 时不报错、也不记录", () => {
    const model = resolveSpriteRuntime(base())
    expect(model.idleDriftStripped).toEqual([])
    expect(findAnimation(model, "Idle", 0)?.params).toBeUndefined()
  })
})
