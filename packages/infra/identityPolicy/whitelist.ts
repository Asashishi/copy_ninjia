import {
  DEFAULT_WHITELIST_PERMISSIONS,
  NON_WHITELIST_PERMISSIONS,
  SUPER_ADMIN_WHITELIST_PERMISSIONS,
  WHITELIST_PERMISSION_KEYS,
} from "../../consts/whitelist";
import { SUPER_ADMIN_USER_ID } from "../../config/telegram";
import {
  cachedWhitelistEntry,
  confirmIdentityPolicyPersisted,
  queueIdentityPolicyWrite,
} from "../identityStorage";
import type {
  TelegramIdentityMetadata,
  WhitelistEntryData,
  WhitelistPermissionKey,
  WhitelistPermissions,
} from "../../types/identityPolicy";

/** /permission 持久化一项授权时的入参。 */
export interface SetWhitelistPermissionParams {
  id: number;
  key: WhitelistPermissionKey;
  value: boolean;
}

/** /permission 持久化的结果；changed=false 表示最终值原本就是该值。 */
export interface SetWhitelistPermissionResult {
  changed: boolean;
  permissions: Readonly<WhitelistPermissions>;
}

/** /white 新增或删除白名单身份时的入参。 */
export interface SetWhitelistMembershipParams {
  id: number;
  enabled: boolean;
  /** 新增成员时必须提供；删除时忽略。 */
  meta?: Readonly<TelegramIdentityMetadata>;
}

/**
 * /white 持久化白名单成员关系的结果。删除后 permissions 为 undefined；
 * 重复 enable 返回原有权限，绝不把已经单独授权的字段重置成默认值。
 */
export interface SetWhitelistMembershipResult {
  changed: boolean;
  permissions: Readonly<WhitelistPermissions> | undefined;
}

/**
 * 取得某身份当前完整权限；普通身份只读主线程白名单 LRU，超级管理员由身份直授。
 */
export function getEffectiveWhitelistPermissions(
  id: number
): Readonly<WhitelistPermissions> | undefined {
  if (id === SUPER_ADMIN_USER_ID) return SUPER_ADMIN_WHITELIST_PERMISSIONS;
  return cachedWhitelistEntry(id)?.permissions;
}

/**
 * 取得 `/permission query` 的完整只读视图。
 *
 * 本函数只读主线程缓存；非白名单或冷缺失身份直接返回逐项 false 的共享常量，
 * 不为查询创建或写入 SQLite 记录。update 前置预热仍负责需要确证的目标身份。
 */
export function getWhitelistPermissionQueryView(
  id: number
): Readonly<WhitelistPermissions> {
  return getEffectiveWhitelistPermissions(id) ?? NON_WHITELIST_PERMISSIONS;
}

/** 身份是否处于白名单边界；冷缺失按不存在处理，update 前置中间件负责批量预热。 */
export function isWhitelisted(id: number): boolean {
  return id === SUPER_ADMIN_USER_ID || cachedWhitelistEntry(id) !== undefined;
}

/** 身份是否拥有指定权限；白名单外身份恒为 false。 */
export function hasWhitelistPermission(
  id: number,
  key: WhitelistPermissionKey
): boolean {
  return getEffectiveWhitelistPermissions(id)?.[key] === true;
}

/**
 * 等目标白名单最终值落盘；幂等命中时补投仍未 ACK 的上一版最终值。
 * 命令据此才能把“缓存里已经如此”与“SQLite 已经如此”分开。
 */
export function confirmWhitelistEntryPersisted(
  id: number,
  retryUnacknowledged: boolean
): Promise<void> {
  return confirmIdentityPolicyPersisted("whitelist", id, retryUnacknowledged);
}

/**
 * 发布一条白名单最终值，并确认它真的交到了 Disk I/O Worker 手上。
 *
 * `queueIdentityPolicyWrite` 的返回值是 postDiskIO 拒收的**唯一**信号（见
 * infra/identityStorage.ts）：Worker 已经放弃自愈、恢复缓冲顶到硬顶、或同步拒收
 * 时它返回 false，而这条最终值此刻只活在主线程 LRU 里，重启就没了。丢掉这个布尔
 * 的后果是 `/white`、`/permission` 一律回执成功——真正的事务失败在 Worker 侧按
 * 设计只有 console.error，而部署单元的 Std{Output,Error} 都是 null，运维要到下次
 * 重启才发现那位管理员根本没有白名单条目。抛出去，交给两条命令既有的
 * mutationFailed 分支如实回执（commands/permission.ts、commands/white.ts）。
 */
