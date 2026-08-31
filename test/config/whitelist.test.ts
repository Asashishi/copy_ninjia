import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  DEFAULT_WHITELIST_PERMISSIONS,
  NON_WHITELIST_PERMISSIONS,
  TEMPORARY_WHITELIST_PERMISSIONS,
  WHITELIST_PERMISSION_KEYS,
} from "../../packages/consts/whitelist";
import { DAY_MS } from "../../packages/consts/diskIO/common";
import { SUPER_ADMIN_USER_ID } from "../../packages/config/telegram";
import type {
  DiskBusinessMessage,
  IdentityStoragePersistedReply,
} from "../../packages/types/diskIO";

const diskMessages: DiskBusinessMessage[] = [];
const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
/** Worker 放弃自愈、恢复缓冲顶到硬顶或同步拒收时，postDiskIO 返回 false。 */
let acceptDiskMessages: boolean = true;
const flushDiskIODomainOutcome = mock(
  async (domain: "whitelist" | "blocklist") => {
    const writes: { table: "whitelist" | "blocklist"; id: number; revision: number }[] = [];
    for (const message of diskMessages) {
      if (message.type !== "identityPolicyWrite" || message.table !== domain) continue;
      writes.push({ table: message.table, id: message.id, revision: message.revision });
    }
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes,
        temporaryWhitelistWrites: [],
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    return { result: "flushed" as const };
  }
);

mock.module("../../packages/infra/diskIO", () => ({
  isDiskIOInitialized: (): boolean => false,
  onDiskIORespawn: (): void => {},
  onIdentityStoragePersisted: (
    listener: (reply: IdentityStoragePersistedReply) => void
  ): void => {
    persistedListeners.push(listener);
  },
  relayLogMessage: (): boolean => true,
  postDiskIO: (message: DiskBusinessMessage): boolean => {
    diskMessages.push(message);
    return acceptDiskMessages;
  },
  flushDiskIODomainOutcome,
}));

const {
  blocklistEntryCache,
  resetIdentityStorageCache,
  unacknowledgedWhitelistWrites,
  whitelistEntryCache,
} = await import("../../packages/cache/main/identityStorage");
const { temporaryWhitelistActivityCache } = await import(
  "../../packages/cache/main/temporaryWhitelist"
);
const {
  enableAllWhitelistPermissions,
  confirmWhitelistEntryPersisted,
  getEffectiveWhitelistPermissions,
  getWhitelistPermissionQueryView,
  hasWhitelistPermission,
  isWhitelisted,
  promoteAdBypassWhitelistMembership,
  setWhitelistMembership,
  setWhitelistPermission,
} = await import("../../packages/infra/identityPolicy/whitelist");
const { canBypassAdDetection } = await import(
  "../../packages/antiRaid/memberFacts"
);

function seedMissing(id: number): void {
  whitelistEntryCache.set(id, null);
  blocklistEntryCache.set(id, null);
  temporaryWhitelistActivityCache.set(id, null);
}

beforeEach(() => {
  diskMessages.length = 0;
  acceptDiskMessages = true;
  resetIdentityStorageCache();
  flushDiskIODomainOutcome.mockClear();
});

