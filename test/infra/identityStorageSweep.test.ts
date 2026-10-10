/**
 * 主线程黑名单补扫：每页先等待黑名单精确 ACK 再按游标读取 SQLite、flush 期间并发写的
 * revision 归属、durable 对账与未 ACK 最终值叠加，以及 Disk I/O 游标页回包的 fail-closed 校验。
 *
 * Disk I/O 替身与逐用例复位见 test/helpers/identityStorageHarness.ts。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  blockValue,
  diskMessages,
  flushDiskIODomain,
  pageReadImplementation,
  readBlocklistIdPage,
  readImplementation,
  resetIdentityStorageHarness,
} from "../helpers/identityStorageHarness";
import { seedMissingIdentity as seedMissing } from "../helpers/identityStorage";
import { BLOCKLIST_SWEEP_PAGE_SIZE } from "../../packages/consts/identityStorage";
import type { DomainFlushOutcome } from "../../packages/types/diskIO";
import type {
  BlocklistIdPage,
  IdentityPolicyRawReadResult,
} from "../../packages/types/identityStorage";

const {
  blocklistEntryCache,
  identityEntryCounts,
  unacknowledgedBlocklistWrites,
  whitelistEntryCache,
} = await import("../../packages/cache/main/identityStorage");
const {
  queueIdentityPolicyWrite,
  readBlocklistSweepPage,
  retainCurrentlyBlockedIdentityIds,
} = await import("../../packages/infra/identityStorage");

beforeEach(resetIdentityStorageHarness);

describe("主线程身份 LRU 与数据库最终一致性", () => {
  test("补扫每页先等待黑名单精确 ACK，再以该页游标读取 SQLite", async () => {
    seedMissing(7);
    queueIdentityPolicyWrite("blocklist", 7, blockValue());
    pageReadImplementation.current = async (): Promise<BlocklistIdPage> => ({
      ids: [7],
      nextCursor: 7,
      done: true,
    });

    await expect(readBlocklistSweepPage(null)).resolves.toEqual({
      ids: [7],
      nextCursor: 7,
      done: true,
    });

    expect(flushDiskIODomain).toHaveBeenCalledWith("blocklist");
    expect(unacknowledgedBlocklistWrites.size).toBe(0);
    expect(readBlocklistIdPage).toHaveBeenCalledWith(null);
  });

  test("flush 没有精确 ACK 时拒绝开始补扫，不拿数据库旧页继续", async () => {
    seedMissing(7);
    queueIdentityPolicyWrite("blocklist", 7, blockValue());
    flushDiskIODomain.mockImplementationOnce(
      async (): Promise<DomainFlushOutcome> => ({ result: "flushed" })
    );

    await expect(readBlocklistSweepPage(null))
      .rejects.toThrow("unacknowledged write");
    expect(readBlocklistIdPage).not.toHaveBeenCalled();
  });

  test("flush 期间并发排入的黑名单写不属于本页：核对只看 flush 前已登记的 revision", async () => {
    seedMissing(8);
    flushDiskIODomain.mockImplementationOnce(
      async (): Promise<DomainFlushOutcome> => {
        queueIdentityPolicyWrite("blocklist", 8, blockValue());
        return { result: "flushed" };
      }
    );
    pageReadImplementation.current = async (): Promise<BlocklistIdPage> => ({
      ids: [],
      nextCursor: null,
      done: true,
    });

    await expect(readBlocklistSweepPage(null)).resolves.toEqual({
      ids: [],
      nextCursor: null,
      done: true,
    });
    expect(unacknowledgedBlocklistWrites.has(8)).toBeTrue();
  });

  test("durable 对账只复核当前有界页，未 ACK 最终值覆盖数据库迟到结果", async () => {
    for (const id of [7, 8, 9]) seedMissing(id);
    queueIdentityPolicyWrite("blocklist", 7, null);
    queueIdentityPolicyWrite("blocklist", 9, blockValue());
    readImplementation.current = async (): Promise<IdentityPolicyRawReadResult> => ({
      whitelist: [],
      blocklist: [[7, "{}"], [8, "{}"]],
      temporaryAdBypass: [],
    });

    await expect(retainCurrentlyBlockedIdentityIds([7, 8, 9]))
      .resolves.toEqual([8, 9]);
  });
});

describe("补扫游标页 fail-closed 校验", () => {
  /** 伪造一份 Disk I/O 游标页回包，断言主线程拒收且不留下任何据此产生的状态。 */
  async function expectRejectedPage(
    afterId: number | null,
    page: BlocklistIdPage,
    message: string
  ): Promise<void> {
    readBlocklistIdPage.mockClear();
    pageReadImplementation.current = async (): Promise<BlocklistIdPage> => page;

    await expect(readBlocklistSweepPage(afterId)).rejects.toThrow(message);

    expect(flushDiskIODomain).toHaveBeenCalledWith("blocklist");
    expect(readBlocklistIdPage).toHaveBeenCalledTimes(1);
    expect(readBlocklistIdPage).toHaveBeenCalledWith(afterId);
    expect(diskMessages).toEqual([]);
    expect(identityEntryCounts).toEqual({ whitelist: 0, blocklist: 0 });
    expect(blocklistEntryCache.size).toBe(0);
    expect(whitelistEntryCache.size).toBe(0);
  }

  test("超过固定页大小的回包被拒收，即使升序与游标都自洽", async () => {
    const ids: number[] = [];
    for (let id: number = 1; id <= BLOCKLIST_SWEEP_PAGE_SIZE + 1; id++) ids.push(id);
    await expectRejectedPage(
      null,
      { ids, nextCursor: BLOCKLIST_SWEEP_PAGE_SIZE + 1, done: true },
      `Blocklist ID page exceeds ${BLOCKLIST_SWEEP_PAGE_SIZE} entries.`
    );
  });

  test("页内出现 0 或非安全整数主键时按非法身份拒收", async () => {
    await expectRejectedPage(
      null,
      { ids: [0], nextCursor: 0, done: true },
      "blocklist ID page: $.id must be a non-zero safe integer Telegram identity ID."
    );
    const unsafeId: number = Number.MAX_SAFE_INTEGER + 1;
    await expectRejectedPage(
      null,
      { ids: [unsafeId], nextCursor: unsafeId, done: true },
      "blocklist ID page: $.id must be a non-zero safe integer Telegram identity ID."
    );
  });

  test("主键不严格晚于游标或页内不严格升序时拒收", async () => {
    await expectRejectedPage(
      7,
      { ids: [7], nextCursor: 7, done: true },
      "Blocklist ID page must be strictly ordered after its cursor."
    );
    await expectRejectedPage(
      null,
      { ids: [9, 9], nextCursor: 9, done: true },
      "Blocklist ID page must be strictly ordered after its cursor."
    );
  });

  test("续读游标不是本页末尾主键、或空页挪动了请求游标时拒收", async () => {
    await expectRejectedPage(
      7,
      { ids: [8, 9], nextCursor: 8, done: true },
      "Blocklist ID page returned an inconsistent next cursor."
    );
    await expectRejectedPage(
      7,
      { ids: [], nextCursor: null, done: true },
      "Blocklist ID page returned an inconsistent next cursor."
    );
  });

  test("非最后一页未填满固定页大小时拒收，空的非最后一页同样拒收", async () => {
    await expectRejectedPage(
      null,
      { ids: [8, 9], nextCursor: 9, done: false },
      "A non-final blocklist ID page must fill the fixed page size."
    );
    await expectRejectedPage(
      7,
      { ids: [], nextCursor: 7, done: false },
      "A non-final blocklist ID page must fill the fixed page size."
    );
  });
});