function publishWhitelistEntry(
  id: number,
  value: Readonly<WhitelistEntryData> | null
): void {
  if (queueIdentityPolicyWrite("whitelist", id, value)) return;
  throw new Error(
    `Whitelist identity ${id} was published to the read cache but the persistence Worker rejected it.`
  );
}

/**
 * 已有白名单身份的权限修改骨架：查条目、判幂等、克隆、投递走同一条路径。
 * mutate 返回 null 表示「本来就是这样」，此时不产生任何数据库写入。
 */
function updateWhitelistPermissions(
  id: number,
  mutate: (current: Readonly<WhitelistPermissions>) => Readonly<WhitelistPermissions> | null
): SetWhitelistPermissionResult {
  const existing: Readonly<WhitelistEntryData> | undefined = cachedWhitelistEntry(id);
  if (existing === undefined) {
    throw new Error(`Whitelist identity ${id} does not exist`);
  }
  const permissions: Readonly<WhitelistPermissions> | null = mutate(existing.permissions);
  if (permissions === null) {
    return { changed: false, permissions: existing.permissions };
  }
  // meta 由两条路共用同一份既有值：任何一条忘了带，重新落盘时那条身份的
  // Telegram 名称/用户名就会被清空。
  publishWhitelistEntry(id, { permissions, meta: existing.meta });
  return { changed: true, permissions };
}

/** 修改一项已有白名单权限；最终值先发布 LRU，再由 DiskIO Worker 批量提交。 */
export function setWhitelistPermission({
  id,
  key,
  value,
}: SetWhitelistPermissionParams): SetWhitelistPermissionResult {
  return updateWhitelistPermissions(
    id,
    (current: Readonly<WhitelistPermissions>): Readonly<WhitelistPermissions> | null =>
      current[key] === value ? null : { ...current, [key]: value }
  );
}

/** 把已有白名单身份的全部权限设为 true；幂等命中不产生数据库写入。 */
export function enableAllWhitelistPermissions(
  id: number
): SetWhitelistPermissionResult {
  return updateWhitelistPermissions(
    id,
    (current: Readonly<WhitelistPermissions>): Readonly<WhitelistPermissions> | null => {
      if (WHITELIST_PERMISSION_KEYS.every(
        (key: WhitelistPermissionKey): boolean => current[key]
      )) {
        return null;
      }
      const permissions: WhitelistPermissions = { ...current };
      for (const key of WHITELIST_PERMISSION_KEYS) permissions[key] = true;
      return permissions;
    }
  );
}

/** 新增或删除白名单身份；新增必须携带 Telegram meta，已有权限不会被重置。 */
export function setWhitelistMembership({
  id,
  enabled,
  meta,
}: SetWhitelistMembershipParams): SetWhitelistMembershipResult {
  const existing: Readonly<WhitelistEntryData> | undefined = cachedWhitelistEntry(id);
  if (enabled && existing !== undefined) {
    return { changed: false, permissions: existing.permissions };
  }
  if (!enabled && existing === undefined) {
    return { changed: false, permissions: undefined };
  }
  if (!enabled) {
    publishWhitelistEntry(id, null);
    return { changed: true, permissions: undefined };
  }
  if (meta === undefined) {
    throw new Error(`Whitelist identity ${id} metadata is required when enabling membership`);
  }
  const permissions: Readonly<WhitelistPermissions> = {
    ...DEFAULT_WHITELIST_PERMISSIONS,
  };
  const storedMeta: Readonly<TelegramIdentityMetadata> = {
    firstName: meta.firstName,
    lastName: meta.lastName,
    username: meta.username,
  };
  publishWhitelistEntry(id, { permissions, meta: storedMeta });
  return { changed: true, permissions };
}
