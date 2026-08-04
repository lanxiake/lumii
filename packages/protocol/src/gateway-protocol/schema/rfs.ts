/**
 * RFS (Remote File System) 协议 Schema
 *
 * 定义 6 个 RFS 命令的请求参数 Schema。
 * 路径为相对于客户端数据根（如 Windows 桌面默认 `~/.mtbot-client/`）的相对路径，设备端负责拼接根目录。
 */

import { Type } from "@sinclair/typebox";

import { NonEmptyString } from "./primitives.js";

// ============================================================================
// rfs.stat — 获取文件元信息
// ============================================================================

export const RfsStatParamsSchema = Type.Object(
  {
    /** 相对于客户端数据根的文件路径 */
    path: NonEmptyString,
    /** 目标节点 ID (不指定时自动路由到主设备) */
    nodeId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

// ============================================================================
// rfs.readdir — 列出目录内容
// ============================================================================

export const RfsReaddirParamsSchema = Type.Object(
  {
    path: NonEmptyString,
    nodeId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

// ============================================================================
// rfs.read_chunk — 按块读取文件
// ============================================================================

export const RfsReadChunkParamsSchema = Type.Object(
  {
    path: NonEmptyString,
    /** 读取起始偏移量 (字节) */
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    /** 读取字节数 (最大 1MB) */
    length: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_048_576 })),
    /** 编码: "utf8" (默认) 或 "base64" */
    encoding: Type.Optional(NonEmptyString),
    nodeId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

// ============================================================================
// rfs.write_chunk — 按块写入文件
// ============================================================================

export const RfsWriteChunkParamsSchema = Type.Object(
  {
    path: NonEmptyString,
    /** 写入内容 */
    data: Type.String(),
    /** 写入起始偏移量 (字节) */
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    /** 编码: "utf8" (默认) 或 "base64" */
    encoding: Type.Optional(NonEmptyString),
    /** 文件不存在时创建 (默认 true) */
    create: Type.Optional(Type.Boolean()),
    /** 写入前清空文件 (默认 false) */
    truncate: Type.Optional(Type.Boolean()),
    nodeId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

// ============================================================================
// rfs.delete — 删除文件/目录
// ============================================================================

export const RfsDeleteParamsSchema = Type.Object(
  {
    path: NonEmptyString,
    /** 递归删除目录内容 (默认 false) */
    recursive: Type.Optional(Type.Boolean()),
    nodeId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

// ============================================================================
// rfs.ensure_dir — 递归创建目录
// ============================================================================

export const RfsEnsureDirParamsSchema = Type.Object(
  {
    path: NonEmptyString,
    nodeId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
