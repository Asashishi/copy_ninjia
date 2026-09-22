import { mock } from "bun:test";
import {
  blocklistIdentityMutationQueues,
  blocklistParticipantInvalidQueue,
} from "../../packages/cache/main/blocklist";
import { identityEntryCounts } from "../../packages/cache/main/identityStorage";
import { diskIOStub } from "./diskIOMock";
import { loggerStub } from "./loggerMock";
import { waitUntil } from "./waitUntil";
import type * as diskIO from "../../packages/infra/diskIO";
import type { BlockedMembersRemovedEvent } from "../../packages/types/antiRaid/events";
import type {
  DiskBusinessMessage,
  DiskIODomain,
  DomainFlushOutcome,
  IdentityPolicyWriteDiskMessage,
  IdentityStoragePersistedReply,
} from "../../packages/types/diskIO";
import type { BlocklistEntryData } from "../../packages/types/identityPolicy";
import type { BlocklistIdPage, IdentityPolicyRawReadResult } from "../../packages/types/identityStorage";

/**
 * 黑名单销号计数测试共用的 Disk I/O 与日志替身。
 *
 * 数据库替身只保存「已提交」的黑名单行；flush 只 ACK 发起 flush 那一刻之前投递的
 * 写入，与 Disk I/O Worker 的 FIFO 语义一致。`mock.module` 登记留在各用例文件。
 */

export const BLOCKED_AT: string = "2026/08/11 00:00:00";
export const META: BlocklistEntryData["meta"] = { firstName: "Gone", lastName: "", username: "" };

/** 用例可改写的替身状态；每条用例前由 resetParticipantInvalidHarness 清空。 */
export const participantInvalidHarness: {
  readonly diskMessages: DiskBusinessMessage[];
  readonly persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[];
  readonly storedBlocklist: Map<number, string>;
  readonly logged: string[];
  readonly loggedErrors: string[];
  readGate: Promise<void> | null;
  readFailure: Error | null;
  flushGate: Promise<void> | null;
} = {
  diskMessages: [],
  persistedListeners: [],
  storedBlocklist: new Map<number, string>(),
  logged: [],
  loggedErrors: [],
  readGate: null,
  readFailure: null,
  flushGate: null,
};

export const readIdentityPolicies = mock(async (ids: readonly number[]): Promise<IdentityPolicyRawReadResult> => {
  const gate: Promise<void> | null = participantInvalidHarness.readGate;
  if (gate !== null) await gate;
  if (participantInvalidHarness.readFailure !== null) throw participantInvalidHarness.readFailure;
  const blocklist: (readonly [number, string])[] = [];
  for (const id of ids) {
    const data: string | undefined = participantInvalidHarness.storedBlocklist.get(id);
    if (data !== undefined) blocklist.push([id, data]);
  }
  return { whitelist: [], blocklist, temporaryAdBypass: [] };
});

export function identityWrites(domain: DiskIODomain): IdentityPolicyWriteDiskMessage[] {
  const writes: IdentityPolicyWriteDiskMessage[] = [];
  for (const message of participantInvalidHarness.diskMessages) {
    if (message.type === "identityPolicyWrite" && message.table === domain) writes.push(message);
  }
  return writes;
}

export const flushDiskIODomainOutcome = mock(async (domain: DiskIODomain): Promise<DomainFlushOutcome> => {
  const covered: IdentityPolicyWriteDiskMessage[] = identityWrites(domain);
  const gate: Promise<void> | null = participantInvalidHarness.flushGate;
  if (gate !== null) await gate;
  for (const write of covered) {
    if (write.data === null) participantInvalidHarness.storedBlocklist.delete(write.id);
    else participantInvalidHarness.storedBlocklist.set(write.id, write.data);
  }
  for (const listener of participantInvalidHarness.persistedListeners) {
    listener({
      type: "identityStoragePersisted",
      writes: covered.map((write: IdentityPolicyWriteDiskMessage) => ({
        table: write.table,
        id: write.id,
        revision: write.revision,
      })),
      temporaryAdBypassWrites: [],
      chatStateWrites: [],
      chatQaWrites: [],
    });
  }
  return { result: "flushed" };
});

