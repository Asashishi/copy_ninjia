import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import {
  LOCKDOWN_KICK_DEDUPE_MS,
  VERIFICATION_REVISION_CAPACITY,
  VERIFICATION_RUNTIME_CAPACITY,
  VERIFICATION_TIMEOUT_MS,
} from "../../../packages/consts/antiRaid/verification";
import type { AntiRaidWorkerEvent } from "../../../packages/types/antiRaid/events";
import type { VerificationEntry } from "../../../packages/types/antiRaid/internal";
import type { PendingVerificationSnapshot, VerificationSnapshot } from "../../../packages/types/antiRaid/verification";
import type { JoinEvent, VerificationEffect } from "../../../packages/types/states/verification";
import type { RunVerificationEffectsParams } from "../../../packages/workers/antiRaid/verificationEffects";
import { exemptOf } from "../../../packages/states/verification/shared";
import { verificationKey } from "../../../packages/libs/verificationKey";

const workerEvents: AntiRaidWorkerEvent[] = [];
const effects: VerificationEffect[] = [];
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage(event: AntiRaidWorkerEvent): void { workerEvents.push(event); } },
});
mock.module("../../../packages/workers/antiRaid/verificationEffects", () => ({
  runVerificationEffects: async (params: RunVerificationEffectsParams): Promise<void> => {
    effects.push(...params.effects);
  },
}));
mock.module("../../../packages/workers/antiRaid/verificationReminders", () => ({
  cancelReminderDelivery(): void {},
  clearReminderDeliveries(): void {},
  ensurePendingReminder(): void {},
}));

const runtime = await import("../../../packages/workers/antiRaid/verificationRuntime");
const { handleJoinEvent } = await import("../../../packages/workers/antiRaid/verificationEvents");
const { admitVerificationJoin } = await import("../../../packages/workers/antiRaid/verificationAdmission");
const {
  verificationEntries,
  verificationGeneration,
  verificationRevisions,
  verificationRuntimeCapacityFatalState,
} = await import("../../../packages/cache/workers/antiRaid/verification");
const { joinWindows } = await import("../../../packages/cache/workers/antiRaid/lockdown");
const { stopLockdownRuntime } = await import("../../../packages/workers/antiRaid/lockdownRuntime");

const CHAT_ID: number = -1_001;
const ADOPT_GENERATION: number = 1;

function join(memberId: number, overrides: Partial<JoinEvent> = {}): JoinEvent {
  return {
    type: "join", memberId, label: "容量测试成员", isBot: false,
    identityExempt: true, actorSyncExempt: false, adminCacheFresh: true,
    lockdownActive: false, now: Date.now(), ...overrides,
  };
}

/** 按生产入口 handleJoinEvent 的顺序派发 join：先过 admitVerificationJoin，通过才交给 dispatcher。 */
function dispatchJoin(chatId: number, userId: number, event: JoinEvent): void {
  if (admitVerificationJoin(verificationKey(chatId, userId))) runtime.dispatchVerification(chatId, userId, event);
}

/** 其余槽只作容量夹具，不挂 timer；生命周期用例为被观察的条目使用真实 dispatcher。 */
function fillDedupes(size: number = VERIFICATION_RUNTIME_CAPACITY): void {
  for (let userId: number = 1; verificationEntries.size < size; userId++) {
    const key: string = verificationKey(CHAT_ID, userId);
    if (verificationEntries.has(key)) continue;
    const entry: VerificationEntry = {
      state: exemptOf("容量占位", false), timer: undefined, terminalRetries: 0,
    };
    verificationEntries.set(key, entry);
  }
}

function pendingRecord(userId: number, revision: number = 1): PendingVerificationSnapshot {
  return {
    chatId: CHAT_ID, userId, generation: ADOPT_GENERATION, revision,
    phase: "pending", label: "已有持久责任", isBot: false,
    trackedMessageTimes: [], replyReminderRequested: false, reminderSuperseded: false,
    reminderMessageId: 700, joinedAt: Date.now(), expiresAt: Date.now() + VERIFICATION_TIMEOUT_MS,
  };
}

beforeEach(() => {
  runtime.stopVerificationRuntime();
  stopLockdownRuntime();
  jest.useFakeTimers();
  verificationGeneration.current = ADOPT_GENERATION;
  workerEvents.length = 0;
  effects.length = 0;
});

