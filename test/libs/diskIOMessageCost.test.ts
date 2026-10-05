import { getTimeZone } from "../../packages/config/time";
import { describe, expect, test } from "bun:test";
import {
  diskIOMessageCost,
  isDiskBusinessMessage,
} from "../../packages/libs/diskIOMessageCost";
import { DISK_BUSINESS_MESSAGE_BASE_BYTES } from "../../packages/consts/diskIO/business";
import { BLOCKLIST_REMOVAL_FAILURE_TYPES } from "../../packages/consts/antiRaid/blocklist";
import type { DiskIOOperationMessage } from "../../packages/types/diskIO/messages";
import type { VerificationSnapshot, VerificationSnapshotBase } from "../../packages/types/antiRaid/verification";
import type { PendingBlockedRemoval } from "../../packages/types/blocklist";

/**
 * 计价与分类是跨线程传输预算和背压的唯一容量单位（见
 * infra/diskIO/transport.ts），漏掉一个变体不会有任何运行期迹象，只会让队列
 * 水位悄悄失真。因此这里按 `DiskIOOperationMessage["type"]` 建全表：少写一个键
 * 编译不过，新增一个变体也必须在这里显式给出它的计价口径。
 */
interface MessageCase {
  readonly message: DiskIOOperationMessage;
  /** 期望的载荷字节，与 base 相加即为 diskIOMessageCost 的返回值。 */
  readonly payloadBytes: number;
  /** 期望的 isDiskBusinessMessage 分类。 */
  readonly business: boolean;
  /** true 表示按结构上界计价：payloadBytes 是实际 JSON 字节，计价只须不低于它。 */
  readonly upperBound?: true;
}

/** 与生产实现同口径的 JSON 字节数；不引 Buffer，测试侧用 TextEncoder 等价计算。 */
function serializedBytes(value: unknown): number {
  return Math.max(1, new TextEncoder().encode(JSON.stringify(value)).length);
}

const SNAPSHOT: VerificationSnapshot = {
  chatId: -1001,
  userId: 42,
  generation: 1,
  revision: 3,
  phase: "pending",
  label: "待验证",
  isBot: false,
  trackedMessageTimes: [],
  replyReminderRequested: false,
  reminderSuperseded: false,
  joinedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_060_000,
};

const REMOVAL: PendingBlockedRemoval = {
  params: { chatId: -1001, probeMembership: false, userIds: [7, 8], removalId: 5 },
  createdAt: 1_700_000_000_000,
  attempts: 0,
  lastFailure: null,
};

const BLOCKLIST_REMOVALS: DiskIOOperationMessage = {
  type: "blocklistRemovals",
  removals: [[-1001, REMOVAL]],
  revision: 9,
};

const VERIFICATION_UPSERT: DiskIOOperationMessage = {
  type: "verificationUpsert",
  record: SNAPSHOT,
  critical: true,
};

const DIAGNOSTIC_BATCH: DiskIOOperationMessage = {
  type: "diagnosticBatch",
  batchId: 4,
  messages: [{ type: "log", id: "log-1", timestamp: 1_700_000_000_000, level: "error", args: ["boom"] }],
};

