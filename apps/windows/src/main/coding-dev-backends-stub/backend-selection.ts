import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  DEFAULT_CODING_DEV_BACKEND_ID,
  type CodingDevBackendId,
  isCodingDevBackendId,
} from "./contracts.js";

type BackendSelectionRecord = {
  backendId: CodingDevBackendId;
  updatedAt: string;
};

type BackendSelectionFile = {
  version: number;
  selections: Record<string, BackendSelectionRecord>;
};

export type BackendSelectionState = BackendSelectionRecord & {
  accountId: string;
  peerId: string;
};

const BACKEND_SELECTION_FILE_VERSION = 1;

/**
 * Windows/Web 控制台通过 `coding_dev.applySlash` 写入的用户级默认后端；
 * 微信单聊仍用 `accountId:peerId` 记录，且优先于本项。
 */
export const CODING_DEV_USER_GLOBAL_ACCOUNT = "__user_global__";

/**
 * 允许外部注入持久化基目录（Windows 客户端设为 ~/.lumii/config）。
 * 未注入时回退到 %TEMP%/mtbot（gateway 等场景）。
 */
let _customBaseDir: string | undefined;

export function setBackendSelectionBaseDir(dir: string): void {
  _customBaseDir = dir;
}

function resolveBackendSelectionDir(): string {
  const base = _customBaseDir ?? path.join(os.tmpdir(), "mtbot");
  return path.join(base, "coding-dev-backends");
}

function resolveBackendSelectionPath(): string {
  return path.join(resolveBackendSelectionDir(), "backend-selection.json");
}

function makeSelectionKey(accountId: string, peerId: string): string {
  return `${accountId}:${peerId}`;
}

function readBackendSelectionFile(): BackendSelectionFile {
  const filePath = resolveBackendSelectionPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { version: BACKEND_SELECTION_FILE_VERSION, selections: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<BackendSelectionFile>;
    const selections = parsed.selections ?? {};
    const normalized: Record<string, BackendSelectionRecord> = {};
    for (const [key, value] of Object.entries(selections)) {
      if (!value || typeof value !== "object") continue;
      const backendId = (value as { backendId?: string }).backendId;
      if (!backendId || !isCodingDevBackendId(backendId)) continue;
      normalized[key] = {
        backendId,
        updatedAt:
          typeof (value as { updatedAt?: string }).updatedAt === "string"
            ? (value as { updatedAt: string }).updatedAt
            : new Date(0).toISOString(),
      };
    }
    return { version: BACKEND_SELECTION_FILE_VERSION, selections: normalized };
  } catch {
    return { version: BACKEND_SELECTION_FILE_VERSION, selections: {} };
  }
}

function writeBackendSelectionFile(data: BackendSelectionFile): void {
  const dir = resolveBackendSelectionDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolveBackendSelectionPath(), JSON.stringify(data, null, 2), "utf-8");
}

export function getBackendSelection(
  accountId: string,
  peerId: string,
): BackendSelectionState | undefined {
  const file = readBackendSelectionFile();
  const record = file.selections[makeSelectionKey(accountId, peerId)];
  if (!record) return undefined;
  return { accountId, peerId, ...record };
}

export function getSelectedBackendId(accountId: string, peerId: string): CodingDevBackendId {
  return getBackendSelection(accountId, peerId)?.backendId ?? DEFAULT_CODING_DEV_BACKEND_ID;
}

export function setBackendSelection(
  accountId: string,
  peerId: string,
  backendId: CodingDevBackendId,
): BackendSelectionState {
  const file = readBackendSelectionFile();
  const next: BackendSelectionRecord = {
    backendId,
    updatedAt: new Date().toISOString(),
  };
  file.selections[makeSelectionKey(accountId, peerId)] = next;
  writeBackendSelectionFile(file);
  return { accountId, peerId, ...next };
}

export function clearBackendSelection(accountId: string, peerId: string): boolean {
  const file = readBackendSelectionFile();
  const key = makeSelectionKey(accountId, peerId);
  if (!file.selections[key]) return false;
  delete file.selections[key];
  writeBackendSelectionFile(file);
  return true;
}
