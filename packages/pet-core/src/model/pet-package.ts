/**
 * pet-package — 宠物安装包校验与安装计划（pet-core，零依赖）
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §5.1 / §7
 *
 * 安全模型：Agent 只能写工作区的 `outputs/`，由 `pet-asset install` 校验后搬运到
 * 用户宠物目录。本模块是那次搬运的**判断部分**（纯函数，可单测），实际读写留在 CLI。
 *
 * 两段式：
 *   validate  只读，报出全部问题，不写任何字节
 *   install   先跑 validate，通过才搬；搬运本身由 CLI 负责原子化
 *
 * 「校验不通过 → 装不上，但绝不影响渲染稳定性」靠三件事：
 *   1. 与运行时**共用同一份** `validateSpriteManifest`（安全边界单一落点）
 *   2. 安装计划的每条路径都经过越界检查，包内文件不能写到目标目录之外
 *   3. 包内清单不得引用包外文件（`atlas: "../../secret.png"` 这类必须挡在安装前）
 *
 * 包结构：
 *   manifest.json   渲染清单（sprite-manifest v1，严格白名单，安全边界）
 *   pet.json        可选信封：注册表侧字段（name/scale/动作组/表情映射/人设…）
 *   其它           图集与素材
 */

import type { PetModelConfig } from "./pet-model-types.js";
import { applyModelDefaults } from "./pet-model-types.js";
import type { SpriteManifest } from "./sprite-manifest.js";
import { validateSpriteManifest } from "./sprite-manifest.js";
import type { AtlasIndex } from "./atlas-index.js";
import { atlasFrameNames, parseAtlasIndex } from "./atlas-index.js";
import { normalizePetModelEntry } from "./pet-registry.js";

/** 渲染清单的约定文件名（包根） */
export const PET_PACKAGE_MANIFEST = "manifest.json";
/** 可选信封的约定文件名（包根） */
export const PET_PACKAGE_ENVELOPE = "pet.json";

/** 打包/系统垃圾文件，搬运时跳过 */
const JUNK_SEGMENTS = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "__MACOSX"]);
const JUNK_SUFFIX = /\.(tmp|bak|swp|orig)$/i;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

export interface PetPackageIssue {
  /** 可定位的路径（包内相对路径或清单字段路径） */
  path: string;
  message: string;
}

export interface PetPackageValidation {
  ok: boolean;
  errors: PetPackageIssue[];
  warnings: PetPackageIssue[];
  /** 仅在清单结构合法时给出 */
  manifest?: SpriteManifest;
}

export interface PetPackageContext {
  /** 包内文件列表（相对包根的路径，分隔符不限） */
  files: string[];
  /** 已解析的图集索引 JSON；省略则跳过「帧引用是否存在」的交叉校验 */
  atlasRaw?: unknown;
  /**
   * 图集图片是否含透明像素。省略则跳过「是否已抠底」的检查。
   * 由调用方解码图像后给出 —— pet-core 保持零依赖，不做图像解码。
   */
  atlasHasAlpha?: boolean;
}

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------
/** 控制字符（含 NUL）——路径与 id 一律不得含 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;


/**
 * 判断包内相对路径是否安全。
 *
 * 拒绝：绝对路径、盘符、URL scheme、`..` 上跳、NUL、空路径。
 * 这是「清单不得引用包外文件」的第一道闸——通过安装后这些文件会被
 * `lumii-pet://` 协议服务给渲染层，越界即等于把任意本地文件暴露出去。
 */
export function isSafePackagePath(p: unknown): p is string {
  if (typeof p !== "string") return false;
  if (p.length === 0 || p.length > 240) return false;
  if (CONTROL_CHARS.test(p)) return false;
  const norm = p.replace(/\\/g, "/");
  if (norm.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(norm)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(norm)) return false;
  return !norm.split("/").some((seg) => seg === "..");
}

