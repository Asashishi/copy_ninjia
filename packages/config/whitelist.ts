import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  whitelistConfigCache,
  whitelistFileRevisionCache,
  whitelistMutationQueue,
} from "../cache/main/whitelist";
import type { WhitelistFileRevision } from "../cache/main/whitelist";
import {
  DEFAULT_WHITELIST_PERMISSIONS,
  WHITELIST_PERMISSION_KEYS,
} from "../consts/whitelist";
import { WHITELIST_CONFIG_PATH } from "../consts/paths";
import { atomicWriteText } from "../libs/atomicFile";
import { isPlainRecord } from "../libs/runtimeConfig";
import type {
  SetWhitelistMembershipParams,
  SetWhitelistMembershipResult,
  SetWhitelistPermissionParams,
  SetWhitelistPermissionResult,
  WhitelistConfig,
  WhitelistPermissionKey,
  WhitelistPermissions,
} from "../types/whitelist";

export interface WhitelistMutationOptions {
  path?: string;
  readBytes?: (path: string) => Promise<Uint8Array>;
  writeText?: (path: string, content: string) => Promise<void>;
}

/** 对白名单原始字节计算稳定指纹，不把部署配置内容写入日志或错误。 */
function whitelistContentSha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readWhitelistBytes(path: string): Promise<Uint8Array> {
  return await readFile(path);
}

/**
 * 若当前 cache 是从同一路径加载的，落盘前复核原始字节未被外部修改。
 * 返回 true 表示本次写入应继续维护该路径的指纹；测试手工注入的无来源 cache
 * 不伪造磁盘 revision。
 */
async function assertWhitelistFileUnchanged(
  path: string,
  readBytes: (path: string) => Promise<Uint8Array>
): Promise<boolean> {
  const revision: WhitelistFileRevision | null =
    whitelistFileRevisionCache.current;
  if (revision?.path !== resolve(path)) return false;

  let content: Uint8Array;
  try {
    content = await readBytes(path);
  } catch (error: unknown) {
    throw new Error(
      `Whitelist config ${path} became unavailable; refusing to overwrite the cached snapshot`,
      { cause: error }
    );
  }
  if (whitelistContentSha256(content) !== revision.sha256) {
    throw new Error(
      `Whitelist config ${path} changed outside this process; refusing to overwrite it`
    );
  }
  return true;
}

function publishWhitelistFileRevision(
  path: string,
  content: string | Uint8Array
): void {
  whitelistFileRevisionCache.current = {
    path: resolve(path),
    sha256: whitelistContentSha256(content),
  };
}

/** Telegram 白名单身份允许正用户 ID 或负频道 ID，禁止零、前导零与非安全整数。 */
function parseWhitelistId(rawId: string): number {
  if (!/^-?[1-9]\d*$/.test(rawId)) {
    throw new Error(`Invalid whitelist identity ID: "${rawId}"`);
  }
  const id: number = Number(rawId);
  if (!Number.isSafeInteger(id)) {
    throw new Error(`Invalid whitelist identity ID: "${rawId}" is outside the safe integer range`);
  }
  if (String(id) !== rawId) {
    throw new Error(`Invalid whitelist identity ID: "${rawId}" is not in canonical decimal form`);
  }
  return id;
}

/** 严格解码一条可只写部分键的权限覆盖，并补齐完整默认值。 */
function parsePermissions(id: number, value: unknown): Readonly<WhitelistPermissions> {
  if (!isPlainRecord(value)) {
    throw new Error(`Invalid whitelist permissions for ${id}: expected an object`);
  }
  for (const [key, permissionValue] of Object.entries(value)) {
    if (!WHITELIST_PERMISSION_KEYS.includes(key as WhitelistPermissionKey)) {
      throw new Error(`Invalid whitelist permission key for ${id}: ${key}`);
    }
    if (typeof permissionValue !== "boolean") {
      throw new Error(`Invalid whitelist permission ${key} for ${id}: expected boolean`);
    }
  }

  const permissions: WhitelistPermissions = {
    ...DEFAULT_WHITELIST_PERMISSIONS,
  };
  for (const key of WHITELIST_PERMISSION_KEYS) {
    const permissionValue: unknown = value[key];
    if (typeof permissionValue === "boolean") permissions[key] = permissionValue;
  }
  return Object.freeze(permissions);
}

