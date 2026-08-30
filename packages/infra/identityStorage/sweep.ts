import {
  identityEntryCounts,
  unacknowledgedBlocklistWrites,
} from "../../cache/main/identityStorage";
import { BLOCKLIST_SWEEP_PAGE_SIZE } from
  "../../consts/identityStorage";
import { assertTelegramIdentityId } from
  "../../database/codec/identity";
import {
  currentIdentityPolicyText,
  identityDiskIOApi,
  rawIdentityPolicyRows,
} from "./shared";
import type { DomainFlushOutcome } from "../../types/diskIO/replies";
import type { BlocklistIdPage, IdentityPolicyRawReadResult } from
  "../../types/identityStorage";
import type { IdentityDiskIOApi } from "./shared";

/** 是否至少存在一个黑名单身份；只读启动计数，不持有整表 ID。 */
export function hasAnyBlockedIdentity(): boolean {
  return identityEntryCounts.blocklist > 0;
}

/** 校验 Disk I/O 回传的游标页仍满足固定大小、严格升序与续读游标契约。 */
function validateBlocklistIdPage(
  page: BlocklistIdPage,
  afterId: number | null
): BlocklistIdPage {
  if (page.ids.length > BLOCKLIST_SWEEP_PAGE_SIZE) {
    throw new Error(
      `Blocklist ID page exceeds ${BLOCKLIST_SWEEP_PAGE_SIZE} entries.`
    );
  }
  let previous: number | null = afterId;
  for (const id of page.ids) {
    assertTelegramIdentityId(id, "blocklist ID page");
    if (previous !== null && id <= previous) {
      throw new Error("Blocklist ID page must be strictly ordered after its cursor.");
    }
    previous = id;
  }
  const expectedCursor: number | null = page.ids.length === 0
    ? afterId
    : page.ids[page.ids.length - 1]!;
  if (page.nextCursor !== expectedCursor) {
    throw new Error("Blocklist ID page returned an inconsistent next cursor.");
  }
  if (!page.done && page.ids.length !== BLOCKLIST_SWEEP_PAGE_SIZE) {
    throw new Error("A non-final blocklist ID page must fill the fixed page size.");
  }
  return page;
}

/**
 * 群级补扫读取一页稳定主键；读取前提交黑名单事务并确认本地 revision 已 ACK。
 */
export async function readBlocklistSweepPage(
  afterId: number | null
): Promise<BlocklistIdPage> {
  const flush: IdentityDiskIOApi["flushDiskIODomainOutcome"] =
    identityDiskIOApi.flushDiskIODomainOutcome;
  const read: IdentityDiskIOApi["readBlocklistIdPage"] =
    identityDiskIOApi.readBlocklistIdPage;
  if (flush === undefined || read === undefined) {
    return { ids: [], nextCursor: afterId, done: true };
  }
  const outcome: DomainFlushOutcome = await flush("blocklist");
  if (outcome.result !== "flushed") {
    throw new Error(`Blocklist sweep flush ${outcome.result}.`);
  }
  if (unacknowledgedBlocklistWrites.size !== 0) {
    throw new Error(
      `Blocklist sweep flush left ${unacknowledgedBlocklistWrites.size} unacknowledged write(s).`
    );
  }
  return validateBlocklistIdPage(await read(afterId), afterId);
}

/**
 * durable outbox flush 后复核一个有界处置页；迟到的本地最终值覆盖数据库旧值。
 */
export async function retainCurrentlyBlockedIdentityIds(
  ids: readonly number[]
): Promise<readonly number[]> {
  if (ids.length > BLOCKLIST_SWEEP_PAGE_SIZE) {
    throw new Error(
      `Blocklist reconciliation accepts at most ${BLOCKLIST_SWEEP_PAGE_SIZE} IDs.`
    );
  }
  if (ids.length === 0) return [];
  const read: IdentityDiskIOApi["readIdentityPolicies"] =
    identityDiskIOApi.readIdentityPolicies;
  if (read === undefined) return ids;
  const reply: IdentityPolicyRawReadResult = await read(ids);
  const requested: Set<number> = new Set(ids);
  const rows: Map<number, string> = rawIdentityPolicyRows(
    reply.blocklist,
    requested,
    "blocklist"
  );
  const retained: number[] = [];
  for (const id of ids) {
    if (currentIdentityPolicyText("blocklist", id, rows.get(id)) !== null) {
      retained.push(id);
    }
  }
  return retained;
}
