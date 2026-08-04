/**
 * @mtbot/protocol — stable facade for the MtBot gateway protocol.
 *
 * The source of truth lives in `src/gateway/protocol` (TypeBox schemas + AJV
 * validators). This package re-exports that public surface so that apps and
 * other packages import from a stable `@mtbot/protocol` boundary instead of
 * deep relative paths like `../../../../src/gateway/protocol`.
 *
 * NOTE (transitional): this facade currently re-exports the in-tree source.
 * Phase 2 may physically relocate the schema source of truth into this package
 * and invert the dependency. Until then, treat this as the import boundary —
 * do not add deep `src/gateway/protocol` imports in apps.
 */
export * from "./gateway-protocol/index.js";
export * from "./agent/kernel.js";
