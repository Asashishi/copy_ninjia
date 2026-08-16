import { existsSync } from "node:fs";
import { SUPER_ADMIN_USER_ID } from "../../packages/config/telegram";
import {
  BLOCKLIST_CONFIG_PATH,
  BLOCKLIST_FILE_PATH,
  BLOCKLIST_REMOVAL_OUTBOX_PATH,
  WHITELIST_CONFIG_PATH,
} from "../../packages/consts/paths";
import { decodePendingBlockedRemovalData } from "../../packages/database/codec/identity";
import { readJsonInput } from "../../packages/libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../packages/libs/record";
import type { PendingBlockedRemoval } from "../../packages/types/blocklist";
import type { WhitelistPermissions } from "../../packages/types/identityPolicy";
import type { MigrationInput } from "../../packages/types/identityStorageMigration";
import {
  loadLegacyBlocklistConfig,
  loadLegacyWhitelistConfig,
} from "./legacy";

/** 旧待踢 outbox 的唯一受支持版本；其它形态必须先由部署方处理。 */
const LEGACY_BLOCKLIST_REMOVAL_OUTBOX_VERSION: number = 2;

function decodeOldDynamicBlocklist(path: string): Set<number> {
  if (!existsSync(path)) return new Set();
  const value: unknown = readJsonInput(path);
  if (!isPlainRecord(value)) {
    throw new Error(`${path}: $ must be an object keyed by identity IDs.`);
  }
  const result: Set<number> = new Set();
  for (const [key, raw] of Object.entries(value)) {
    const id: number = Number(key);
    if (!Number.isSafeInteger(id) || id === 0 || String(id) !== key) {
      throw new Error(
        `${path}: $.<identity> must be a canonical non-zero safe integer key.`
      );
    }
    if (
      !isPlainRecord(raw) ||
      !hasExactKeys(raw, ["isBlocked", "blockedAt"]) ||
      raw.isBlocked !== true ||
      typeof raw.blockedAt !== "string" ||
      !/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(raw.blockedAt)
    ) {
      throw new Error(
        `${path}: $.<record> must be exactly the current blocked record shape.`
      );
    }
    result.add(id);
  }
  return result;
}

function decodeOldRemovalOutbox(
  path: string
): Map<number, PendingBlockedRemoval> {
  if (!existsSync(path)) return new Map();
  const value: unknown = readJsonInput(path);
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["version", "entries"]) ||
    value.version !== LEGACY_BLOCKLIST_REMOVAL_OUTBOX_VERSION ||
    !Array.isArray(value.entries)
  ) {
    throw new Error(`${path}: $ must use the current removal outbox schema.`);
  }
  const result: Map<number, PendingBlockedRemoval> = new Map();
  for (let index: number = 0; index < value.entries.length; index++) {
    const raw: unknown = value.entries[index];
    const text: string = JSON.stringify(raw);
    const pending: PendingBlockedRemoval = decodePendingBlockedRemovalData(
      text,
      `${path}:$.entries[${index}]`
    );
    const removalId: number = pending.params.removalId;
    if (result.has(removalId)) {
      throw new Error(`${path}: duplicate removalId ${removalId}.`);
    }
    result.set(removalId, pending);
  }
  return result;
}

/** 可注入旧结构路径的严格迁移输入参数；路径注入仅供隔离测试。 */
export interface LoadMigrationInputOptions {
  readonly whitelistPath?: string;
  readonly staticBlocklistPath?: string;
  readonly dynamicBlocklistPath?: string;
  readonly removalOutboxPath?: string;
  readonly superAdminUserId?: number;
}

/** 严格合并发布前四份旧身份 JSON，不静默修复或丢弃非法记录。 */
export function loadMigrationInput({
  whitelistPath = WHITELIST_CONFIG_PATH,
  staticBlocklistPath = BLOCKLIST_CONFIG_PATH,
  dynamicBlocklistPath = BLOCKLIST_FILE_PATH,
  removalOutboxPath = BLOCKLIST_REMOVAL_OUTBOX_PATH,
  superAdminUserId = SUPER_ADMIN_USER_ID,
}: LoadMigrationInputOptions = {}): MigrationInput {
  const whitelist: Map<number, Readonly<WhitelistPermissions>> = new Map(
    loadLegacyWhitelistConfig(whitelistPath)
  );
  whitelist.delete(superAdminUserId);
  const dynamic: Set<number> = decodeOldDynamicBlocklist(dynamicBlocklistPath);
  const blockedIds: Set<number> = new Set(
    loadLegacyBlocklistConfig(staticBlocklistPath).blockedIds
  );
  for (const id of dynamic.keys()) blockedIds.add(id);
  for (const id of blockedIds) {
    if (id === superAdminUserId || whitelist.has(id)) {
      throw new Error(
        `${staticBlocklistPath}: blocklist identities must be disjoint from protected identities.`
      );
    }
  }
  const removals: Map<number, PendingBlockedRemoval> =
    decodeOldRemovalOutbox(removalOutboxPath);
  for (const pending of removals.values()) {
    if (pending.params.probeMembership) {
      if (blockedIds.size === 0) {
        throw new Error(
          `${removalOutboxPath}: sweep requires a non-empty blocklist.`
        );
      }
      continue;
    }
    if (pending.params.userIds.some(
      (id: number): boolean => !blockedIds.has(id)
    )) {
      throw new Error(
        `${removalOutboxPath}: frozen userIds must exist in the merged blocklist.`
      );
    }
  }
  return { whitelist, blockedIds: [...blockedIds], removals };
}
