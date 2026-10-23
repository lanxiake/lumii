/**
 * pose-units — 姿态角度在**渲染器边界**上的单位换算。
 *
 * pet-core 的姿态原语（程序化旋转、注视倾斜）一律以**度**为单位（见
 * `procedural-motion.ts` 的 `ProceduralTransform.rotation` 注释），而 PIXI 的
 * `Container.rotation` 要**弧度**——两者只在这个边界上交汇，换算必须做，而且只做一次。
 *
 * 这个换算曾经漏掉，且长期没暴露：所有模型都没声明 sway/nod，`transform.rotation`
 * 恒为 0，写不写换算都一样。P2-b 加入注视后才第一次有非零值进来，症状是
 * **宠物朝光标的反方向歪**（±6° 当成 ±6 弧度 ≡ ∓16°，方向相反、幅度还更大）。
 */

/** 度 → 弧度 */
export const DEG_TO_RAD = Math.PI / 180

/**
 * 把若干个以**度**表示的旋转分量合成为 PIXI 的 `rotation`（**弧度**）。
 *
 * 收成一个函数是为了让"这里要换算"在读代码时无法忽略——散在调用点上的
 * `* DEG_TO_RAD` 很容易在下一次编辑里被顺手删掉。
 */
export function poseRotationRadians(...degParts: number[]): number {
  let deg = 0
  for (const part of degParts) if (Number.isFinite(part)) deg += part
  return deg * DEG_TO_RAD
}