/**
 * 严格解码 config/whitelist.json。顶层以十进制 ID 为键，值为权限覆盖对象；
 * 正 ID 表示用户，负 ID 表示频道身份。
 */
export function parseWhitelistConfig(value: unknown): WhitelistConfig {
  if (!isPlainRecord(value)) {
    throw new Error("Invalid whitelist config: expected an object keyed by identity ID");
  }
  const entries: Map<number, Readonly<WhitelistPermissions>> = new Map();
  for (const [rawId, rawPermissions] of Object.entries(value)) {
    const id: number = parseWhitelistId(rawId);
    entries.set(id, parsePermissions(id, rawPermissions));
  }
  return entries;
}

/** 从指定文件同步加载并严格校验；模块 import 本身不访问文件系统。 */
export function loadWhitelistConfig(path: string = WHITELIST_CONFIG_PATH): WhitelistConfig {
  return parseWhitelistConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/**
 * 取得本进程的白名单配置。生命周期会在联网前预热；这里保留惰性兜底，
 * 供独立单元调用与命令测试使用。
 */
export function getWhitelistConfig(
  path: string = WHITELIST_CONFIG_PATH
): WhitelistConfig {
  if (whitelistConfigCache.current === null) {
    const content: Uint8Array = readFileSync(path);
    whitelistConfigCache.current =
      parseWhitelistConfig(JSON.parse(Buffer.from(content).toString("utf8")) as unknown);
    publishWhitelistFileRevision(path, content);
  }
  return whitelistConfigCache.current;
}

/** 身份是否存在于白名单；成员身份本身仍承载 copy 冷却与验证代点等既有语义。 */
export function isWhitelisted(id: number): boolean {
  return getWhitelistConfig().has(id);
}

/** 白名单身份是否拥有某一项显式命令/广告权限；非白名单恒为 false。 */
export function hasWhitelistPermission(
  id: number,
  key: WhitelistPermissionKey
): boolean {
  return getWhitelistConfig().get(id)?.[key] === true;
}

/** 把完整有效权限序列化为稳定、便于人工编辑的 JSON。 */
export function serializeWhitelistConfig(config: WhitelistConfig): string {
  const serialized: Record<string, Readonly<WhitelistPermissions>> = {};
  const entries: [number, Readonly<WhitelistPermissions>][] = [...config.entries()];
  entries.sort((
    left: [number, Readonly<WhitelistPermissions>],
    right: [number, Readonly<WhitelistPermissions>]
  ): number => left[0] - right[0]);
  for (const [id, permissions] of entries) serialized[String(id)] = permissions;
  return `${JSON.stringify(serialized, null, 2)}\n`;
}

/**
 * 原子持久化一项白名单权限。只允许修改已经存在的条目；新增/删除成员由仅限
 * 超级管理员的 /white 负责，避免普通授权命令顺手扩大白名单边界。
 */
export function setWhitelistPermission({
  id,
  key,
  value,
}: SetWhitelistPermissionParams, {
  path = WHITELIST_CONFIG_PATH,
  readBytes = readWhitelistBytes,
  writeText = atomicWriteText,
}: WhitelistMutationOptions = {}): Promise<SetWhitelistPermissionResult> {
  let result: SetWhitelistPermissionResult | undefined;
  const mutation: Promise<void> = whitelistMutationQueue.current.then(async (): Promise<void> => {
    const current: WhitelistConfig = getWhitelistConfig();
    const trackFileRevision: boolean =
      await assertWhitelistFileUnchanged(path, readBytes);
    const existing: Readonly<WhitelistPermissions> | undefined = current.get(id);
    if (existing === undefined) {
      throw new Error(`Whitelist identity ${id} does not exist`);
    }
    if (existing[key] === value) {
      result = { changed: false, permissions: existing };
      return;
    }

    const permissions: Readonly<WhitelistPermissions> = Object.freeze({
      ...existing,
      [key]: value,
    });
    const next: Map<number, Readonly<WhitelistPermissions>> = new Map(current);
    next.set(id, permissions);
    const content: string = serializeWhitelistConfig(next);
    await writeText(path, content);
    whitelistConfigCache.current = next;
    if (trackFileRevision) publishWhitelistFileRevision(path, content);
    result = { changed: true, permissions };
  });
  whitelistMutationQueue.current = mutation.catch((): void => undefined);
  return mutation.then((): SetWhitelistPermissionResult => {
    if (result === undefined) {
      throw new Error("Whitelist permission mutation completed without a result");
    }
    return result;
  });
}

/**
 * 原子地把一个已有白名单身份的全部权限设为 true。已全开时不写盘；与其它白名单
 * 变更共用串行链，保证一键授权不会覆盖排在它前后的单项修改或成员关系变更。
 */
export function enableAllWhitelistPermissions(
  id: number,
  {
    path = WHITELIST_CONFIG_PATH,
    readBytes = readWhitelistBytes,
    writeText = atomicWriteText,
  }: WhitelistMutationOptions = {}
): Promise<SetWhitelistPermissionResult> {
  let result: SetWhitelistPermissionResult | undefined;
  const mutation: Promise<void> = whitelistMutationQueue.current.then(async (): Promise<void> => {
    const current: WhitelistConfig = getWhitelistConfig();
    const trackFileRevision: boolean =
      await assertWhitelistFileUnchanged(path, readBytes);
    const existing: Readonly<WhitelistPermissions> | undefined = current.get(id);
    if (existing === undefined) {
      throw new Error(`Whitelist identity ${id} does not exist`);
    }
    const isAllEnabled: boolean = WHITELIST_PERMISSION_KEYS.every(
      (key: WhitelistPermissionKey): boolean => existing[key]
    );
    if (isAllEnabled) {
      result = { changed: false, permissions: existing };
      return;
    }

    const nextPermissions: WhitelistPermissions = { ...existing };
    for (const key of WHITELIST_PERMISSION_KEYS) nextPermissions[key] = true;
    const permissions: Readonly<WhitelistPermissions> =
      Object.freeze(nextPermissions);
    const next: Map<number, Readonly<WhitelistPermissions>> = new Map(current);
    next.set(id, permissions);
    const content: string = serializeWhitelistConfig(next);
    await writeText(path, content);
    whitelistConfigCache.current = next;
    if (trackFileRevision) publishWhitelistFileRevision(path, content);
    result = { changed: true, permissions };
  });
  whitelistMutationQueue.current = mutation.catch((): void => undefined);
  return mutation.then((): SetWhitelistPermissionResult => {
    if (result === undefined) {
      throw new Error("Whitelist all-permission mutation completed without a result");
    }
    return result;
  });
}

/**
 * 原子新增或删除白名单身份。首次新增使用完整默认权限；重复新增保留已有权限，
 * 删除不存在的身份同样是无写入的幂等成功。与 /permission 共用全局串行链，
 * 避免成员关系和逐项权限的并发写入互相覆盖。
 */
export function setWhitelistMembership({
  id,
  enabled,
}: SetWhitelistMembershipParams, {
  path = WHITELIST_CONFIG_PATH,
  readBytes = readWhitelistBytes,
  writeText = atomicWriteText,
}: WhitelistMutationOptions = {}): Promise<SetWhitelistMembershipResult> {
  let result: SetWhitelistMembershipResult | undefined;
  const mutation: Promise<void> = whitelistMutationQueue.current.then(async (): Promise<void> => {
    const current: WhitelistConfig = getWhitelistConfig();
    const trackFileRevision: boolean =
      await assertWhitelistFileUnchanged(path, readBytes);
    const existing: Readonly<WhitelistPermissions> | undefined = current.get(id);
    if (enabled && existing !== undefined) {
      result = { changed: false, permissions: existing };
      return;
    }
    if (!enabled && existing === undefined) {
      result = { changed: false, permissions: undefined };
      return;
    }

    const next: Map<number, Readonly<WhitelistPermissions>> = new Map(current);
    let permissions: Readonly<WhitelistPermissions> | undefined;
    if (enabled) {
      permissions = Object.freeze({ ...DEFAULT_WHITELIST_PERMISSIONS });
      next.set(id, permissions);
    } else {
      next.delete(id);
    }
    const content: string = serializeWhitelistConfig(next);
    await writeText(path, content);
    whitelistConfigCache.current = next;
    if (trackFileRevision) publishWhitelistFileRevision(path, content);
    result = { changed: true, permissions };
  });
  whitelistMutationQueue.current = mutation.catch((): void => undefined);
  return mutation.then((): SetWhitelistMembershipResult => {
    if (result === undefined) {
      throw new Error("Whitelist membership mutation completed without a result");
    }
    return result;
  });
}
