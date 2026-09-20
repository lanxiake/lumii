import { describe, it, expect } from "vitest";
import {
  hitAreasForGroup,
  hitTestPolygons,
  pointInPolygon,
  toCanvasPoint,
  toManifestPoint,
  type ModelTransform,
  type Point2,
} from "./hit-polygon.js";
import type { SpriteHitArea } from "../model/sprite-manifest.js";

/** 100×100 的方框 */
const SQUARE: Point2[] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];

/**
 * L 形凹多边形：左上角 [0..50]×[0..50] 被挖掉。
 * 顺时针从 (50,0) 起：上边 → 右边 → 下边 → 左边（到 y=50 止）→ 凹口下边 → 凹口右边回去。
 * 于是实体 = 右上列（x 50..100, y 0..50）∪ 下条带（y 50..100, 全宽）。
 */
const CONCAVE: Point2[] = [
  [50, 0],
  [100, 0],
  [100, 100],
  [0, 100],
  [0, 50],
  [50, 50],
];

describe("pointInPolygon", () => {
  it("内点命中", () => {
    expect(pointInPolygon(50, 50, SQUARE)).toBe(true);
  });

  it("外点不命中", () => {
    expect(pointInPolygon(-1, 50, SQUARE)).toBe(false);
    expect(pointInPolygon(101, 50, SQUARE)).toBe(false);
  });

  it("边界算命中（贴着轮廓点一下不该穿过去）", () => {
    expect(pointInPolygon(0, 0, SQUARE)).toBe(true); // 顶点
    expect(pointInPolygon(0, 50, SQUARE)).toBe(true); // 左边
    expect(pointInPolygon(50, 100, SQUARE)).toBe(true); // 下边
    expect(pointInPolygon(100, 100, SQUARE)).toBe(true); // 对角顶点
  });

  it("凹多边形的凹口不算命中（射线法的价值所在）", () => {
    // (25, 25) 落在被挖掉的左上角里
    expect(pointInPolygon(25, 25, CONCAVE)).toBe(false);
    // 凹口的两条内边上算命中（边界算命中）
    expect(pointInPolygon(50, 25, CONCAVE)).toBe(true);
    expect(pointInPolygon(25, 50, CONCAVE)).toBe(true);
    // 凹口之外的两条臂仍是实体
    expect(pointInPolygon(25, 75, CONCAVE)).toBe(true); // 下臂
    expect(pointInPolygon(75, 25, CONCAVE)).toBe(true); // 右臂
  });

  it("顶点恰好与射线同高时不误判（半开区间 [yi, yj)）", () => {
    // 在 y=0 这条边上游走：既不算"穿越"，也不该漏判
    expect(pointInPolygon(50, 0, SQUARE)).toBe(true);
    const diamond: Point2[] = [
      [50, 0],
      [100, 50],
      [50, 100],
      [0, 50],
    ];
    expect(pointInPolygon(50, 50, diamond)).toBe(true);
    expect(pointInPolygon(50, 49, diamond)).toBe(true);
    expect(pointInPolygon(0, 0, diamond)).toBe(false);
  });

  it("退化输入不抛异常", () => {
    expect(pointInPolygon(0, 0, [])).toBe(false);
    expect(pointInPolygon(0, 0, [[0, 0]])).toBe(false);
    expect(pointInPolygon(0, 0, [[0, 0], [1, 1]])).toBe(false);
  });
});

describe("坐标互转", () => {
  const t: ModelTransform = { positionX: 200, positionY: 300, scale: 2, anchorX: 64, anchorY: 118 };

  it("清单坐标 → 画布坐标", () => {
    expect(toCanvasPoint(64, 118, t)).toEqual({ x: 200, y: 300 });
    expect(toCanvasPoint(64 + 10, 118 + 5, t)).toEqual({ x: 220, y: 310 });
  });

  it("画布坐标 → 清单坐标（逆变换）", () => {
    expect(toManifestPoint(200, 300, t)).toEqual({ x: 64, y: 118 });
    expect(toManifestPoint(220, 310, t)).toEqual({ x: 74, y: 123 });
  });

  it("互为逆运算", () => {
    const p = toCanvasPoint(30, 90, t);
    const back = toManifestPoint(p.x, p.y, t);
    expect(back.x).toBeCloseTo(30, 10);
    expect(back.y).toBeCloseTo(90, 10);
  });

  it("scale 为 0 时按 1 处理，不产生 Infinity", () => {
    const zero: ModelTransform = { ...t, scale: 0 };
    const p = toManifestPoint(200, 300, zero);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});

describe("hitAreasForGroup — 按动画组筛选", () => {
  const areas: SpriteHitArea[] = [
    { id: "Head", points: SQUARE },
    { id: "IdleOnly", frames: ["Idle"], points: SQUARE },
    { id: "JumpOnly", frames: ["Jump"], points: SQUARE },
  ];

  it("未声明 frames 的对所有组生效", () => {
    expect(hitAreasForGroup({ hitAreas: areas }, "Idle").map((a) => a.id)).toEqual([
      "Head",
      "IdleOnly",
    ]);
  });

  it("声明 frames 的只在对应组生效", () => {
    expect(hitAreasForGroup({ hitAreas: areas }, "Jump").map((a) => a.id)).toEqual([
      "Head",
      "JumpOnly",
    ]);
  });

  it("尚未播放任何动画时只保留通用区域", () => {
    expect(hitAreasForGroup({ hitAreas: areas }, null).map((a) => a.id)).toEqual(["Head"]);
  });

  it("没有声明 hitAreas 时返回空数组", () => {
    expect(hitAreasForGroup({}, "Idle")).toEqual([]);
  });
});

describe("hitTestPolygons — 命中优先级", () => {
  const manifest = {
    hitAreas: [
      { id: "Head", points: [[0, 0], [100, 0], [100, 50], [0, 50]] as Point2[] },
      { id: "Body", points: [[0, 50], [100, 50], [100, 100], [0, 100]] as Point2[] },
    ],
  };
  const t: ModelTransform = { positionX: 0, positionY: 0, scale: 1, anchorX: 0, anchorY: 0 };

  it("按区域位置命中", () => {
    expect(hitTestPolygons(manifest, "Idle", 50, 25, t)).toBe("Head");
    expect(hitTestPolygons(manifest, "Idle", 50, 75, t)).toBe("Body");
  });

  it("都不命中返回 null", () => {
    expect(hitTestPolygons(manifest, "Idle", 200, 200, t)).toBeNull();
  });

  it("重叠时按声明顺序，先声明者胜", () => {
    const overlapping = {
      hitAreas: [
        { id: "First", points: SQUARE },
        { id: "Second", points: SQUARE },
      ],
    };
    expect(hitTestPolygons(overlapping, "Idle", 50, 50, t)).toBe("First");
  });

  it("经缩放与位移后仍然命中（变换被正确逆用）", () => {
    const scaled: ModelTransform = { positionX: 500, positionY: 400, scale: 3, anchorX: 0, anchorY: 0 };
    // 清单坐标 (50,25) 在画布上的落点
    const p = toCanvasPoint(50, 25, scaled);
    expect(hitTestPolygons(manifest, "Idle", p.x, p.y, scaled)).toBe("Head");
  });
});
