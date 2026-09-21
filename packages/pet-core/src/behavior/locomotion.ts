/**
 * locomotion — 地面行走的运动学（pet-core，零依赖）
 *
 * 自主行为只有水平位移这一件事需要积分：垂直方向（拖拽/抛掷/自由落体）已经由
 * `interaction/throw-physics.ts` 的 `stepThrow` 负责，两套坐标系一致，不要重复实现。
 *
 * 与 `stepThrow` 的分工：那边是**一次性**的抛物线（有初速、会落地、能量衰减），
 * 这边是**持续**的匀速行走（恒速、遇墙折返、不会自己停）。合并会让两者的参数
 * 互相污染——行走不需要重力与弹性系数。
 *
 * 约束（务必保持）：本包为纯 TS，禁止 import 任何运行时依赖。
 */

/** 地面上的行走者 */
export interface GroundWalker {
  /** 水平位置（画布像素，锚点所在的 X） */
  x: number
  /** 朝向：-1 面向左，+1 面向右。**只用于渲染翻转，不参与位移** */
  facing: -1 | 1
}

/**
 * 行走边界（画布像素）。
 *
 * 与 `ThrowBounds` 的区别：那边是**物体**的边界（含左右反弹），这边是**脚**的边界。
 * 桌宠贴在屏幕边上时，身体可以有一半在屏幕外——只要脚还在界内即可，
 * 所以这里由调用方按模型宽度自己收窄，本模块不假设任何尺寸。
 */
export interface WalkBounds {
  minX: number
  maxX: number
}

export interface WalkStepResult extends GroundWalker {
  /** 这一步是否碰到了边界（碰到时会自动折返，调用方据此可决定要不要停） */
  hitBoundary: boolean
}

/**
 * 单步积分上限（秒）。
 *
 * 与 `PetCanvas` 的抛物线同一个理由：标签页切回来、断点续跑时两帧间隔可能是几秒，
 * 不夹住的话宠物会一步跨到屏幕外——而边界夹取只能救回位置，救不回"看起来闪现了一下"。
 * 放在这里而不是交给调用方，是因为"一步跨出屏幕"正是这段数学的直接后果。
 */
const MAX_STEP_SEC = 0.05;

/**
 * 走一步。
 *
 * 语义是「沿当前朝向匀速前进，碰到边界就**折返**」。折返写在这里而不是交给调用方，
 * 因为它是桌宠的固有语义（参考项目 `PetPhysicsEngine` 撞墙分支同样直接改 `facing`），
 * 拆成两步的话，中间那一帧会渲染出"贴着墙继续朝墙走"的错误姿势。
 *
 * @param dtSec 时间增量（秒）；内部夹到 50ms 上限
 * @returns 新的位置与朝向；`hitBoundary` 为 true 表示这一步发生了折返
 */
export function stepWalk(
  walker: GroundWalker,
  dtSec: number,
  speedPxPerSec: number,
  bounds: WalkBounds,
): WalkStepResult {
  const dt = Math.min(MAX_STEP_SEC, Math.max(0, dtSec));
  const dx = speedPxPerSec * dt * walker.facing;
  let x = walker.x + dx;
  let facing = walker.facing;
  let hitBoundary = false;

  // 边界可能被调用方写反（minX > maxX），此时两个分支都会命中——夹到 minX 即可，
  // 不交换，理由同 ambient.ts 的 activityDuration：配置错误要能被看出来
  if (x <= bounds.minX) {
    x = bounds.minX;
    facing = 1;
    hitBoundary = true;
  } else if (x >= bounds.maxX) {
    x = bounds.maxX;
    facing = -1;
    hitBoundary = true;
  }

  return { x, facing, hitBoundary };
}

/**
 * 边界收窄：把"画布边界"换算成"脚能到的地方"。
 *
 * 抽出来是因为它有一个容易搞反的地方：**锚点在脚底中心**，所以左右各留
 * `anchorX` 而不是半个宽度。模型的锚点不在正中时（清单允许），用半宽会算歪。
 *
 * @param canvasWidth 画布宽度（CSS 像素）
 * @param anchorX 锚点在清单坐标里的 X（= 模型画布内的脚底中心）
 * @param scale 当前缩放
 * @param margin 额外留白（像素），避免脚正好压在屏幕边缘上
 */
export function walkBoundsOf(
  canvasWidth: number,
  anchorX: number,
  scale: number,
  margin = 0,
): WalkBounds {
  const half = Math.max(0, anchorX * scale) + margin;
  // 画布比模型还窄时（极端缩放下可能），退化为"钉在中间"而不是给出反向区间
  if (half * 2 >= canvasWidth) {
    const mid = canvasWidth / 2;
    return { minX: mid, maxX: mid };
  }
  return { minX: half, maxX: canvasWidth - half };
}
