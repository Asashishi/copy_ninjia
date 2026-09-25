import { beforeEach, describe, expect, mock, test } from "bun:test";
import { diskIOStub } from "../helpers/diskIOMock";
import {
  IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES,
  IDENTITY_READ_CACHE_MAX_ENTRIES,
} from "../../packages/consts/identityStorage";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import type {
  IdentityPolicyRawReadResult,
  IdentityPolicyVerdicts,
} from "../../packages/types/identityStorage";

/**
 * 身份 LRU 驻留与批量处置局部结论：预热命中刷新热度，破坏性批量路径按块直接
 * 冷读并局部持有结论（见 infra/identityStorage/read.ts）。
 */

let readImplementation: (ids: readonly number[]) => Promise<IdentityPolicyRawReadResult> =
  async (): Promise<IdentityPolicyRawReadResult> => ({ whitelist: [], blocklist: [], temporaryAdBypass: [] });
const readIdentityPolicies = mock(
  (ids: readonly number[]): Promise<IdentityPolicyRawReadResult> => readImplementation(ids)
);

mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  isDiskIOInitialized: (): boolean => true,
  postDiskIO: (): boolean => true,
  readIdentityPolicies,
})));

const {
  resetIdentityStorageCache,
  whitelistEntryCache,
  blocklistEntryCache,
} = await import("../../packages/cache/main/identityStorage");
const { temporaryAdBypassActivityCache } = await import("../../packages/cache/main/temporaryAdBypass");
const {
  cachedWhitelistEntry,
  isIdentityPolicyCached,
  prefetchIdentityPolicies,
  readIdentityPolicyVerdicts,
} = await import("../../packages/infra/identityStorage");

function seedMissing(id: number): void {
  blocklistEntryCache.set(id, null);
  whitelistEntryCache.set(id, null);
  temporaryAdBypassActivityCache.set(id, null);
}

function whitelistText(username: string): string {
  return JSON.stringify({
    permissions: DEFAULT_WHITELIST_PERMISSIONS,
    meta: { firstName: username, lastName: "", username },
  });
}

beforeEach(() => {
  resetIdentityStorageCache();
  readIdentityPolicies.mockClear();
  readImplementation = async (): Promise<IdentityPolicyRawReadResult> => ({
    whitelist: [],
    blocklist: [],
    temporaryAdBypass: [],
  });
});

describe("身份 LRU 驻留与批量处置结论", () => {
  test("预热命中的已缓存身份刷新热度，不被同一次预热写入的冷键挤出", async () => {
    const admin: number = 777;
    seedMissing(admin);
    whitelistEntryCache.set(admin, JSON.parse(whitelistText("admin")));
    // 其它身份全部比管理员新，管理员停在三份 LRU 的最旧端。
    for (let id: number = 1; id < IDENTITY_READ_CACHE_MAX_ENTRIES; id++) seedMissing(1_000_000 + id);
    const chunk: number[] = [admin];
    for (let id: number = 1; id < IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES; id++) chunk.push(2_000_000 + id);

    await expect(prefetchIdentityPolicies(chunk)).resolves.toBeTrue();

    expect(readIdentityPolicies.mock.calls[0]![0]).not.toContain(admin);
    expect(cachedWhitelistEntry(admin)?.meta.username).toBe("admin");
    expect(isIdentityPolicyCached(admin)).toBeTrue();
  });

  test("批量处置结论直接冷读全部身份，局部持有且不受之后的 LRU 淘汰影响", async () => {
    seedMissing(1);
    readImplementation = async (): Promise<IdentityPolicyRawReadResult> => ({
      whitelist: [[1, whitelistText("alice")]],
      blocklist: [[2, JSON.stringify({
        blockedAt: "2026/08/11 00:00:00",
        meta: { firstName: "Bob", lastName: "", username: "bob" },
      })]],
      temporaryAdBypass: [],
    });

    const verdicts: IdentityPolicyVerdicts | null = await readIdentityPolicyVerdicts([1, 2, 3, 2]);

    // 已缓存的 1 也要重读：局部结论不能建立在可能随时被淘汰的缓存上。
    expect(readIdentityPolicies.mock.calls[0]![0]).toEqual([1, 2, 3]);
    expect([...verdicts!.whitelisted]).toEqual([1]);
    expect([...verdicts!.blocked]).toEqual([2]);
    for (let id: number = 1; id <= IDENTITY_READ_CACHE_MAX_ENTRIES; id++) seedMissing(3_000_000 + id);
    expect(cachedWhitelistEntry(1)).toBeUndefined();
    expect(verdicts!.whitelisted.has(1)).toBeTrue();
  });

  test("批量处置结论按预取分块上限分批读取，任一块失败返回 null", async () => {
    const ids: number[] = [];
    for (let id: number = 1; id <= IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES + 1; id++) ids.push(id);
    readImplementation = async (
      requested: readonly number[]
    ): Promise<IdentityPolicyRawReadResult> => {
      if (requested.length === 1) throw new Error("Persistence Worker is unavailable.");
      return { whitelist: [], blocklist: [], temporaryAdBypass: [] };
    };

    await expect(readIdentityPolicyVerdicts(ids)).resolves.toBeNull();
    expect(readIdentityPolicies).toHaveBeenCalledTimes(2);
    expect(readIdentityPolicies.mock.calls[0]![0]).toHaveLength(IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES);
  });
});
