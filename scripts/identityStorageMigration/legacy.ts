/** 仅供一次性迁移读取即将删除的旧 JSON 结构；运行时模块不得依赖本文件。 */

import {
  BLOCKLIST_CONFIG_PATH,
  WHITELIST_CONFIG_PATH,
} from "../../packages/consts/paths";
import {
  DEFAULT_WHITELIST_PERMISSIONS,
  WHITELIST_PERMISSION_KEYS,
} from "../../packages/consts/whitelist";
import { invalidInput, readJsonInput } from "../../packages/libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../packages/libs/record";
import type {
  WhitelistPermissionKey,
  WhitelistPermissions,
} from "../../packages/types/identityPolicy";
import type {
  LegacyBlocklistConfig,
  LegacyWhitelistConfig,
} from "../../packages/types/identityStorageMigration";

function parseLegacyWhitelistId(rawId: string, sourcePath: string): number {
  if (!/^-?[1-9]\d*$/.test(rawId)) {
    return invalidInput(sourcePath, "$.<identity>", "a canonical non-zero safe integer key");
  }
  const id: number = Number(rawId);
  if (!Number.isSafeInteger(id) || String(id) !== rawId) {
    return invalidInput(sourcePath, "$.<identity>", "a canonical non-zero safe integer key");
  }
  return id;
}

function parseLegacyPermissions(
  value: unknown,
  sourcePath: string
): Readonly<WhitelistPermissions> {
  if (!isPlainRecord(value)) {
    return invalidInput(sourcePath, "$.<identity>", "an object of boolean permission overrides");
  }
  for (const [key, permissionValue] of Object.entries(value)) {
    if (!WHITELIST_PERMISSION_KEYS.includes(key as WhitelistPermissionKey)) {
      return invalidInput(sourcePath, "$.<identity>.<permission>", "a supported permission key");
    }
    if (typeof permissionValue !== "boolean") {
      return invalidInput(sourcePath, `$.<identity>.${key}`, "a boolean");
    }
  }
  const permissions: WhitelistPermissions = { ...DEFAULT_WHITELIST_PERMISSIONS };
  for (const key of WHITELIST_PERMISSION_KEYS) {
    const permissionValue: unknown = value[key];
    if (typeof permissionValue === "boolean") permissions[key] = permissionValue;
  }
  // 这份一次性脚本也可能在 v3 发布后才被用于旧 JSON -> SQLite 直迁。旧文件没有
  // isCanWhiteOther 时，沿用 v2 -> v3 的同一迁移口径：旧权限全开者补 true，
  // 其余补 false；显式写了新字段则严格尊重部署方给出的值。
  if (value.isCanWhiteOther === undefined) {
    permissions.isCanWhiteOther = WHITELIST_PERMISSION_KEYS.every(
      (key: WhitelistPermissionKey): boolean =>
        key === "isCanWhiteOther" || permissions[key] === true
    );
  }
  return permissions;
}

/** 严格读取旧 config/whitelist.json；字段缺失或非法时迁移必须停止。 */
export function loadLegacyWhitelistConfig(
  path: string = WHITELIST_CONFIG_PATH
): LegacyWhitelistConfig {
  const value: unknown = readJsonInput(path);
  if (!isPlainRecord(value)) {
    return invalidInput(path, "$", "an object keyed by canonical identity IDs");
  }
  const entries: Map<number, Readonly<WhitelistPermissions>> = new Map();
  for (const [rawId, rawPermissions] of Object.entries(value)) {
    entries.set(
      parseLegacyWhitelistId(rawId, path),
      parseLegacyPermissions(rawPermissions, path)
    );
  }
  return entries;
}

/** 严格读取旧 config/blocklist.json；重复或非法 ID 不得静默丢弃。 */
export function loadLegacyBlocklistConfig(
  path: string = BLOCKLIST_CONFIG_PATH
): LegacyBlocklistConfig {
  const value: unknown = readJsonInput(path);
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["blockedIds"]) ||
    !Array.isArray(value.blockedIds)
  ) {
    return invalidInput(path, "$", "exactly { blockedIds: nonZeroSafeInteger[] }");
  }
  const blockedIds: number[] = [];
  const seen: Set<number> = new Set();
  for (let index: number = 0; index < value.blockedIds.length; index++) {
    const id: unknown = value.blockedIds[index];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id === 0) {
      return invalidInput(path, `$.blockedIds[${index}]`, "a non-zero safe integer");
    }
    if (seen.has(id)) {
      return invalidInput(path, `$.blockedIds[${index}]`, "unique");
    }
    seen.add(id);
    blockedIds.push(id);
  }
  return { blockedIds };
}