const CASES: Readonly<Record<DiskIOOperationMessage["type"], MessageCase>> = {
  aiMemory: {
    message: { type: "aiMemory", chatId: -1001, revision: 2, snapshot: "记忆快照" },
    payloadBytes: "记忆快照".length * 2,
    business: true,
  },
  stickerCatalog: {
    message: { type: "stickerCatalog", revision: 1, pack: "pack_name", snapshot: "目录" },
    payloadBytes: ("目录".length + "pack_name".length) * 2,
    business: true,
  },
  luckDraw: {
    message: {
      type: "luckDraw",
      day: "2026-09-07",
      key: "42:abcdef",
      label: "大吉",
      fortunePercent: 88,
    },
    payloadBytes: ("2026-09-07".length + "42:abcdef".length + "大吉".length) * 2,
    business: true,
  },
  identityPolicyWrite: {
    message: {
      type: "identityPolicyWrite",
      table: "whitelist",
      id: 42,
      data: "{\"isCanCopy\":true}",
      revision: 1,
    },
    payloadBytes: "{\"isCanCopy\":true}".length * 2,
    business: true,
  },
  chatStateWrite: {
    // data 为 null 的墓碑写：载荷按 0 计，只留 base。
    message: { type: "chatStateWrite", chatId: -1001, data: null, revision: 4 },
    payloadBytes: 0,
    business: true,
  },
  chatQaWrite: {
    message: {
      type: "chatQaWrite",
      chatId: -1001,
      q: "问题",
      data: "答案文本",
      revision: 2,
    },
    payloadBytes: ("问题".length + "答案文本".length) * 2,
    business: true,
  },
  readIdentityPolicies: {
    message: { type: "readIdentityPolicies", requestId: 1, ids: [1, 2, 3] },
    payloadBytes: 3 * 8,
    business: false,
  },
  wedMembers: {
    message: { type: "wedMembers", chatId: -1001, revision: 6, members: [1, 2, 3, 4] },
    payloadBytes: 4 * 8,
    business: true,
  },
  deleteWedMembers: {
    message: { type: "deleteWedMembers", chatId: -1001, revision: 1 },
    payloadBytes: 0,
    business: true,
  },
  blocklistRemovals: {
    message: BLOCKLIST_REMOVALS,
    payloadBytes: serializedBytes(BLOCKLIST_REMOVALS) * 2,
    business: true,
    upperBound: true,
  },
  verificationUpsert: {
    message: VERIFICATION_UPSERT,
    payloadBytes: serializedBytes(VERIFICATION_UPSERT) * 2,
    business: true,
    upperBound: true,
  },
  diagnosticBatch: {
    message: DIAGNOSTIC_BATCH,
    payloadBytes: serializedBytes(DIAGNOSTIC_BATCH) * 2,
    business: false,
  },
  load: {
    message: { type: "load", timeZone: getTimeZone(), stickerPacks: ["one", "two"] },
    payloadBytes: (getTimeZone().length + "one".length + "two".length) * 2,
    business: false,
  },
  ensureLuckSecret: {
    message: { type: "ensureLuckSecret", requestId: 2, day: "2026-09-07" },
    payloadBytes: "2026-09-07".length * 2,
    business: false,
  },
  joinLog: {
    message: {
      type: "joinLog",
      sequence: 1,
      chatId: -1001,
      userId: 42,
      joinedAt: 1_700_000_000_000,
      day: "2026-09-07",
    },
    payloadBytes: 0,
    business: true,
  },
  deleteJoinLog: {
    message: { type: "deleteJoinLog", chatId: -1001 },
    payloadBytes: 0,
    business: true,
  },
  deleteAiMemory: {
    message: { type: "deleteAiMemory", chatId: -1001, revision: 3 },
    payloadBytes: 0,
    business: true,
  },
  forgetAiMemory: {
    message: { type: "forgetAiMemory", chatId: -1001 },
    payloadBytes: 0,
    business: true,
  },
  verificationDelete: {
    message: {
      type: "verificationDelete",
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 5,
    },
    payloadBytes: 0,
    business: true,
  },
  temporaryAdBypassWrite: {
    message: { type: "temporaryAdBypassWrite", id: 42, activity: null, revision: 1 },
    payloadBytes: 0,
    business: true,
  },
  flush: {
    message: { type: "flush", flushId: 1, scope: "all" },
    payloadBytes: 0,
    business: false,
  },
  readJoinLog: {
    message: {
      type: "readJoinLog",
      requestId: 3,
      chatId: -1001,
      since: 1_700_000_000_000,
      now: 1_700_000_060_000,
    },
    payloadBytes: 0,
    business: false,
  },
  readBlocklistIdPage: {
    message: { type: "readBlocklistIdPage", requestId: 4, afterId: null },
    payloadBytes: 0,
    business: false,
  },
  recoveryReplay: {
    message: { type: "recoveryReplay", active: true },
    payloadBytes: 0,
    business: false,
  },
  storageFlushHold: {
    message: { type: "storageFlushHold", active: true },
    payloadBytes: 0,
    business: false,
  },
};

