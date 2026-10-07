/**
 * 主线程身份存储用例文件（身份 LRU 与写入确认、临时广告免检、黑名单补扫游标页）共用的
 * Disk I/O 替身、可调旋钮与逐用例复位。
 *
 * 形态照 `test/helpers/blocklistSweepHarness.ts`：import 期登记
 * `mock.module("../../packages/infra/diskIO")`，必须在被测生产模块之前 import；
 * 各用例文件用顶层 `await import` 拿生产模块，天然满足。助手自身不 await import 被测模块，
 * 被测出口由用例文件自行解构。
 */

import { mock } from "bun:test";
import { diskIOReplyStub, diskIOStub } from "./diskIOMock";
import { resetIdentityStorageCache } from "../../packages/cache/main/identityStorage";
import type { DiskIODomain } from "../../packages/types/diskIO/replies";
import type {
  DiskBusinessMessage,
  DomainFlushOutcome,
  DiskIORecoveryTransport,
  DiskIORespawnListener,
  IdentityStoragePersistedReply,
} from "../../packages/types/diskIO";
import type { BlocklistEntryData } from "../../packages/types/identityPolicy";
import type {
  BlocklistIdPage,
  IdentityPolicyRawReadResult,
} from "../../packages/types/identityStorage";

/** 被测模块经 postDiskIO 投出的全部业务消息，按投递顺序记录；每个用例开始时清空。 */
export const diskMessages: DiskBusinessMessage[] = [];
/** 生产 owner 登记的 identityStoragePersisted 回执回调；用例据此模拟事务精确 ACK。 */
export const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
/** 生产 owner 按登记顺序留下的 Disk I/O 重建重放回调；用例据此驱动 Worker 重建。 */
export const respawnListeners: DiskIORespawnListener[] = [];

async function emptyIdentityPolicyRead(): Promise<IdentityPolicyRawReadResult> {
  return { whitelist: [], blocklist: [], temporaryAdBypass: [] };
}

async function emptyBlocklistIdPage(afterId: number | null): Promise<BlocklistIdPage> {
  return { ids: [], nextCursor: afterId, done: true };
}

/** 身份策略冷读的当前实现；每个用例开始时复位为三张关系都没有行的空结果。 */
export const readImplementation: {
  current: (ids: readonly number[]) => Promise<IdentityPolicyRawReadResult>;
} = { current: emptyIdentityPolicyRead };
/** 黑名单游标页读取的当前实现；每个用例开始时复位为停在原游标的空末页。 */
export const pageReadImplementation: {
  current: (afterId: number | null) => Promise<BlocklistIdPage>;
} = { current: emptyBlocklistIdPage };
/** postDiskIO 的返回值；false 模拟 Disk I/O 拒收投递。每个用例开始时复位为 true。 */
export const acceptDiskMessages: { current: boolean } = { current: true };

export const readIdentityPolicies = mock(
  (ids: readonly number[]): Promise<IdentityPolicyRawReadResult> => readImplementation.current(ids)
);
export const readBlocklistIdPage = mock(
  (afterId: number | null): Promise<BlocklistIdPage> =>
    pageReadImplementation.current(afterId)
);
/**
 * 领域 flush 替身：把已投出的该领域身份写逐条作为精确 ACK 交给回执回调，再报告
 * flushed。用例可用 mockImplementationOnce 模拟缺少精确 ACK 或 flush 失败。
 */
export const flushDiskIODomainOutcome = mock(
  async (domain: DiskIODomain): Promise<DomainFlushOutcome> => {
    const writes: { table: "whitelist" | "blocklist"; id: number; revision: number }[] = [];
    for (const message of diskMessages) {
      if (message.type !== "identityPolicyWrite" || message.table !== domain) continue;
      writes.push({ table: message.table, id: message.id, revision: message.revision });
    }
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes,
        temporaryAdBypassWrites: [],
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    return { result: "flushed" };
  }
);

mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  isDiskIOInitialized: (): boolean => true,
  onDiskIORespawn: (
    _owner: string,
    _priority: number,
    listener: DiskIORespawnListener
  ): void => {
    respawnListeners.push(listener);
  },
  onDiskIOReply: diskIOReplyStub({
    identityStoragePersisted: (listener: (reply: IdentityStoragePersistedReply) => void): void => {
      persistedListeners.push(listener);
    },
  }),
  postDiskIO: (message: DiskBusinessMessage): boolean => {
    diskMessages.push(message);
    return acceptDiskMessages.current;
  },
  flushDiskIODomainOutcome,
  readBlocklistIdPage,
  readIdentityPolicies,
  relayLogMessage: (): boolean => true,
})));

/** 黑名单写入值夹具：meta 固定为测试身份 alice，拉黑时刻可调。 */
export function blockValue(
  blockedAt: string = "2026/08/11 00:00:00"
): Readonly<BlocklistEntryData> {
  return {
    blockedAt,
    meta: { firstName: "Alice", lastName: "", username: "alice" },
  };
}

/** Worker 重建重放用的恢复传输：按顺序收下重放消息并接受投递；本组用例不涉及运势回执密钥。 */
export function recordingTransport(replayed: DiskBusinessMessage[]): DiskIORecoveryTransport {
  return {
    post(message: DiskBusinessMessage): boolean {
      replayed.push(message);
      return true;
    },
    ensureLuckReceiptSecret: async (): Promise<never> => {
      throw new Error("not used");
    },
  };
}

/** 各用例文件的 beforeEach：清空投递记录、主线程身份缓存与读取替身，恢复默认旋钮。 */
export function resetIdentityStorageHarness(): void {
  diskMessages.length = 0;
  acceptDiskMessages.current = true;
  resetIdentityStorageCache();
  readIdentityPolicies.mockClear();
  readBlocklistIdPage.mockClear();
  flushDiskIODomainOutcome.mockClear();
  readImplementation.current = emptyIdentityPolicyRead;
  pageReadImplementation.current = emptyBlocklistIdPage;
}
