/**
 * pet-registry — 两段式宠物注册表合并（pet-core，零依赖）
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §5.1
 *
 * 宠物模型有两个来源：随包发布的内置目录（只读）与用户宠物目录（可写）。
 * 本模块负责把两份 `registry.json` 合并成一张列表，规则：
 *
 *   1. 同 id 用户版本覆盖内置（内置项位置不变，用户在此处替换）
 *   2. 用户新增的条目追加在列表尾部 —— 用户加宠物不会让既有列表跳位
 *   3. `defaultModelId` 三级回退：用户声明且存在 → 内置声明且存在 → 列表首项
 *   4. **单条坏数据只跳过该条**，记诊断，不拖垮整张表
 *
 * 第 4 条是硬性要求：注册表是手写/机器生成的 JSON，一份写错的表不能让宠物模式
 * 整体失效。调用方拿到 `diagnostics` 后自行决定是打日志还是提示用户。
 *
 * **不做 URL 解析**——两个来源的 base 目录不同（内置在 resources/，用户在
 * userData/），解析必须在客户端层按 `source` 分别处理。本模块保持纯函数。
 */

import type { PetModelConfig, PetRendererType, PetModelSource } from "./pet-model-types.js";
import { applyModelDefaults } from "./pet-model-types.js";

/** 合并后的模型条目：在配置之上带来源标记 */
export interface MergedPetModel extends PetModelConfig {
  source: PetModelSource;
  /** true = 该用户条目覆盖了一个同 id 的内置模型（供「恢复内置版本」用） */
  shadowedBuiltin?: boolean;
}

export interface PetRegistryDiagnostic {
  level: "warn" | "error";
  /** 问题所属来源 */
  source: PetModelSource;
  /** 出问题的模型 id；表级问题省略 */
  id?: string;
  message: string;
}

export interface MergedPetRegistry {
  models: MergedPetModel[];
  defaultModelId: string;
  diagnostics: PetRegistryDiagnostic[];
}

