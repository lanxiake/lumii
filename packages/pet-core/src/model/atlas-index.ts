/**
 * atlas-index — 图集索引 JSON 解析（pet-core，零依赖）
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §5.2
 *
 * 图集索引由外部工具产出，主流两种格式都认：
 *
 *   TexturePacker "JSON Hash" / Phaser 3   { frames: { "idle_00": { frame: {x,y,w,h} } } }
 *   TexturePacker "JSON Array" / Aseprite  { frames: [ { filename, frame: {x,y,w,h} } ] }
 *
 * 两者只在 `frames` 是对象还是数组上不同，条目的矩形字段都是 `frame: {x,y,w,h}`，
 * 故一份解析同时覆盖（Aseprite 1.2 用 `frame` 而非 `filename`，这里只认 `filename`）。
 *
 * **帧名别名**：图集工具常把 `idle_00.png` 原样作为键，而清单里写的是 `idle_00`。
 * 直接按字面比对会让作者被迫记住工具的命名癖好，所以 `atlasFrameNames()` 同时
 * 给出原名与去掉图片扩展名的别名，交叉校验时两者都算命中。
 */

export interface AtlasFrame {
  /** 图集内的条目名（原样，未做任何归一） */
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasIndex {
  /** 图集图片文件名（`meta.image`），可能省略 */
  image?: string;
  /** 图集画布尺寸（`meta.size`） */
  size?: { w: number; h: number };
  frames: AtlasFrame[];
}

export type AtlasParseResult =
  | { ok: true; atlas: AtlasIndex }
  | { ok: false; errors: string[] };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const isNonNegInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

/** 可被当作图片扩展名从帧名里去掉的后缀 */
const IMAGE_EXT = /\.(png|webp|jpe?g|gif|bmp|avif)$/i;

/** 从单条图集条目里取矩形；任意字段不合法返回 null */
function readRect(entry: unknown): { x: number; y: number; w: number; h: number } | null {
  if (!isPlainObject(entry)) return null;
  const f = entry.frame;
  // 少数工具把矩形平铺在条目上（无 frame 包裹）
  const r = isPlainObject(f) ? f : entry;
  const { x, y, w, h } = r as Record<string, unknown>;
  if (!isNonNegInt(x) || !isNonNegInt(y) || !isNonNegInt(w) || !isNonNegInt(h)) return null;
  if (w === 0 || h === 0) return null;
  return { x, y, w, h };
}

/**
 * 解析图集索引。
 *
 * 条目不合法时**跳过该条并记错误**，而不是整份失败——一份图集里混进几条坏数据，
 * 不应该让整个模型装不上，错误信息会带着条目名报到作者面前。
 */
export function parseAtlasIndex(input: unknown): AtlasParseResult {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [`图集索引必须是对象，收到 ${describe(input)}`] };
  }

  const rawFrames = input.frames;
  let entries: { name: unknown; entry: unknown; at: string }[];

  if (Array.isArray(rawFrames)) {
    entries = rawFrames.map((entry, i) => ({
      name: isPlainObject(entry) ? entry.filename : undefined,
      entry,
      at: `frames[${i}]`,
    }));
  } else if (isPlainObject(rawFrames)) {
    entries = Object.entries(rawFrames).map(([name, entry]) => ({ name, entry, at: `frames["${name}"]` }));
  } else {
    return { ok: false, errors: ['图集索引缺少 frames（对象或数组）'] };
  }

  if (entries.length === 0) {
    return { ok: false, errors: ["图集索引的 frames 为空"] };
  }

  const errors: string[] = [];
  const frames: AtlasFrame[] = [];
  const seen = new Set<string>();

  for (const { name, entry, at } of entries) {
    if (!isNonEmptyString(name)) {
      errors.push(`${at} 缺少条目名（数组格式需要 filename 字段）`);
      continue;
    }
    const rect = readRect(entry);
    if (!rect) {
      errors.push(`${at} 的矩形不合法（需要 frame: {x, y, w, h} 四个非负整数，且宽高不为 0）`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`${at} 条目名 "${name}" 重复`);
      continue;
    }
    seen.add(name);
    frames.push({ name, ...rect });
  }

  const meta = isPlainObject(input.meta) ? input.meta : undefined;
  const atlas: AtlasIndex = { frames };
  if (meta && isNonEmptyString(meta.image)) atlas.image = meta.image;
  if (meta && isPlainObject(meta.size)) {
    const { w, h } = meta.size as Record<string, unknown>;
    if (isNonNegInt(w) && isNonNegInt(h)) atlas.size = { w, h };
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, atlas };
}

/**
 * 图集里所有可被清单引用的名字：条目原名 + 去掉图片扩展名的别名。
 *
 * 供 `validateSpriteManifest({ atlasFrames })` 做交叉校验用。别名与原名冲突时
 * 两个名字都保留（都指向真实存在的条目，命中哪个都对）。
 */
export function atlasFrameNames(atlas: AtlasIndex): string[] {
  const names = new Set<string>();
  for (const f of atlas.frames) {
    names.add(f.name);
    const stripped = f.name.replace(IMAGE_EXT, "");
    if (stripped) names.add(stripped);
  }
  return [...names];
}

/** 按名字查帧（原名优先，其次去扩展名匹配） */
export function findAtlasFrame(atlas: AtlasIndex, name: string): AtlasFrame | null {
  for (const f of atlas.frames) if (f.name === name) return f;
  for (const f of atlas.frames) if (f.name.replace(IMAGE_EXT, "") === name) return f;
  return null;
}

/** 供错误信息用的类型描述（不泄露内容，只说明类型） */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "数组";
  if (typeof v === "string") return `字符串("${v.slice(0, 20)}")`;
  return typeof v;
}
