import { Ajv } from "ajv";
// semver 本体不带类型、@types/semver 不在本机离线缓存里。只用到 satisfies 一个函数，
// 用 @ts-ignore 就地收窄签名，比为一个函数新增依赖或手写 semver 区间匹配都稳。
// 用 ts-ignore 而非 ts-expect-error：将来类型补上时不会反过来报「未使用」。
// @ts-ignore -- semver 无类型声明
import semverSatisfies from "semver/functions/satisfies.js";
import { ManifestValidationError } from "./errors.js";

/**
 * 插件清单（唯一真源）。
 *
 * 刻意**不含** permissions 字段：本项目是自用客户端，插件与主进程同权限，
 * 写一份不生效的权限清单只会制造虚假安全感。
 */

export type ActivationEvent =
  | "onStartup"
  | `onView:${string}`
  | `onCommand:${string}`
  | `onTool:${string}`
  | `onChannel:${string}`;

export interface PluginContributions {
  tools?: Array<{ name: string; description: string }>;
  commands?: Array<{ command: string; description: string; risk: "read" | "write" | "sensitive" }>;
  services?: Array<{ key: string }>;
  events?: Array<{ name: string }>;
  jobs?: Array<{ id: string; schedule?: string }>;
  ipc?: Array<{ method: string; description?: string }>;
  views?: Array<{ id: string; title: string }>;
  settings?: Array<{ id: string; title: string }>;
  cards?: Array<{ type: string }>;
  slots?: Array<{ slot: string; id: string }>;
}

export interface LumiiPluginManifest {
  /** 全局唯一，反向域名：`com.lumii.cloud-sync` */
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  /**
   * 来源标记：`agent` = 客户端 Agent 自举开发，`user` = 用户手写，
   * `official` = 随安装包分发的官方可选扩展。
   * 只是展示/治理用，**不是权限**——三者同权限（决策 D1/D2）。
   */
  origin?: "agent" | "user" | "official";
  author?: string;
  /** 宿主版本范围，semver range */
  engines: { lumii: string };
  kind: "code" | "asset";
  /** 主进程入口，相对插件根目录 */
  main?: string;
  client?: { entry: string; styles?: string[] };
  /** 省略 = ["onStartup"] */
  activation?: ActivationEvent[];
  /**
   * 运行时依赖：由「运行时组件」（插件中心的资产）提供，例如录屏扩展 → ffmpeg。
   *
   * 只用于设置页展示与安装引导，**不是加载门槛**——缺了也照常激活，
   * 由扩展自己决定降级路径（ffmpeg 就有包内/系统 PATH 两级回退）。
   */
  requires?: {
    /** 资产 id（见 `plugins-registry`） */
    assets?: string[];
    /** 缺省视为必需；true 表示未安装也能工作（有回退路径） */
    optional?: boolean;
  };
  contributes?: PluginContributions;
  configSchema?: Record<string, unknown>;
  /** 内置功能迁移期的过渡开关 */
  disabled?: boolean;
}

/** 只校验「结构 + 必需字段」，逐字段类型交给下面的语义检查，避免 schema 与类型两处维护。 */
const MANIFEST_SCHEMA = {
  type: "object",
  required: ["id", "name", "version", "engines", "kind"],
  additionalProperties: true,
  properties: {
    id: { type: "string", pattern: "^[a-z0-9]+([.-][a-z0-9]+)+$" },
    name: { type: "string", minLength: 1 },
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+" },
    engines: {
      type: "object",
      required: ["lumii"],
      properties: { lumii: { type: "string" } },
    },
    kind: { type: "string", enum: ["code", "asset"] },
  },
};

const ajv = new Ajv({ allErrors: true });
const validateStructure = ajv.compile(MANIFEST_SCHEMA);

export interface ValidateManifestOptions {
  /** 宿主版本；给了才校验 engines.lumii */
  appVersion?: string;
  /**
   * 内置扩展：静态 import 进主进程，没有可加载的入口文件。
   *
   * 内置扩展**不要**写 `main` 去凑这个要求——指向一个不存在的构建产物
   * 比不写更糟（元数据在撒谎）。这里如实放开校验。
   */
  builtin?: boolean;
}

/**
 * 校验 manifest：结构（JSON Schema）+ 语义（入口、版本范围）。
 *
 * 语义错误是**累积**上报的，不会因为第一个失败就返回。
 */
export function validateManifest(
  raw: unknown,
  options: ValidateManifestOptions = {},
): LumiiPluginManifest {
  if (!validateStructure(raw)) {
    const issues = (validateStructure.errors ?? []).map(
      (e) => `${e.instancePath || "<root>"} ${e.message ?? "无效"}`,
    );
    throw new ManifestValidationError(issues);
  }

  const manifest = raw as unknown as LumiiPluginManifest;
  const issues: string[] = [];

  if (manifest.kind === "code" && !manifest.main && !manifest.client && !options.builtin) {
    issues.push("kind=code 至少要声明 main 或 client 之一");
  }

  if (options.appVersion && !isSatisfied(options.appVersion, manifest.engines.lumii)) {
    issues.push(`宿主版本 ${options.appVersion} 不满足 engines.lumii="${manifest.engines.lumii}"`);
  }

  if (issues.length > 0) throw new ManifestValidationError(issues);
  return manifest;
}

function isSatisfied(appVersion: string, range: string): boolean {
  try {
    return semverSatisfies(appVersion, range);
  } catch {
    // 范围写法非法 → 视为不满足，而不是放行
    return false;
  }
}