interface ReadResult {
  models: PetModelConfig[];
  defaultModelId: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const isRendererType = (v: unknown): v is PetRendererType => v === "live2d" || v === "sprite";

/**
 * 读取单份注册表。
 *
 * @param input 已解析的 JSON（`unknown` —— 注册表来自用户目录，必须当不可信输入）
 */
function readRegistry(
  input: unknown,
  source: PetModelSource,
  diagnostics: PetRegistryDiagnostic[],
): ReadResult {
  if (input === null || input === undefined) return { models: [], defaultModelId: "" };

  if (!isPlainObject(input)) {
    diagnostics.push({ level: "error", source, message: "注册表必须是对象" });
    return { models: [], defaultModelId: "" };
  }
  if (!Array.isArray(input.models)) {
    diagnostics.push({ level: "error", source, message: "注册表缺少 models 数组" });
    return { models: [], defaultModelId: "" };
  }

  const models: PetModelConfig[] = [];
  const seen = new Set<string>();

  input.models.forEach((raw, i) => {
    const cfg = normalizeEntry(raw, source, i, diagnostics);
    if (!cfg) return;
    if (seen.has(cfg.id)) {
      diagnostics.push({
        level: "warn",
        source,
        id: cfg.id,
        message: `同一注册表内 id 重复（models[${i}]），已忽略后一条`,
      });
      return;
    }
    seen.add(cfg.id);
    models.push(cfg);
  });

  const defaultModelId = isNonEmptyString(input.defaultModelId) ? input.defaultModelId : "";
  if (defaultModelId && !seen.has(defaultModelId)) {
    diagnostics.push({
      level: "warn",
      source,
      message: `defaultModelId "${defaultModelId}" 不在本注册表中`,
    });
  }

  return { models, defaultModelId };
}

/**
 * 注册表允许出现的字段白名单。
 *
 * 未知字段**静默丢弃**（不报错）——注册表比清单宽松：它允许作者留注释性字段、
 * 也允许未来版本新增字段。真正需要严加看守的是会进入渲染解释器的清单
 * （见 sprite-manifest.ts），注册表只是配置。但「丢弃」而非「透传」是底线：
 * 透传会让任意字段流到渲染层。
 */
const ENTRY_KEYS = [
  "id", "name", "rendererType", "modelUrl",
  "scale", "idleMotionGroup", "idleMotionFallbackGroup", "idleMotionRandomGroups",
  "talkMotionGroup", "emotionMap", "tapMotions", "defaultExpression", "actionMotions",
  "agentId", "personaAddon", "toolPrompts", "thumbnailUrl",
] as const satisfies readonly (keyof PetModelConfig)[];

/** 校验并归一单条模型配置；不合法返回 null 并记诊断 */
function normalizeEntry(
  raw: unknown,
  source: PetModelSource,
  index: number,
  diagnostics: PetRegistryDiagnostic[],
): PetModelConfig | null {
  const at = `models[${index}]`;
  if (!isPlainObject(raw)) {
    diagnostics.push({ level: "error", source, message: `${at} 必须是对象` });
    return null;
  }

  const fail = (message: string, id?: string): null => {
    diagnostics.push({ level: "error", source, id, message: `${at} ${message}` });
    return null;
  };

  if (!isNonEmptyString(raw.id)) return fail("缺少非空 id");
  const id = raw.id;
  if (!isNonEmptyString(raw.name)) return fail("缺少非空 name", id);
  if (!isNonEmptyString(raw.modelUrl)) return fail("缺少非空 modelUrl", id);
  // rendererType 缺省视为 live2d：与既有注册表行为一致（老条目不带该字段）
  if (raw.rendererType !== undefined && !isRendererType(raw.rendererType)) {
    return fail(`rendererType 必须是 "live2d" 或 "sprite"，收到 ${JSON.stringify(raw.rendererType)}`, id);
  }

  const picked: Record<string, unknown> = {};
  for (const k of ENTRY_KEYS) {
    if (raw[k] !== undefined) picked[k] = raw[k];
  }

  return applyModelDefaults({
    ...(picked as Partial<PetModelConfig>),
    id,
    name: raw.name,
    modelUrl: raw.modelUrl,
    rendererType: isRendererType(raw.rendererType) ? raw.rendererType : "live2d",
  });
}

/**
 * 归一单条模型配置（校验 + 补默认值 + 白名单过滤）。
 *
 * 注册表单条与安装包信封（`pet.json`）共用这一份归一逻辑，避免两处各写一套
 * 校验后慢慢跑偏。
 *
 * @returns 成功给出配置与可能伴随的警告；失败给出错误诊断
 */
export function normalizePetModelEntry(raw: unknown): {
  entry?: PetModelConfig;
  diagnostics: PetRegistryDiagnostic[];
} {
  const diagnostics: PetRegistryDiagnostic[] = [];
  const entry = normalizeEntry(raw, "user", 0, diagnostics);
  return entry ? { entry, diagnostics } : { diagnostics };
}

/**
 * 合并内置与用户两份注册表。
 *
 * @param builtin 已解析的内置注册表 JSON（可为 null —— 内置目录缺失不应报错）
 * @param user 已解析的用户注册表 JSON（可为 null —— 绝大多数用户不会有）
 */
export function mergePetRegistries(builtin: unknown, user: unknown): MergedPetRegistry {
  const diagnostics: PetRegistryDiagnostic[] = [];
  const b = readRegistry(builtin, "builtin", diagnostics);
  const u = readRegistry(user, "user", diagnostics);

  const userById = new Map(u.models.map((m) => [m.id, m]));

  // 内置顺序在前；被用户覆盖的在原位置替换，保持列表顺序稳定
  const overridden = new Set<string>();
  const models: MergedPetModel[] = b.models.map((m) => {
    const override = userById.get(m.id);
    if (!override) return { ...m, source: "builtin" };
    overridden.add(m.id);
    return { ...override, source: "user", shadowedBuiltin: true };
  });

  // 用户新增的追加在后
  for (const m of u.models) {
    if (!overridden.has(m.id)) models.push({ ...m, source: "user" });
  }

  // defaultModelId 三级回退
  const ids = new Set(models.map((m) => m.id));
  let defaultModelId = "";
  if (u.defaultModelId && ids.has(u.defaultModelId)) defaultModelId = u.defaultModelId;
  else if (b.defaultModelId && ids.has(b.defaultModelId)) defaultModelId = b.defaultModelId;
  else defaultModelId = models[0]?.id ?? "";

  return { models, defaultModelId, diagnostics };
}