/**
 * 判断模型 id 能否直接用作目录名。
 *
 * 各平台非法字符一并拒绝（Windows 最严），并禁止以点开头（避开 `.` / `..` 与隐藏目录）。
 * **只拒绝、不改写**——把非法 id 悄悄改写成合法目录名会让「注册表里的 id」与
 * 「磁盘上的目录」对不上，日后很难排查。
 */
export function isSafePackageId(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v.length === 0 || v.length > 64) return false;
  if (v.startsWith(".")) return false;
  if (CONTROL_CHARS.test(v)) return false;
  return !/[\\/:*?"<>|]/.test(v);
}

/** 拼接包内路径，越界返回 null */
export function joinPackagePath(base: string, rel: string): string | null {
  if (!isSafePackagePath(rel)) return null;
  const baseNorm = base.replace(/\\/g, "/").replace(/\/+$/, "");
  return baseNorm ? `${baseNorm}/${rel.replace(/\\/g, "/")}` : rel.replace(/\\/g, "/");
}

/** 是否为可跳过的垃圾文件 */
function isJunk(rel: string): boolean {
  const segs = rel.replace(/\\/g, "/").split("/");
  if (segs.some((s) => JUNK_SEGMENTS.has(s))) return true;
  return JUNK_SUFFIX.test(segs[segs.length - 1] ?? "");
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 校验一个宠物安装包。
 *
 * 一次报出全部问题：作者改一轮就能全过，不必「修一个报一个」。
 */
export function validatePetPackage(
  manifestRaw: unknown,
  ctx: PetPackageContext,
): PetPackageValidation {
  const errors: PetPackageIssue[] = [];
  const warnings: PetPackageIssue[] = [];

  // ---- 文件列表本身的可信性 ----
  const files = new Set<string>();
  for (const f of ctx.files) {
    if (!isSafePackagePath(f)) {
      errors.push({ path: String(f), message: "包内文件路径不合法（绝对路径/上跳/非法字符）" });
      continue;
    }
    if (!isJunk(f)) files.add(f.replace(/\\/g, "/"));
  }

  // ---- 图集索引用作交叉校验 ----
  let atlas: AtlasIndex | undefined;
  if (ctx.atlasRaw !== undefined) {
    const parsed = parseAtlasIndex(ctx.atlasRaw);
    if (!parsed.ok) {
      for (const msg of parsed.errors) errors.push({ path: "atlasJson", message: msg });
    } else {
      atlas = parsed.atlas;
    }
  }

  // ---- 清单引用的文件必须是包内相对路径 ----
  // 放在结构校验**之前**：`assets` 交叉校验对越界路径也会报「文件不存在」，
  // 但那个提示会把人引向「文件名写错了」，而真正的问题是「引用了包外文件」。
  // 这里先报，提示才指向正确的修法。
  if (isPlainObject(manifestRaw)) {
    for (const key of ["atlas", "atlasJson"] as const) {
      const v = manifestRaw[key];
      if (typeof v === "string" && !isSafePackagePath(v)) {
        errors.push({
          path: key,
          message: `必须是包内相对路径（不得为绝对路径、URL 或含 .. 上跳），收到 "${v}"`,
        });
      }
    }
  }

  // ---- 清单结构与交叉引用（与运行时同一份实现）----
  const result = validateSpriteManifest(manifestRaw, {
    assets: [...files],
    atlasFrames: atlas ? atlasFrameNames(atlas) : undefined,
  });
  if (!result.ok) {
    for (const e of result.errors) errors.push({ path: e.path, message: e.message });
    return { ok: false, errors, warnings };
  }
  const manifest = result.manifest;

  // ---- id 同时用作目录名 ----
  if (!isSafePackageId(manifest.id)) {
    errors.push({
      path: "id",
      message: `id 含路径分隔符或平台非法字符，不能作为目录名："${manifest.id}"`,
    });
  }

  // ---- 是否已抠底 ----
  // 设计 §7「抠底需背景色远离角色色 → 安装校验阶段做前置检查」的落点。
  // 到安装这一步图上已经没有背景了（要么已抠底，要么是待抠的原始图），
  // 所以这里能判的是「抠过了吗」；「抠得动吗」由 cutout 的穿透检测负责。
  if (ctx.atlasHasAlpha === false) {
    errors.push({
      path: "atlas",
      message: `图集 "${manifest.atlas}" 不含透明像素（未抠底），请先跑 pet-asset cutout`,
    });
  } else if (ctx.atlasHasAlpha === undefined) {
    warnings.push({
      path: "atlas",
      message: "未能读取图集透明度，跳过抠底检查",
    });
  }

  return { ok: errors.length === 0, errors, warnings, manifest };
}

// ---------------------------------------------------------------------------
// 安装计划
// ---------------------------------------------------------------------------

export interface PetInstallFile {
  /** 包内相对路径 */
  from: string;
  /** 目标相对路径（相对用户宠物目录） */
  to: string;
}

export interface PetInstallPlan {
  id: string;
  /** 目标目录名（相对用户宠物目录），等于 id */
  dirName: string;
  /** 需要搬运的文件 */
  files: PetInstallFile[];
  /** 要 upsert 进用户 registry.json 的条目（modelUrl 指向安装后的清单） */
  registryEntry: PetModelConfig;
  warnings: PetPackageIssue[];
}

/**
 * 生成安装计划。
 *
 * 纯函数：只算「搬哪些文件、写到哪、注册表条目长什么样」，不碰磁盘。
 *
 * @param manifest 已通过校验的清单
 * @param files 包内文件列表（相对包根）
 * @param envelopeRaw 已解析的 `pet.json`（可选）
 */
export function planPetInstall(
  manifest: SpriteManifest,
  files: string[],
  envelopeRaw?: unknown,
): PetInstallPlan {
  const warnings: PetPackageIssue[] = [];
  const dirName = manifest.id;

  // ---- 信封：注册表侧字段 ----
  // 信封是**部分**配置：id / rendererType / modelUrl 由清单与安装结果决定，作者不必写。
  // 先落这三项再交给归一器，归一器就既能补齐默认值、又天然无法被信封改写关键字段。
  const raw = isPlainObject(envelopeRaw) ? envelopeRaw : envelopeRaw === undefined ? {} : null;
  if (raw === null) {
    warnings.push({ path: "pet.json", message: "信封必须是对象，已忽略" });
  }
  const source = raw ?? {};
  const { entry, diagnostics } = normalizePetModelEntry({
    ...source,
    id: manifest.id,
    rendererType: "sprite",
    modelUrl: `${dirName}/${PET_PACKAGE_MANIFEST}`,
    name: isNonEmptyString(source.name) ? source.name : manifest.id,
  });
  for (const d of diagnostics) warnings.push({ path: "pet.json", message: d.message });
  const registryEntry = entry ?? applyFallbackEntry(manifest, dirName);

  // ---- 文件搬运清单 ----
  const planned: PetInstallFile[] = [];
  for (const f of files) {
    if (!isSafePackagePath(f) || isJunk(f)) continue;
    const rel = f.replace(/\\/g, "/");
    const to = joinPackagePath(dirName, rel);
    if (!to) {
      warnings.push({ path: rel, message: "路径不合法，已跳过" });
      continue;
    }
    planned.push({ from: rel, to });
  }

  return { id: manifest.id, dirName, files: planned, registryEntry, warnings };
}

/** 信封不可用时的兜底条目（只依赖清单，不含任何作者声明） */
function applyFallbackEntry(manifest: SpriteManifest, dirName: string): PetModelConfig {
  return applyModelDefaults({
    id: manifest.id,
    name: manifest.id,
    rendererType: "sprite",
    modelUrl: `${dirName}/${PET_PACKAGE_MANIFEST}`,
  });
}
