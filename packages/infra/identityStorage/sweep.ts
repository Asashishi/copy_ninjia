import * as diskIO from "../diskIO";
import {
  blocklistEntryCache,
  blocklistSweepFlushWindows,
  identityEntryCounts,
  unacknowledgedBlocklistWrites,
} from "../../cache/main/identityStorage";
import { BLOCKLIST_SWEEP_PAGE_SIZE } from
  "../../consts/identityStorage";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
} from "../../database/codec/identity";
import {
  currentIdentityPolicyText,
  rawIdentityPolicyRows,
} from "./shared";
import type { DomainFlushOutcome } from "../../types/diskIO/replies";
import type { BlocklistEntryData } from "../../types/identityPolicy";
import type { BlocklistIdPage, IdentityPolicyRawReadResult } from
  "../../types/identityStorage";

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

function closeBlocklistSweepFlushWindow(generation: number): void {
  if (blocklistSweepFlushWindows.generation !== generation) return;
  blocklistSweepFlushWindows.open--;
  if (blocklistSweepFlushWindows.open !== 0) return;
  const closed: PromiseWithResolvers<void> | null = blocklistSweepFlushWindows.closed;
  blocklistSweepFlushWindows.closed = null;
  closed?.resolve();
}

/**
 * 群级补扫读取一页稳定主键；读取前提交黑名单事务并确认本地 revision 已 ACK。
 * flush 请求到核对结束之间登记为打开的窗口，见 writeOutsideBlocklistSweepFlushWindows。
 */
export async function readBlocklistSweepPage(
  afterId: number | null
): Promise<BlocklistIdPage> {
  const generation: number = blocklistSweepFlushWindows.generation;
  blocklistSweepFlushWindows.open++;
  try {
    const outcome: DomainFlushOutcome = await diskIO.flushDiskIODomainOutcome("blocklist");
    if (outcome.result !== "flushed") {
      throw new Error(`Blocklist sweep flush ${outcome.result}.`);
    }
    if (unacknowledgedBlocklistWrites.size !== 0) {
      throw new Error(
        `Blocklist sweep flush left ${unacknowledgedBlocklistWrites.size} unacknowledged write(s).`
      );
    }
  } finally {
    closeBlocklistSweepFlushWindow(generation);
  }
  return validateBlocklistIdPage(await diskIO.readBlocklistIdPage(afterId), afterId);
}

/**
 * 等到没有补扫分页读处在 flush 与未 ACK 核对之间，再在确认窗口关闭的同一同步
 * 片段内执行 write；之后开始的分页读由自己的 flush 覆盖 write 投递的黑名单写入。
 */
export async function writeOutsideBlocklistSweepFlushWindows<T>(
  write: () => T
): Promise<T> {
  while (blocklistSweepFlushWindows.open > 0) {
    blocklistSweepFlushWindows.closed ??= Promise.withResolvers<void>();
    await blocklistSweepFlushWindows.closed.promise;
  }
  return write();
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
  const reply: IdentityPolicyRawReadResult = await diskIO.readIdentityPolicies(ids);
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

/**
 * 挑出当前黑名单条目带 participantInvalidCount 的身份，不回填 LRU。
 * 已缓存的只 peek，不改变淘汰顺序；冷缺失按页读库并叠加本地未 ACK 最终值。
 */
export async function retainParticipantInvalidBlocklistIds(
  ids: readonly number[]
): Promise<readonly number[]> {
  const retained: number[] = [];
  const cold: number[] = [];
  for (const id of ids) {
    const cached: Readonly<BlocklistEntryData> | null | undefined =
      blocklistEntryCache.peek(id);
    if (cached === undefined) cold.push(id);
    else if (cached?.participantInvalidCount !== undefined) retained.push(id);
  }
  for (
    let index: number = 0;
    index < cold.length;
    index += BLOCKLIST_SWEEP_PAGE_SIZE
  ) {
    const chunk: readonly number[] =
      cold.slice(index, index + BLOCKLIST_SWEEP_PAGE_SIZE);
    const reply: IdentityPolicyRawReadResult = await diskIO.readIdentityPolicies(chunk);
    const rows: Map<number, string> = rawIdentityPolicyRows(
      reply.blocklist,
      new Set(chunk),
      "blocklist"
    );
    for (const id of chunk) {
      const text: string | null = currentIdentityPolicyText("blocklist", id, rows.get(id));
      if (
        text !== null &&
        decodeBlocklistEntryData(text, `blocklist_entries[${id}].data`)
          .participantInvalidCount !== undefined
      ) {
        retained.push(id);
      }
    }
  }
  return retained;
}
