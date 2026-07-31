import { readFileSync } from "node:fs";
import { BLOCKLIST_CONFIG_PATH } from "../consts/paths";
import { hasExactKeys, isPlainRecord } from "../libs/runtimeConfig";
import type { BlocklistConfig } from "../types/blocklist";

export interface BlocklistProtectedIdentityCheckOptions {
  blockedIds: Iterable<number>;
  whitelistIds: Iterable<number>;
  superAdminId: number;
  source: string;
}

/**
 * 严格解码静态黑名单。正安全整数表示用户，负安全整数表示频道身份；零、重复、
 * 小数和超出安全整数范围的值一律拒绝，避免启动后出现无法稳定比较的身份。
 */
export function parseBlocklistConfig(value: unknown): BlocklistConfig {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["blockedIds"]) ||
    !Array.isArray(value.blockedIds)
  ) {
    throw new Error("Invalid blocklist config: expected exactly { blockedIds: number[] }");
  }

  const blockedIds: number[] = [];
  const seen: Set<number> = new Set();
  for (const id of value.blockedIds) {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id === 0) {
      throw new Error(`Invalid blocklist config ID: ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate blocklist config ID: ${id}`);
    }
    seen.add(id);
    blockedIds.push(id);
  }
  return Object.freeze({ blockedIds: Object.freeze(blockedIds) });
}

/** 从指定文件同步加载静态黑名单；模块 import 本身不访问文件系统。 */
export function loadBlocklistConfig(
  path: string = BLOCKLIST_CONFIG_PATH
): BlocklistConfig {
  return parseBlocklistConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/**
 * 黑名单不得包含超级管理员或白名单身份。两套安全边界相互矛盾时拒绝启动，
 * 避免同一身份一边能执行管理命令、一边又被自动处置。
 */
export function assertBlocklistProtectedIdentitiesDisjoint({
  blockedIds,
  whitelistIds,
  superAdminId,
  source,
}: BlocklistProtectedIdentityCheckOptions): void {
  const protectedIds: Set<number> = new Set(whitelistIds);
  protectedIds.add(superAdminId);
  for (const id of blockedIds) {
    if (protectedIds.has(id)) {
      throw new Error(
        `Invalid ${source}: protected identity ${id} must not be blocklisted`
      );
    }
  }
}
