/**
 * sprite-runtime — 精灵清单的运行时解析（pet-core，零依赖）
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §5.2
 *
 * 把「清单 JSON」变成「渲染层可以直接套用的数据结构」。放在 pet-core 而不是渲染层，
 * 是因为这里面全是纯逻辑（帧增量归一、槽位状态、口型取档、缩放吸附），
 * 脱开 WebGL 就能单测；客户端只剩"把结果画出来"。
 *
 * **帧增量在加载期解析完**：清单里每帧只声明变化的槽位，若把这套 carry-forward 留到
 * 运行时，等于把一次算完的事摊到 60fps 的热路径上。这里一次性解析成全量帧快照。
 */

import type {
  SpriteAnimation,
  SpriteFrameRef,
  SpriteManifest,
  SpriteSlotDef,
} from "../model/sprite-manifest.js";
import type { ProceduralParams } from "./procedural-motion.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 某一帧的完整槽位状态（所有槽位都有值，无需再回看前一帧） */
export interface SlotState {
  /** base 槽的图集条目名（整体帧或无分层时的身体帧） */
  base: string;
  /** 分层槽：槽名 → 部件类别 → 部件名 */
  layered: Record<string, Record<string, string>>;
}

export interface ResolvedAnimation {
  group: string;
  /** 组内序号 = 在 `animationsByGroup` 里的下标 */
  index: number;
  kind: "loop" | "once";
  source: "frames" | "procedural";
  fps: number;
  /** 全量帧快照；仅 procedural 的动画为空数组 */
  frames: SlotState[];
  /**
   * 逐帧时长（毫秒），与 `frames` 按下标对齐；没有一帧声明过就是 `undefined`。
   *
   * 播放器优先用它，缺项时回落到 `1000 / fps`。**只有声明过的那几帧才带值**——
   * 全 0 填充会让「这一帧没写时长」和「这一帧时长是 0」分不开。
   */
  durationsMs?: number[];
  /** 程序化原语参数（可与 frames 并存） */
  params?: ProceduralParams;
  /** kind="once" 播完回到哪个组 */
  next?: string;
}

export interface SpriteRuntimeModel {
  manifest: SpriteManifest;
  /** 第一帧的落点（未播放任何动画前的姿态） */
  defaultState: SlotState;
  /**
   * 组名 → 该组的动画数组，**下标即 index**。
   * 作者用显式 `index` 跳过某些序号时，对应位置为 `undefined`（空位，取到返回 null）。
   */
  animationsByGroup: Map<string, (ResolvedAnimation | undefined)[]>;
  /**
   * 「待机不许浮动」规则**丢掉**了哪些声明（如 `["Idle:bob=9"]`）。
   *
   * 空数组 = 这个模型本来就干净。**非空就要让调用方看得见**（渲染器在加载时打一行
   * warn）——规则安静地改数据、作者还以为自己写的 bob 生效了，那是最难查的一类问题。
   */
  idleDriftStripped: string[];
}

// ---------------------------------------------------------------------------
// 待机不许浮动（产品规则，2026-09-22）
// ---------------------------------------------------------------------------

/** 哪些组算"待机"。按组名匹配（含大小写变体），见下方注释 */
const IDLE_GROUP_RE = /idle/i;

/**
 * 「待机不需要左右和上下移动」——用户的规则，**在这里一次性执行，而不是逐个模型改数据**。
 *
 * 为什么是规则而不是数据：`bob`（上下浮动）与 `sway`（左右轻摆）是**整只宠物的位移**，
 * 而待机该是"站在原地"的。逐个模型删参数的问题不是麻烦，是**会漏**——
 * 换个模型、重跑一次导入、宠物创作工具再导出一版，浮动就回来了，
 * 而症状（宠物在飘）与数据（某一行 params）之间隔着一整条链路。
 *
 * 实测过一次量级：`bob: 9` 不是 9px，而是**屏幕上 18px 的上下摆动**
 *（偏移量在渲染器的 stage 坐标里施加，不乘 scale），确实到"看着头晕"的量级。
 *
 * **判据是组名**：约定待机组的名字里带 `idle`（每个模型的 `idleMotionGroup` 默认就是
 * `Idle`）。想做一个"会飘"的动作当然可以，但那就**不该叫 idle**——名字对不上这条规则，
 * 也就对不上"待机"这个语义。
 *
 * 保留 `breathe`（缩放呼吸，锚点在脚底，头顶动 ~2px）与眨眼：它们不移动宠物。
 */