/** `infra/diskIO` 的完整替身。 */
export function participantInvalidDiskIO(): typeof diskIO {
  return diskIOStub({
    isDiskIOInitialized: (): boolean => true,
    onIdentityStoragePersisted: (listener: (reply: IdentityStoragePersistedReply) => void): void => {
      participantInvalidHarness.persistedListeners.push(listener);
    },
    postDiskIO: (message: DiskBusinessMessage): boolean => {
      participantInvalidHarness.diskMessages.push(message);
      return true;
    },
    flushDiskIODomain: async (): Promise<"flushed"> => "flushed",
    flushDiskIODomainOutcome,
    readIdentityPolicies,
    readBlocklistIdPage: async (afterId: number | null): Promise<BlocklistIdPage> => ({
      ids: [],
      nextCursor: afterId,
      done: true,
    }),
    relayLogMessage: (): boolean => true,
  });
}

/** `infra/logger` 替身：记录 log 与 error 的首个参数。 */
export function participantInvalidLogger(): { logger: ReturnType<typeof loggerStub> } {
  return {
    logger: loggerStub({
      log: (message: unknown): void => { participantInvalidHarness.logged.push(String(message)); },
      error: (message: unknown): void => { participantInvalidHarness.loggedErrors.push(String(message)); },
    }),
  };
}

/** 在已提交行中放一条黑名单，并同步启动计数。 */
export function storeBlocked(id: number, participantInvalidCount?: number): void {
  participantInvalidHarness.storedBlocklist.set(id, JSON.stringify({
    blockedAt: BLOCKED_AT,
    meta: META,
    ...(participantInvalidCount === undefined ? {} : { participantInvalidCount }),
  }));
  identityEntryCounts.blocklist = participantInvalidHarness.storedBlocklist.size;
}

export function receipt(
  participantInvalidUserIds: readonly number[],
  settledUserIds: readonly number[] = []
): BlockedMembersRemovedEvent {
  return {
    type: "blockedMembersRemoved",
    chatId: -1001,
    removalId: 1,
    complete: false,
    permissionDenied: false,
    targetIsAdmin: false,
    participantInvalidUserIds,
    settledUserIds,
  };
}

/** 某身份最后一次黑名单写入的解析结果；tombstone 为 null，没有写入为 undefined。 */
export function lastWrittenData(id: number): unknown {
  const writes: IdentityPolicyWriteDiskMessage[] = identityWrites("blocklist")
    .filter((write: IdentityPolicyWriteDiskMessage): boolean => write.id === id);
  const data: string | null | undefined = writes.at(-1)?.data;
  return data === null || data === undefined ? data : JSON.parse(data);
}

/** 每条黑名单写入的计数字段，tombstone 记为 null。 */
export function writtenCounts(): readonly (readonly [number, unknown])[] {
  return identityWrites("blocklist").map((write: IdentityPolicyWriteDiskMessage) => [
    write.id,
    write.data === null ? null : JSON.parse(write.data).participantInvalidCount,
  ] as const);
}

/** 等销号计数队列与黑名单身份写入队列都排空。 */
export async function drainParticipantInvalidWork(): Promise<void> {
  await blocklistParticipantInvalidQueue.current;
  await waitUntil((): boolean => blocklistIdentityMutationQueues.size === 0);
}

/** 清空替身状态与调用记录；生产缓存由用例文件自行重置。 */
export function resetParticipantInvalidHarness(): void {
  participantInvalidHarness.diskMessages.length = 0;
  participantInvalidHarness.storedBlocklist.clear();
  participantInvalidHarness.logged.length = 0;
  participantInvalidHarness.loggedErrors.length = 0;
  participantInvalidHarness.readGate = null;
  participantInvalidHarness.readFailure = null;
  participantInvalidHarness.flushGate = null;
  readIdentityPolicies.mockClear();
  flushDiskIODomainOutcome.mockClear();
}