describe("SQLite 白名单运行时视图", () => {
  test("超级管理员由身份直接持有全部权限，不需要数据库条目", () => {
    expect(isWhitelisted(SUPER_ADMIN_USER_ID)).toBeTrue();
    expect(getEffectiveWhitelistPermissions(SUPER_ADMIN_USER_ID)).toEqual(
      expect.objectContaining({ isCanBlock: true, isCanUnBlock: true })
    );
  });

  test("冷缺失与负缓存都按白名单外处理", () => {
    expect(isWhitelisted(7)).toBeFalse();
    expect(getWhitelistPermissionQueryView(7)).toBe(NON_WHITELIST_PERMISSIONS);
    expect(Object.values(getWhitelistPermissionQueryView(7)).every(
      (value: boolean): boolean => value === false
    )).toBeTrue();
    whitelistEntryCache.set(7, null);
    expect(isWhitelisted(7)).toBeFalse();
    expect(getWhitelistPermissionQueryView(7)).toBe(NON_WHITELIST_PERMISSIONS);
    expect(hasWhitelistPermission(7, "isCanMute")).toBeFalse();
    expect(diskMessages).toEqual([]);
  });

  test("上一东京日达标的临时白名单只取得广告检测豁免", () => {
    const now: number = Date.now();
    seedMissing(7);
    temporaryWhitelistActivityCache.set(7, {
      tempWhite: true,
      tempWhiteAt: now - DAY_MS,
      tempWhiteCount: 7,
      sendCount: 8,
      countedAt: now - DAY_MS,
      qualifiedAt: now - DAY_MS,
    });

    expect(isWhitelisted(7)).toBeFalse();
    expect(canBypassAdDetection(SUPER_ADMIN_USER_ID, now)).toBeTrue();
    expect(canBypassAdDetection(7, now)).toBeTrue();
    expect(getEffectiveWhitelistPermissions(7)).toBe(TEMPORARY_WHITELIST_PERMISSIONS);
    expect(getWhitelistPermissionQueryView(7)).toBe(TEMPORARY_WHITELIST_PERMISSIONS);
    expect(hasWhitelistPermission(7, "isCanViewBotStatus")).toBeFalse();
    expect(hasWhitelistPermission(7, "isCanBypassAdDetection")).toBeTrue();
    expect(hasWhitelistPermission(7, "isCanBypassFloodControl")).toBeFalse();
    expect(hasWhitelistPermission(7, "isCanMute")).toBeFalse();
    for (const key of WHITELIST_PERMISSION_KEYS) {
      expect(hasWhitelistPermission(7, key))
        .toBe(key === "isCanBypassAdDetection");
    }

    temporaryWhitelistActivityCache.set(7, {
      tempWhite: true,
      tempWhiteAt: now - 2 * DAY_MS,
      tempWhiteCount: 1,
      sendCount: 8,
      countedAt: now - 2 * DAY_MS,
      qualifiedAt: now - 2 * DAY_MS,
    });
    expect(canBypassAdDetection(7, now)).toBeFalse();
    expect(getEffectiveWhitelistPermissions(7)).toBeUndefined();

    temporaryWhitelistActivityCache.set(7, null);
    expect(isWhitelisted(7)).toBeFalse();
    expect(canBypassAdDetection(7, now)).toBeFalse();
    expect(getEffectiveWhitelistPermissions(7)).toBeUndefined();
  });

  test("广告专用读口只服从超级管理员与永久、临时身份的单项有效权限", () => {
    seedMissing(9);
    whitelistEntryCache.set(9, {
      permissions: { ...DEFAULT_WHITELIST_PERMISSIONS, isCanBypassAdDetection: false },
      meta: { firstName: "Permanent", lastName: "", username: "" },
    });
    expect(isWhitelisted(9)).toBeTrue();
    expect(canBypassAdDetection(9)).toBeFalse();

    seedMissing(10);
    whitelistEntryCache.set(10, {
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "Bypass", lastName: "", username: "" },
    });
    expect(canBypassAdDetection(10)).toBeTrue();

    const now: number = Date.now();
    seedMissing(11);
    temporaryWhitelistActivityCache.set(11, {
      tempWhite: true,
      tempWhiteAt: now,
      tempWhiteCount: 1,
      sendCount: 8,
      countedAt: now,
      qualifiedAt: now,
    });
    expect(canBypassAdDetection(11, now)).toBeTrue();
    expect(canBypassAdDetection(11, now + 2 * DAY_MS)).toBeFalse();

    seedMissing(12);
    temporaryWhitelistActivityCache.set(12, {
      tempWhite: false,
      tempWhiteAt: null,
      tempWhiteCount: 0,
      sendCount: 1,
      countedAt: now,
      qualifiedAt: null,
    });
    expect(canBypassAdDetection(12, now)).toBeFalse();

    seedMissing(13);
    expect(canBypassAdDetection(13, now)).toBeFalse();
    expect(canBypassAdDetection(14, now)).toBeFalse();
  });

  test("新增成员写入完整默认权限和 Telegram meta", async () => {
    seedMissing(7);
    const result = await setWhitelistMembership({
      id: 7,
      enabled: true,
      meta: { firstName: "天才", lastName: "猫", username: "genius" },
    });

    expect(result).toEqual({ changed: true, permissions: DEFAULT_WHITELIST_PERMISSIONS });
    expect(result.permissions?.isCanWhiteOther).toBeFalse();
    expect(whitelistEntryCache.peek(7)).toEqual({
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "天才", lastName: "猫", username: "genius" },
    });
    expect(diskMessages.at(-1)).toEqual(expect.objectContaining({
      type: "identityPolicyWrite",
      table: "whitelist",
      id: 7,
      revision: 1,
    }));
    expect(unacknowledgedWhitelistWrites.get(7)?.revision).toBe(1);
  });

  test("连续七日晋升只写入广告检测豁免权限", () => {
    seedMissing(8);

    expect(promoteAdBypassWhitelistMembership(8, {
      firstName: "Alice",
      lastName: "",
      username: "alice",
    })).toEqual({ changed: true, queued: true });
    expect(whitelistEntryCache.peek(8)).toEqual({
      permissions: TEMPORARY_WHITELIST_PERMISSIONS,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    });
    for (const key of WHITELIST_PERMISSION_KEYS) {
      expect(hasWhitelistPermission(8, key))
        .toBe(key === "isCanBypassAdDetection");
    }
  });

  test("新增缺 meta 或目标仍在黑名单时拒绝，不发布半份内存状态", () => {
    seedMissing(7);
    expect(() => setWhitelistMembership({ id: 7, enabled: true })).toThrow("metadata");
    blocklistEntryCache.set(7, {
      blockedAt: "2026/08/11 00:00:00",
      meta: { firstName: "Blocked", lastName: "", username: "" },
    });
    expect(() => setWhitelistMembership({
      id: 7,
      enabled: true,
      meta: { firstName: "Blocked", lastName: "", username: "" },
    })).toThrow("both whitelist and blocklist");
    expect(whitelistEntryCache.peek(7)).toBeNull();
  });

  test("单项与全开修改保留 meta，并用新 revision 覆盖未 ACK 最终值", async () => {
    seedMissing(7);
    await setWhitelistMembership({
      id: 7,
      enabled: true,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    });
    const changed = await setWhitelistPermission({ id: 7, key: "isCanMute", value: true });
    expect(changed.changed).toBeTrue();
    expect(whitelistEntryCache.peek(7)?.meta.username).toBe("alice");
    const all = await enableAllWhitelistPermissions(7);
    expect(all.changed).toBeTrue();
    expect(Object.values(all.permissions).every((value: boolean): boolean => value)).toBeTrue();
    expect(all.permissions.isCanWhiteOther).toBeTrue();
    expect(unacknowledgedWhitelistWrites.get(7)?.revision).toBe(3);
  });

  test("重复值幂等，删除发布负缓存并排队 tombstone", async () => {
    seedMissing(7);
    await setWhitelistMembership({
      id: 7,
      enabled: true,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    });
    expect((await setWhitelistPermission({
      id: 7,
      key: "isCanMute",
      value: DEFAULT_WHITELIST_PERMISSIONS.isCanMute,
    })).changed).toBeFalse();
    const removed = await setWhitelistMembership({ id: 7, enabled: false });
    expect(removed).toEqual({ changed: true, permissions: undefined });
    expect(whitelistEntryCache.peek(7)).toBeNull();
    expect(unacknowledgedWhitelistWrites.get(7)?.data).toBeNull();
    expect((await setWhitelistMembership({ id: 7, enabled: false })).changed).toBeFalse();
  });
});