export function stripIdleDrift(
  group: string,
  params: ProceduralParams | undefined,
): { params: ProceduralParams | undefined; stripped: string[] } {
  if (!params || !IDLE_GROUP_RE.test(group)) return { params, stripped: [] };
  const stripped: string[] = [];
  const next: ProceduralParams = { ...params };
  if (next.bob !== undefined && next.bob !== 0) {
    stripped.push(`${group}:bob=${next.bob}`);
    delete next.bob;
  }
  if (next.sway !== undefined && next.sway !== 0) {
    stripped.push(`${group}:sway=${next.sway}`);
    delete next.sway;
  }
  return stripped.length > 0 ? { params: next, stripped } : { params, stripped: [] };
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/** 取分层槽定义（排除 base —— 它是特例，不属于 layered） */
function layeredSlotDefs(slots: SpriteManifest["slots"]): Record<string, SpriteSlotDef> {
  const out: Record<string, SpriteSlotDef> = {};
  for (const [name, def] of Object.entries(slots ?? {})) {
    if (name === "base") continue;
    if (def.kind === "layered") out[name] = def;
  }
  return out;
}

/**
 * 推导默认姿态：各槽位取**首个可用部件**。
 *
 * base 取「所有动画里第一个声明出来的 base 帧」——清单没有单独的"默认帧"字段，
 * 而第一帧若只声明了 face，base 就需要一个来源。取第一处声明比取空串更可用。
 */
function deriveDefaultState(manifest: SpriteManifest, layered: Record<string, SpriteSlotDef>): SlotState {
  let base = "";
  for (const anim of manifest.animations) {
    const hit = anim.frames?.find((f) => isNonEmptyString(f.base));
    if (hit && isNonEmptyString(hit.base)) {
      base = hit.base;
      break;
    }
  }

  const state: SlotState = { base, layered: {} };
  for (const [slotName, def] of Object.entries(layered)) {
    const cats: Record<string, string> = {};
    for (const [cat, names] of Object.entries(def.parts ?? {})) {
      const first = names.find(isNonEmptyString);
      if (first) cats[cat] = first;
    }
    state.layered[slotName] = cats;
  }
  return state;
}

/** 深拷一层（layered 只有两层，手写比 structuredClone 快且语义明确） */
function cloneState(s: SlotState): SlotState {
  const layered: Record<string, Record<string, string>> = {};
  for (const [slot, cats] of Object.entries(s.layered)) layered[slot] = { ...cats };
  return { base: s.base, layered };
}

/**
 * 把一帧的增量声明套用到前一帧状态上。
 *
 * 非 base 槽位支持两种写法：
 *   - `{ face: { eyes: "happy" } }` —— 明确指定部件类别（推荐的写法）
 *   - `{ face: "happy" }` —— 该槽位**只有唯一部件类别**时的简写；类别多于一个时无法
 *     判断指的是哪个，此时忽略（清单校验会拦住这种写法）
 */
export function applyFrameRef(
  prev: SlotState,
  ref: SpriteFrameRef,
  layered: Record<string, SpriteSlotDef>,
): SlotState {
  const next = cloneState(prev);

  if (isNonEmptyString(ref.base)) next.base = ref.base;

  for (const [slotName, value] of Object.entries(ref)) {
    if (slotName === "base") continue;
    const def = layered[slotName];
    if (!def) continue; // 未声明的槽位：忽略（应由清单校验拦下）

    if (isPlainObject(value)) {
      const cats = next.layered[slotName] ?? {};
      for (const [cat, partName] of Object.entries(value)) {
        if (isNonEmptyString(partName)) cats[cat] = partName;
      }
      next.layered[slotName] = cats;
      continue;
    }

    if (isNonEmptyString(value)) {
      const cats = Object.keys(def.parts ?? {});
      if (cats.length === 1) {
        next.layered[slotName] = { ...(next.layered[slotName] ?? {}), [cats[0]]: value };
      }
    }
  }

  return next;
}

/** 解析单个动画的帧序列（含第一帧取默认态、其后沿用前帧） */
function resolveAnimationFrames(
  anim: SpriteAnimation,
  defaults: SlotState,
  layered: Record<string, SpriteSlotDef>,
): SlotState[] {
  const raw = anim.frames ?? [];
  const out: SlotState[] = [];
  let prev = defaults;
  for (const ref of raw) {
    const state = applyFrameRef(prev, ref, layered);
    out.push(state);
    prev = state;
  }
  return out;
}

/**
 * 抽出逐帧时长。**一帧都没声明就返回 `undefined`**，不返回一个全零数组——
 * 播放器靠 `undefined` 判断「这条动画走均速」，全零数组会让每一帧的时长都是 0。
 */
function resolveFrameDurations(anim: SpriteAnimation): number[] | undefined {
  const raw = anim.frames ?? [];
  if (!raw.some((f) => typeof f.durationMs === "number" && f.durationMs > 0)) return undefined;
  return raw.map((f) => (typeof f.durationMs === "number" && f.durationMs > 0 ? f.durationMs : 0));
}

/** 推断动画来源：显式声明优先，否则按有无 frames 判断 */
function resolveSource(anim: SpriteAnimation): "frames" | "procedural" {
  if (anim.source) return anim.source;
  return anim.frames && anim.frames.length > 0 ? "frames" : "procedural";
}

/**
 * 建立「组 → 动画数组」索引。
 *
 * 数组下标即 `playMotion(group, index)` 的 index，与 Live2D 的动作组语义一致。
 * `index` 显式声明时落在该位置，未声明时接在前一个之后——两种写法可以在同一组里混用，
 * 混用时以显式声明为准：声明过的位置不会被自动编号占掉。
 *
 * **显式 index 之间留空是允许的**（该序号没有动画），空位原样保留而不是压缩——
 * 压缩会把作者写的 `index: 1` 悄悄变成下标 0，属于"配置看起来生效了但其实错位"。
 * 取到空位由 `findAnimation` 返回 null，计数与随机播放走 `animatedIndices`。
 */
function buildGroupIndex(
  entries: { anim: ResolvedAnimation; declaredIndex?: number }[],
): Map<string, (ResolvedAnimation | undefined)[]> {
  const byGroup = new Map<string, (ResolvedAnimation | undefined)[]>()
  // 游标 = 该组下一个自动编号的位置
  const cursors = new Map<string, number>()

  for (const { anim, declaredIndex } of entries) {
    const list = byGroup.get(anim.group) ?? []
    byGroup.set(anim.group, list)

    const at =
      typeof declaredIndex === "number" && declaredIndex >= 0
        ? declaredIndex
        : (cursors.get(anim.group) ?? 0)

    while (list.length < at) list.push(undefined)
    list[at] = anim
    anim.index = at
    cursors.set(anim.group, at + 1)
  }

  return byGroup
}

/** 解析清单为运行时模型（纯函数，可重复调用） */
export function resolveSpriteRuntime(manifest: SpriteManifest): SpriteRuntimeModel {
  const layered = layeredSlotDefs(manifest.slots);
  const defaultState = deriveDefaultState(manifest, layered);

  /** 「待机不许浮动」规则丢掉的东西，逐条记下来给调用方（见 stripIdleDrift） */
  const idleDriftStripped: string[] = [];

  const entries = manifest.animations.map((anim) => {
    const still = stripIdleDrift(anim.group, anim.params);
    idleDriftStripped.push(...still.stripped);
    return {
      declaredIndex: typeof anim.index === "number" ? anim.index : undefined,
      anim: {
        group: anim.group,
        index: 0,
        kind: anim.kind,
        source: resolveSource(anim),
        fps: anim.fps && anim.fps > 0 ? anim.fps : 8,
        frames: resolveAnimationFrames(anim, defaultState, layered),
        durationsMs: resolveFrameDurations(anim),
        // 规则在这里生效：**只在解析层做一次**，渲染器拿到的 params 已经是干净的
        params: still.params,
        next: anim.next,
      } satisfies ResolvedAnimation,
    };
  });

  return {
    manifest,
    defaultState,
    animationsByGroup: buildGroupIndex(entries),
    idleDriftStripped,
  };
}

// ---------------------------------------------------------------------------
// 运行时取值助手
// ---------------------------------------------------------------------------

/** 某组内所有**有效**的 index（跳过显式 index 留下的空位） */
export function animatedIndices(model: SpriteRuntimeModel, group: string): number[] {
  const list = model.animationsByGroup.get(group);
  if (!list) return [];
  const out: number[] = [];
  list.forEach((a, i) => {
    if (a) out.push(i);
  });
  return out;
}

/** 取某组的动画数量（getMotionCount 用；跳过空位；组不存在返回 0） */
export function motionCount(model: SpriteRuntimeModel, group: string): number {
  return animatedIndices(model, group).length;
}

/** 取某组某个 index 的动画；index 省略取该组第一个有效项；落在空位返回 null */
export function findAnimation(
  model: SpriteRuntimeModel,
  group: string,
  index?: number,
): ResolvedAnimation | null {
  const list = model.animationsByGroup.get(group);
  if (!list || list.length === 0) return null;
  if (index === undefined) return list.find((a) => a !== undefined) ?? null;
  return list[index] ?? null;
}

/** 随机取一个有效 index（组内无动画返回 -1）。`rand` 可注入以便测试确定性。 */
export function randomAnimationIndex(
  model: SpriteRuntimeModel,
  group: string,
  rand: () => number = Math.random,
): number {
  const indices = animatedIndices(model, group);
  if (indices.length === 0) return -1;
  return indices[Math.min(indices.length - 1, Math.floor(rand() * indices.length))];
}

/** 全部组名（待机轮播等场景需要枚举） */
export function motionGroups(model: SpriteRuntimeModel): string[] {
  return [...model.animationsByGroup.keys()];
}

/**
/**
 * 槽位覆盖：叠在帧快照之上的单点改写（表情、口型都走它）。
 */
export interface SlotOverride {
  slot: string;
  cat: string;
  part: string;
}

/**
 * 把覆盖层叠到一份槽位快照上，返回新的快照。
 *
 * **为什么需要这一层**：动画每推进一帧都会整份套用帧快照，若表情/口型直接改快照，
 * 下一帧就被冲掉——表现是「表情设了没反应」或「说话时嘴在闪」。Live2D 那边表情
 * 也是独立于动作的层，语义上要对齐。
 *
 * 覆盖层按数组顺序应用，后写的赢。
 */
export function applyOverrides(state: SlotState, overrides: readonly SlotOverride[]): SlotState {
  if (overrides.length === 0) return state;
  const next = cloneState(state);
  for (const o of overrides) {
    if (!o.part) continue;
    next.layered[o.slot] = { ...(next.layered[o.slot] ?? {}), [o.cat]: o.part };
  }
  return next;
}

/**
 * 口型档位映射：`setMouthOpen(0~1)` → 档位下标。
 *
 * 按档位数等分：`floor(value × levels)`，末档夹住（value=1 → 最后一档）。
 * 档数由模型自定（像素风常见 2–3 档），不写死。
 *
 * @param value 张开度，会被夹到 [0,1]
 * @param levels 档位数（`mouthLevels.length`）
 * @returns 档位下标；levels ≤ 0 时返回 -1（表示该模型没有口型档）
 */
export function mouthLevelIndex(value: number, levels: number): number {
  if (levels <= 0) return -1;
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return Math.min(levels - 1, Math.floor(v * levels));
}

/**
 * 像素风的缩放吸附：取 ≥1 的整数。
 *
 * 像素素材只有在整数倍下才是"每个源像素对应整数个屏幕像素"，非整数倍会出现
 * 一列像素比相邻列宽 1 个屏幕像素的锯齿感——这不是审美问题，是可测量的失真。
 * 非像素模型不走这里（连续缩放）。
 */
export function snapPixelScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.max(1, Math.round(scale));
}

/**
 * 计算自适应缩放：把模型高度压进视口上限内。
 *
 * @param maxRatio 视口高度的占比上限。默认 0.78 是**沿用 Live2D 后端**的口径
 *   （那边是站姿全身角色，占屏高七八成是常态）；sprite 桌宠是小体量陪衬，
 *   调用方应传一个更小的值，否则一个配错 scale 的模型能占满整屏。
 * @param pixelArt 像素模型取整（见 snapPixelScale）
 */
export function adaptiveScale(
  naturalHeight: number,
  viewportHeight: number,
  requestedScale: number,
  pixelArt: boolean,
  maxRatio = 0.78,
): number {
  let s = requestedScale > 0 ? requestedScale : 1;
  const rendered = naturalHeight * s;
  const max = viewportHeight * maxRatio;
  if (naturalHeight > 0 && rendered > max) s = max / naturalHeight;
  return pixelArt ? snapPixelScale(s) : s;
}
