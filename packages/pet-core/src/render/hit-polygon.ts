/**
 * hit-polygon — sprite 后端的命中几何（pet-core，零依赖）
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §5.2 关键语义 4
 *
 * Live2D 走部件网格命中，sprite 没有这个能力。两条路：
 *   - 作者在清单里声明多边形 → 用多边形判定（**本模块**）
 *   - 未声明 → 退化为包围盒（在渲染层做，是本路线的已知退化点）
 *
 * 退化点为什么值得较真：像素角色的包围盒里有大片透明区，鼠标移过去会被"吃掉"、
 * 无法穿透到下层窗口，违背桌宠「不打扰」的前提。所以能声明就该声明。
 */

import type { SpriteHitArea, SpriteManifest } from "../model/sprite-manifest.js";

/** 二维点（与清单里 `SpriteHitArea.points` 的元素同型） */
export type Point2 = [number, number];

/**
 * 射线法：点是否在多边形内（含边界）。
 *
 * 边界算命中——桌宠的命中区通常贴着角色轮廓画，贴着边点一下却穿过去会很怪。
 * 用「点是否落在任一线段上」单独判边界，而不是依赖射线法的浮点巧合。
 */
export function pointInPolygon(x: number, y: number, points: readonly Point2[]): boolean {
  if (points.length < 3) return false;
  if (pointOnBoundary(x, y, points)) return true;

  // 标准射线法：向 +x 方向发一条射线，数穿越的边数，奇数为内
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    // 半开区间 [yi, yj) 避免顶点被数两次
    const straddles = yi > y !== yj > y;
    if (!straddles) continue;
    const xCross = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (x < xCross) inside = !inside;
  }
  return inside;
}

/** 点是否落在多边形边界（任一线段上） */
function pointOnBoundary(x: number, y: number, points: readonly Point2[]): boolean {
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    if (pointOnSegment(x, y, points[j], points[i])) return true;
  }
  return false;
}

/** 点到线段的最近距离是否为 0（带一个按坐标量级取的极小容差） */
function pointOnSegment(x: number, y: number, a: Point2, b: Point2): boolean {
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return x === ax && y === ay;
  // 投影参数夹到 [0,1]，得到线段上的最近点
  let t = ((x - ax) * dx + (y - ay) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + t * dx;
  const py = ay + t * dy;
  // 容差与坐标同量级：像素模型的坐标是几十到几百，1e-9 相对于它是精确的
  const EPS = 1e-9;
  return Math.abs(x - px) < EPS && Math.abs(y - py) < EPS;
}

/**
 * 模型姿态变换：把清单坐标映射到画布坐标所需的四个量。
 *
 * 画布上的位置 = `position + (manifestPoint − anchor) × scale`。
 * 反变换即 `manifestPoint = (canvasPoint − position) / scale + anchor`。
 */
export interface ModelTransform {
  /** 锚点在画布上的位置（CSS 像素） */
  positionX: number;
  positionY: number;
  /** 当前缩放（清单像素 → 画布像素） */
  scale: number;
  /** 清单里声明的锚点（清单像素） */
  anchorX: number;
  anchorY: number;
}

/** 画布局部坐标 → 清单坐标 */
export function toManifestPoint(
  canvasX: number,
  canvasY: number,
  t: ModelTransform,
): { x: number; y: number } {
  const s = t.scale === 0 ? 1 : t.scale;
  return {
    x: (canvasX - t.positionX) / s + t.anchorX,
    y: (canvasY - t.positionY) / s + t.anchorY,
  };
}

/** 清单坐标 → 画布局部坐标 */
export function toCanvasPoint(
  manifestX: number,
  manifestY: number,
  t: ModelTransform,
): { x: number; y: number } {
  return {
    x: t.positionX + (manifestX - t.anchorX) * t.scale,
    y: t.positionY + (manifestY - t.anchorY) * t.scale,
  };
}

/**
 * 取当前生效的 hitArea（按声明顺序，即优先级）。
 *
 * `frames` 省略表示对所有动画组生效；给出时只在该组内生效。
 *
 * @param group 当前动画组名；null（尚未播放任何动画）时只保留「对所有组生效」的项
 */
export function hitAreasForGroup(
  manifest: Pick<SpriteManifest, "hitAreas">,
  group: string | null,
): SpriteHitArea[] {
  const all = manifest.hitAreas ?? [];
  return all.filter((ha) => {
    if (!ha.frames || ha.frames.length === 0) return true;
    return group !== null && ha.frames.includes(group);
  });
}

/**
 * 在给定动画组下做多边形命中。
 *
 * **按声明顺序先命中者胜**（数组顺序即优先级）。重叠区域的行为因此是可预测的，
 * 不依赖数组遍历的偶然顺序。
 *
 * @param canvasX 画布局部坐标
 * @returns 命中的 hitArea id；未命中返回 null
 */
export function hitTestPolygons(
  manifest: Pick<SpriteManifest, "hitAreas">,
  group: string | null,
  canvasX: number,
  canvasY: number,
  transform: ModelTransform,
): string | null {
  const p = toManifestPoint(canvasX, canvasY, transform);
  for (const area of hitAreasForGroup(manifest, group)) {
    if (pointInPolygon(p.x, p.y, area.points)) return area.id;
  }
  return null;
}