describe("落盘投递被拒收时不得回执成功", () => {
  test("三条写入路径都抛错，交给命令的 mutationFailed 分支如实回执", async () => {
    seedMissing(7);
    acceptDiskMessages = false;
    // 丢掉 queueIdentityPolicyWrite 的返回值等于把「Worker 没收下」读成成功：
    // 真正的事务失败在 Worker 侧只有 console.error，而部署单元的
    // Std{Output,Error} 都是 null，运维要到下次重启才发现条目根本不存在。
    expect(() => setWhitelistMembership({
      id: 7,
      enabled: true,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    })).toThrow("persistence Worker rejected it");

    acceptDiskMessages = true;
    setWhitelistMembership({
      id: 7,
      enabled: true,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    });
    acceptDiskMessages = false;
    expect(() => setWhitelistPermission({
      id: 7,
      key: "isCanMute",
      value: !DEFAULT_WHITELIST_PERMISSIONS.isCanMute,
    })).toThrow("persistence Worker rejected it");
    expect(() => enableAllWhitelistPermissions(7)).toThrow("persistence Worker rejected it");
    expect(() => setWhitelistMembership({ id: 7, enabled: false }))
      .toThrow("persistence Worker rejected it");
  });

  test("幂等命中不产生任何投递，因此也不会被拒收路径误伤", () => {
    seedMissing(7);
    setWhitelistMembership({
      id: 7,
      enabled: true,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    });
    diskMessages.length = 0;
    acceptDiskMessages = false;
    expect(setWhitelistPermission({
      id: 7,
      key: "isCanMute",
      value: DEFAULT_WHITELIST_PERMISSIONS.isCanMute,
    }).changed).toBeFalse();
    expect(diskMessages).toEqual([]);
  });

  test("投递失败后按同一值重试会补投未 ACK revision 并等事务确认", async () => {
    seedMissing(7);
    acceptDiskMessages = false;
    expect(() => setWhitelistMembership({
      id: 7,
      enabled: true,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    })).toThrow("persistence Worker rejected it");

    acceptDiskMessages = true;
    const retry = setWhitelistMembership({ id: 7, enabled: true });
    expect(retry.changed).toBeFalse();
    await expect(confirmWhitelistEntryPersisted(7, true)).resolves.toBeUndefined();

    expect(diskMessages).toHaveLength(2);
    expect(flushDiskIODomainOutcome).toHaveBeenCalledWith("whitelist");
    expect(unacknowledgedWhitelistWrites.has(7)).toBeFalse();
  });
});