describe("Disk I/O 消息计价", () => {
  test("每个变体的计价口径与分类逐条固定", () => {
    for (const [type, expectation] of Object.entries(CASES)) {
      expect(expectation.message.type).toBe(type as DiskIOOperationMessage["type"]);
      if (expectation.upperBound === true) {
        expect(diskIOMessageCost(expectation.message)).toBeGreaterThanOrEqual(
          DISK_BUSINESS_MESSAGE_BASE_BYTES + expectation.payloadBytes
        );
      } else {
        expect(diskIOMessageCost(expectation.message)).toBe(
          DISK_BUSINESS_MESSAGE_BASE_BYTES + expectation.payloadBytes
        );
      }
      expect(isDiskBusinessMessage(expectation.message)).toBe(expectation.business);
    }
  });

  test("outbox 快照的结构上界覆盖最长整数、全部可选字段与每种失败分类，典型行不超过实际 1.5 倍", () => {
    const removals: [number, PendingBlockedRemoval][] = [];
    for (const lastFailure of [null, ...BLOCKLIST_REMOVAL_FAILURE_TYPES]) {
      const removalId: number = Number.MIN_SAFE_INTEGER + removals.length;
      removals.push([removalId, {
        params: {
          chatId: Number.MIN_SAFE_INTEGER,
          probeMembership: false,
          userIds: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
          removalId,
          joinedAt: Number.MIN_SAFE_INTEGER,
          announcementMessageId: Number.MIN_SAFE_INTEGER,
        },
        createdAt: Number.MIN_SAFE_INTEGER,
        attempts: Number.MIN_SAFE_INTEGER,
        lastFailure,
      }]);
      removals.push([removalId - 1, {
        params: { chatId: Number.MIN_SAFE_INTEGER, probeMembership: true, removalId: removalId - 1 },
        createdAt: Number.MIN_SAFE_INTEGER,
        attempts: Number.MIN_SAFE_INTEGER,
        lastFailure,
      }]);
    }
    const worst: DiskIOOperationMessage = { type: "blocklistRemovals", removals, revision: Number.MIN_SAFE_INTEGER };
    expect(diskIOMessageCost(worst)).toBeGreaterThanOrEqual(DISK_BUSINESS_MESSAGE_BASE_BYTES + serializedBytes(worst) * 2);

    const typicalRows: [number, PendingBlockedRemoval][] = [];
    for (let index: number = 1; index <= 64; index++) {
      typicalRows.push([index, {
        params: {
          chatId: -1_001_234_567_890 - index,
          probeMembership: false,
          userIds: [7_000_000_000 + index],
          removalId: index,
          joinedAt: 1_790_000_000_000 + index,
          announcementMessageId: 50_000 + index,
        },
        createdAt: 1_790_000_000_000 + index,
        attempts: index % 3,
        lastFailure: null,
      }]);
    }
    const typical: DiskIOOperationMessage = { type: "blocklistRemovals", removals: typicalRows, revision: 64 };
    const typicalJson: number = serializedBytes(typical) * 2;
    const typicalPayload: number = diskIOMessageCost(typical) - DISK_BUSINESS_MESSAGE_BASE_BYTES;
    expect(typicalPayload).toBeGreaterThanOrEqual(typicalJson);
    expect(typicalPayload).toBeLessThanOrEqual(typicalJson * 1.5);
  });

  test("验证快照的结构上界覆盖每个 phase 的全部可选字段、需转义的 label 与消息时间戳", () => {
    const label: string = "\u0001\"\\测试😀\ud800";
    const base: VerificationSnapshotBase = {
      chatId: Number.MIN_SAFE_INTEGER,
      userId: Number.MIN_SAFE_INTEGER,
      generation: Number.MIN_SAFE_INTEGER,
      revision: Number.MIN_SAFE_INTEGER,
      label,
      isBot: false,
      announcementMessageId: Number.MIN_SAFE_INTEGER,
      trackedMessageTimes: [Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
      invitedBy: Number.MIN_SAFE_INTEGER,
      reminderMessageId: Number.MIN_SAFE_INTEGER,
      replyReminderMessageId: Number.MIN_SAFE_INTEGER,
      replyReminderRequested: false,
      welcomeAnchorMessageId: Number.MIN_SAFE_INTEGER,
      reminderSuperseded: false,
      joinedAt: Number.MIN_SAFE_INTEGER,
      expiresAt: Number.MIN_SAFE_INTEGER,
    };
    const records: readonly VerificationSnapshot[] = [
      { ...base, phase: "pending" },
      { ...base, phase: "kickPending", requestedAt: Number.MIN_SAFE_INTEGER, countedJoinAt: Number.MIN_SAFE_INTEGER },
      { ...base, phase: "checkingInviter", terminalInviterId: Number.MIN_SAFE_INTEGER },
      {
        ...base,
        phase: "expelling",
        expelReason: "timeout",
        successNoticeSent: false,
        failureNoticeSent: false,
        unconfirmedNoticeSent: false,
        removalConfirmed: false,
      },
    ];
    for (const record of records) {
      const message: DiskIOOperationMessage = { type: "verificationUpsert", record, critical: false };
      expect(diskIOMessageCost(message)).toBeGreaterThanOrEqual(DISK_BUSINESS_MESSAGE_BASE_BYTES + serializedBytes(message) * 2);
    }
  });

  test("没有载荷的控制与请求消息只占基础字节", () => {
    expect(diskIOMessageCost(CASES.flush.message)).toBe(DISK_BUSINESS_MESSAGE_BASE_BYTES);
    expect(diskIOMessageCost(CASES.recoveryReplay.message)).toBe(DISK_BUSINESS_MESSAGE_BASE_BYTES);
  });

  test("stickerPacks 缺省的 load 仍计入时区载荷", () => {
    expect(diskIOMessageCost({ type: "load", timeZone: getTimeZone(), stickerPacks: null }))
      .toBe(DISK_BUSINESS_MESSAGE_BASE_BYTES + getTimeZone().length * 2);
  });

  test("只有业务事实进恢复 FIFO，诊断、读取与生命周期都不进", () => {
    const business: string[] = Object.entries(CASES)
      .filter(([, expectation]) => isDiskBusinessMessage(expectation.message))
      .map(([type]) => type)
      .sort();
    expect(business).toEqual([
      "aiMemory", "blocklistRemovals", "chatQaWrite", "chatStateWrite", "deleteAiMemory",
      "deleteJoinLog", "deleteWedMembers", "forgetAiMemory", "identityPolicyWrite", "joinLog",
      "luckDraw", "stickerCatalog", "temporaryAdBypassWrite", "verificationDelete",
      "verificationUpsert", "wedMembers",
    ]);
  });

  test("未知变体走穷尽性断言而不是静默按基础字节计价", () => {
    const unknown: DiskIOOperationMessage =
      { type: "somethingNew" } as unknown as DiskIOOperationMessage;
    expect(() => diskIOMessageCost(unknown)).toThrow(
      "Unsupported Disk I/O operation message type: somethingNew"
    );
  });
});