afterEach(() => {
  runtime.stopVerificationRuntime();
  stopLockdownRuntime();
  jest.useRealTimers();
});

describe("验证运行态容量与去重生命周期", () => {
  test("不同豁免新 key 受运行态硬顶约束，满额重复投递不登记状态或重复欢迎", () => {
    for (let userId: number = 1; userId <= VERIFICATION_RUNTIME_CAPACITY; userId++) {
      dispatchJoin(CHAT_ID, userId, join(userId));
    }
    expect(verificationEntries.size).toBe(VERIFICATION_RUNTIME_CAPACITY);
    expect(verificationRevisions.size).toBe(0);
    expect(workerEvents).toEqual([]);
    const rejectedUserId: number = VERIFICATION_RUNTIME_CAPACITY + 1;
    for (let index: number = 0; index < 3; index++) {
      dispatchJoin(CHAT_ID, rejectedUserId, join(rejectedUserId, {
        recentComment: { messageId: 900 },
      }));
    }
    expect(verificationEntries.size).toBe(VERIFICATION_RUNTIME_CAPACITY);
    expect(verificationEntries.has(verificationKey(CHAT_ID, rejectedUserId))).toBeFalse();
    expect(effects).toEqual([]);
    expect(workerEvents).toEqual([{
      type: "verificationRuntimeCapacityExceeded", generation: ADOPT_GENERATION,
    }]);
    expect(verificationRuntimeCapacityFatalState.current).toBeTrue();
  });

  test("满额入群在刷群计数之前拒收，随后来路缺少豁免标记也不建立验证窗口", () => {
    fillDedupes();
    const userId: number = VERIFICATION_RUNTIME_CAPACITY + 1;
    for (const exempt of [true, false]) {
      handleJoinEvent({
        type: "join", chatId: CHAT_ID, member: { id: userId, first_name: "测试" }, exempt,
      }, runtime.dispatchVerification);
    }
    expect(joinWindows.size).toBe(0);
    expect(verificationEntries.size).toBe(VERIFICATION_RUNTIME_CAPACITY);
    expect(verificationRevisions.size).toBe(0);
    expect(effects).toEqual([]);
    expect(workerEvents).toEqual([{
      type: "verificationRuntimeCapacityExceeded", generation: ADOPT_GENERATION,
    }]);
  });

  test("已有无 revision 的去重 key 在两种容量满额时仍继续，重复不续期或重复欢迎", () => {
    const userId: number = 1;
    dispatchJoin(CHAT_ID, userId, join(userId, {
      identityExempt: false, recentComment: { messageId: 900 },
    }));
    expect(effects.map((effect: VerificationEffect): string => effect.kind)).toEqual(["sendWelcome"]);
    const original: VerificationEntry | undefined = verificationEntries.get(verificationKey(CHAT_ID, userId));
    const originalTimer: ReturnType<typeof setTimeout> | undefined = original?.timer;
    fillDedupes();
    for (let index: number = 0; index < VERIFICATION_REVISION_CAPACITY; index++) {
      verificationRevisions.set(`-2001:${index + 1}`, { revision: 1 });
    }
    jest.advanceTimersByTime(LOCKDOWN_KICK_DEDUPE_MS - 1);
    dispatchJoin(CHAT_ID, userId, join(userId, { identityExempt: false }));
    expect(verificationEntries.get(verificationKey(CHAT_ID, userId))).toBe(original);
    expect(original?.timer).toBe(originalTimer);
    expect(effects).toHaveLength(1);
    expect(workerEvents).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(verificationEntries.has(verificationKey(CHAT_ID, userId))).toBeFalse();
    expect(verificationEntries.size).toBe(VERIFICATION_RUNTIME_CAPACITY - 1);
  });

  test("TTL 到期释放运行态槽，未触发 fatal 时新 key 可以正常进入", () => {
    dispatchJoin(CHAT_ID, 1, join(1));
    fillDedupes();
    jest.advanceTimersByTime(LOCKDOWN_KICK_DEDUPE_MS);
    const userId: number = VERIFICATION_RUNTIME_CAPACITY + 1;
    dispatchJoin(CHAT_ID, userId, join(userId));
    expect(verificationEntries.size).toBe(VERIFICATION_RUNTIME_CAPACITY);
    expect(verificationEntries.get(verificationKey(CHAT_ID, userId))?.state.kind).toBe("exempt");
    expect(workerEvents).toEqual([]);
  });

  test("满额时已有 pending 可转豁免并清提醒、撤计数和发布 tombstone", () => {
    runtime.adoptVerifications({
      type: "adoptVerifications", generation: ADOPT_GENERATION, verifications: [pendingRecord(1)],
    });
    fillDedupes();
    dispatchJoin(CHAT_ID, 1, join(1));
    expect(verificationEntries.size).toBe(VERIFICATION_RUNTIME_CAPACITY);
    expect(verificationEntries.get(verificationKey(CHAT_ID, 1))?.state.kind).toBe("exempt");
    expect(effects.map((effect: VerificationEffect): string => effect.kind))
      .toEqual(["deleteReminders", "retractJoinCount"]);
    expect(workerEvents).toEqual([{
      type: "verificationDelete", chatId: CHAT_ID, userId: 1,
      generation: ADOPT_GENERATION, revision: 2,
    }]);
  });

  test("满额时已有终态仍可按精确 durable ACK 执行和结算", () => {
    const record: VerificationSnapshot = {
      ...pendingRecord(1), phase: "expelling", expelReason: "timeout",
    };
    runtime.adoptVerifications({
      type: "adoptVerifications", generation: ADOPT_GENERATION, verifications: [record],
    });
    fillDedupes();
    runtime.handleVerificationPersisted({
      type: "verificationPersisted", key: verificationKey(CHAT_ID, 1),
      generation: ADOPT_GENERATION, revision: record.revision,
    });
    expect(effects.map((effect: VerificationEffect): string => effect.kind)).toEqual(["expel"]);
    runtime.dispatchVerification(CHAT_ID, 1, { type: "expelSettled" });
    expect(verificationEntries.size).toBe(VERIFICATION_RUNTIME_CAPACITY - 1);
    expect(workerEvents.at(-1)?.type).toBe("verificationDelete");
  });

  test("已报告满额时本人验证仍可解除原 pending，成功欢迎只产生一次", () => {
    runtime.adoptVerifications({
      type: "adoptVerifications", generation: ADOPT_GENERATION, verifications: [pendingRecord(1)],
    });
    fillDedupes();
    dispatchJoin(CHAT_ID, VERIFICATION_RUNTIME_CAPACITY + 1,
      join(VERIFICATION_RUNTIME_CAPACITY + 1));
    for (let index: number = 0; index < 2; index++) {
      runtime.dispatchVerification(CHAT_ID, 1, {
        type: "callback", callbackQueryId: `self-${index}`, action: "self",
        isSelf: true, fromCanApprove: false, fromLabel: "本人",
      });
    }
    expect(verificationEntries.has(verificationKey(CHAT_ID, 1))).toBeFalse();
    expect(effects.filter((effect: VerificationEffect): boolean => effect.kind === "sendWelcome"))
      .toHaveLength(1);
    expect(effects.filter((effect: VerificationEffect): boolean => effect.kind === "deleteReminders"))
      .toHaveLength(1);
    expect(workerEvents.filter((event: AntiRaidWorkerEvent): boolean => event.type === "verificationDelete"))
      .toHaveLength(1);
    expect(verificationRuntimeCapacityFatalState.current).toBeTrue();
  });

  test("关闭和 teardown 清理本群去重，保留其它群并清除旧 timer", () => {
    for (const clear of [runtime.disableJoinGuardChat, runtime.deactivateVerificationChat]) {
      dispatchJoin(CHAT_ID, 1, join(1));
      dispatchJoin(CHAT_ID - 1, 1, join(1));
      clear(CHAT_ID);
      expect(verificationEntries.has(verificationKey(CHAT_ID, 1))).toBeFalse();
      expect(verificationEntries.has(verificationKey(CHAT_ID - 1, 1))).toBeTrue();
      expect(effects).toEqual([]);
      runtime.stopVerificationRuntime();
      verificationGeneration.current = ADOPT_GENERATION;
    }
    jest.advanceTimersByTime(LOCKDOWN_KICK_DEDUPE_MS);
    expect(verificationEntries.size).toBe(0);
    expect(workerEvents).toEqual([]);
  });

  test("新代 adopt 清理豁免洪峰及 fatal 闩锁，再完整接管持久责任", () => {
    fillDedupes();
    dispatchJoin(CHAT_ID, VERIFICATION_RUNTIME_CAPACITY + 1,
      join(VERIFICATION_RUNTIME_CAPACITY + 1));
    const generation: number = ADOPT_GENERATION + 1;
    const record: PendingVerificationSnapshot = { ...pendingRecord(1), generation };
    runtime.adoptVerifications({ type: "adoptVerifications", generation, verifications: [record] });
    expect(verificationEntries.size).toBe(1);
    expect(verificationEntries.get(verificationKey(CHAT_ID, 1))?.state.kind).toBe("pending");
    expect(verificationRevisions.size).toBe(1);
    expect(verificationRuntimeCapacityFatalState.current).toBeFalse();
    jest.advanceTimersByTime(LOCKDOWN_KICK_DEDUPE_MS);
    expect(verificationEntries.get(verificationKey(CHAT_ID, 1))?.state.kind).toBe("pending");
    runtime.stopVerificationRuntime();
    expect(verificationEntries.size).toBe(0);
    expect(verificationRuntimeCapacityFatalState.current).toBeFalse();
  });

  test("同代持久恢复优先腾出非持久槽，旧去重被释放后也不能再次发送副作用", () => {
    fillDedupes();
    const record: PendingVerificationSnapshot = pendingRecord(VERIFICATION_RUNTIME_CAPACITY + 1);
    runtime.adoptVerifications({
      type: "adoptVerifications", generation: ADOPT_GENERATION, verifications: [record],
    });
    expect(verificationEntries.size).toBe(VERIFICATION_RUNTIME_CAPACITY);
    expect(verificationEntries.get(verificationKey(CHAT_ID, record.userId))?.state.kind).toBe("pending");
    expect(verificationEntries.has(verificationKey(CHAT_ID, 1))).toBeFalse();
    dispatchJoin(CHAT_ID, 1, join(1, {
      identityExempt: false, recentComment: { messageId: 900 },
    }));
    runtime.dispatchVerification(CHAT_ID, record.userId, { type: "left" });
    dispatchJoin(CHAT_ID, 1, join(1, { identityExempt: false }));
    expect(verificationEntries.has(verificationKey(CHAT_ID, 1))).toBeFalse();
    expect(effects.map((effect: VerificationEffect): string => effect.kind)).toEqual(["deleteReminders"]);
    expect(workerEvents.filter((event: AntiRaidWorkerEvent): boolean => event.type === "verificationRuntimeCapacityExceeded"))
      .toHaveLength(1);
    expect(verificationRuntimeCapacityFatalState.current).toBeTrue();
  });

  test("恢复满额且全为持久阶段时保留原责任，不增加运行态或删除已有条目", () => {
    for (let userId: number = 1; userId <= VERIFICATION_RUNTIME_CAPACITY; userId++) {
      const record: PendingVerificationSnapshot = pendingRecord(userId);
      verificationEntries.set(verificationKey(CHAT_ID, userId), {
        state: {
          kind: "pending", label: record.label, isBot: false,
          announcementMessageId: undefined, trackedMessageTimes: [], invitedBy: undefined,
          reminderMessageId: record.reminderMessageId, replyReminderMessageId: undefined,
          replyReminderRequested: false, welcomeAnchorMessageId: undefined,
          reminderSuperseded: false, joinedAt: record.joinedAt, expiresAt: record.expiresAt,
        },
        timer: undefined, terminalRetries: 0,
      });
    }
    const first: VerificationEntry | undefined = verificationEntries.get(verificationKey(CHAT_ID, 1));
    const rejected: PendingVerificationSnapshot = pendingRecord(VERIFICATION_RUNTIME_CAPACITY + 1);
    runtime.adoptVerifications({
      type: "adoptVerifications", generation: ADOPT_GENERATION, verifications: [rejected],
    });
    expect(verificationEntries.size).toBe(VERIFICATION_RUNTIME_CAPACITY);
    expect(verificationEntries.get(verificationKey(CHAT_ID, 1))).toBe(first);
    expect(verificationEntries.has(verificationKey(CHAT_ID, rejected.userId))).toBeFalse();
    expect(verificationRevisions.has(verificationKey(CHAT_ID, rejected.userId))).toBeFalse();
    expect(workerEvents).toEqual([{
      type: "verificationRuntimeCapacityExceeded", generation: ADOPT_GENERATION,
    }]);
    expect(effects).toEqual([]);
  });
});
