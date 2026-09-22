import { diskIOStub } from "../helpers/diskIOMock";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { VerificationSnapshot } from "../../packages/types/antiRaid";
import type { DiskBusinessMessage } from "../../packages/types/diskIO";

const diskPosts: DiskBusinessMessage[] = [];

mock.module("../../packages/infra/diskIO", () => (diskIOStub({
  postDiskIO: (message: DiskBusinessMessage): boolean => {
    diskPosts.push(message);
    return true;
  },
})));

const {
  acceptVerificationDelete,
  acceptVerificationUpsert,
  advanceActiveVerificationGeneration,
  recordVerificationPersisted,
  replaceActiveVerificationMirror,
  settleVerificationDeletePersisted,
} = await import("../../packages/antiRaid/verificationMirror");
const {
  acceptVerificationDeferred,
  resetVerificationAttemptRuntime,
  settlePersistedVerificationDeferral,
} = await import("../../packages/antiRaid/verificationAttempts");
const { assertVerificationMirrorInvariants } = await import("../helpers/verificationMirrorInvariants");
const { antiRaidRuntimeState } = await import("../../packages/cache/main/antiRaid/proxy");
const {
  activeVerificationSnapshots,
  deferredVerificationRecords,
  pendingVerificationDeferrals,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
  verificationCapacityFatalState,
} =
  await import("../../packages/cache/main/antiRaid/verificationMirror");
const { businessWorkerFatalHandler } = await import(
  "../../packages/cache/main/workerSupervisor"
);
const { VERIFICATION_RECORD_CAPACITY } = await import(
  "../../packages/consts/antiRaid/verification"
);

const KEY: string = "-1001:42";
const fatalErrors: Error[] = [];

function record(generation: number, revision: number): VerificationSnapshot {
  return {
    chatId: -1001,
    userId: 42,
    generation,
    revision,
    phase: "pending",
    label: "待验证成员",
    isBot: false,
    trackedMessageTimes: [],
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: 1_000,
    expiresAt: 121_000,
  };
}

beforeEach(() => {
  diskPosts.length = 0;
  activeVerificationSnapshots.clear();
  deferredVerificationRecords.clear();
  pendingVerificationDeferrals.clear();
  pendingVerificationDeletes.clear();
  persistedVerificationRevisions.clear();
  verificationCapacityFatalState.current = false;
  fatalErrors.length = 0;
  businessWorkerFatalHandler.current = (error: Error): void => {
    fatalErrors.push(error);
  };
  antiRaidRuntimeState.generation = 1;
});

describe("antiRaid/verificationMirror 的 revision 水位线", () => {
  test("同代际内仍然按 revision 拒绝迟到的 upsert 与 delete", () => {
    expect(acceptVerificationUpsert({ type: "verificationUpsert", record: record(1, 5) })).toBeTrue();
    expect(acceptVerificationUpsert({ type: "verificationUpsert", record: record(1, 4) })).toBeFalse();
    expect(acceptVerificationUpsert({ type: "verificationUpsert", record: record(1, 5) })).toBeFalse();
    expect(acceptVerificationDelete({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 5 })).toBeFalse();
    expect(acceptVerificationDelete({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 6 })).toBeTrue();
    // 墓碑仍是同代际水位线，重复的旧删除不得再次投递。
    expect(acceptVerificationDelete({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 6 })).toBeFalse();
  });

  test("非当前代际的事件一律拒绝", () => {
    expect(acceptVerificationUpsert({ type: "verificationUpsert", record: record(0, 99) })).toBeFalse();
    expect(acceptVerificationDelete({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 0, revision: 99 })).toBeFalse();
    expect(diskPosts).toEqual([]);
  });

  test("回归：旧代际未确认墓碑不得压住新代际的 revision 1", () => {
    // 第一代爬到 revision 13，终态用 14 删除，磁盘回执还没回来。
    for (let revision: number = 1; revision <= 13; revision++) {
      expect(acceptVerificationUpsert({ type: "verificationUpsert", record: record(1, revision) })).toBeTrue();
    }
    expect(acceptVerificationDelete({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 14 })).toBeTrue();
    expect(pendingVerificationDeletes.get(KEY)?.revision).toBe(14);

    // antiRaid Worker 崩溃重建：主线程提升代际。已删除的 key 不在 adopt 范围内，
    // Worker 侧没有它的 revision，同一用户重新入群从 revision 1 起算。
    antiRaidRuntimeState.generation = 2;
    diskPosts.length = 0;

    expect(acceptVerificationUpsert({ type: "verificationUpsert", record: record(2, 1) })).toBeTrue();
    expect(activeVerificationSnapshots.get(KEY)?.revision).toBe(1);
    expect(activeVerificationSnapshots.get(KEY)?.generation).toBe(2);
    // 新记录必须真的发去落盘：判成过期的话它永远不落盘、terminalPersisted 也
    // 永远不投递，kickPending/expelling 就此卡住。
    expect(diskPosts).toEqual([{
      type: "verificationUpsert",
      record: record(2, 1),
      critical: true,
    }]);
    // 接管成功后旧墓碑随之清掉，不再影响后续判定。
    expect(pendingVerificationDeletes.has(KEY)).toBeFalse();
  });

  test("回归：旧代际墓碑也不得压住新代际的删除", () => {
    expect(acceptVerificationUpsert({ type: "verificationUpsert", record: record(1, 7) })).toBeTrue();
    expect(acceptVerificationDelete({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 8 })).toBeTrue();

    antiRaidRuntimeState.generation = 2;
    expect(acceptVerificationUpsert({ type: "verificationUpsert", record: record(2, 1) })).toBeTrue();
    expect(acceptVerificationDelete({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 2, revision: 2 })).toBeTrue();
    expect(pendingVerificationDeletes.get(KEY)).toMatchObject({ generation: 2, revision: 2 });
  });

  test("记录达到硬顶时允许更新旧 key，但新 key 只触发一次 fail-closed fatal", () => {
    activeVerificationSnapshots.set(KEY, record(1, 1));
    for (
      let index: number = 1;
      index < VERIFICATION_RECORD_CAPACITY;
      index++
    ) {
      activeVerificationSnapshots.set(`-2000:${index}`, record(1, 1));
    }

    expect(acceptVerificationUpsert({
      type: "verificationUpsert",
      record: record(1, 2),
    })).toBeTrue();
    expect(fatalErrors).toHaveLength(0);

    const firstNew: VerificationSnapshot = {
      ...record(1, 1),
      userId: 50_001,
    };
    const secondNew: VerificationSnapshot = {
      ...record(1, 1),
      userId: 50_002,
    };
    expect(acceptVerificationUpsert({ type: "verificationUpsert", record: firstNew }))
      .toBeFalse();
    expect(acceptVerificationUpsert({ type: "verificationUpsert", record: secondNew }))
      .toBeFalse();
    expect(activeVerificationSnapshots.size).toBe(VERIFICATION_RECORD_CAPACITY);
    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]?.message).toContain("record capacity");
  });
});

describe("主线程验证镜像的具名写入口与五表不变量", () => {
  function terminal(generation: number, revision: number): VerificationSnapshot {
    return { ...record(generation, revision), phase: "checkingInviter", terminalInviterId: 7 } as VerificationSnapshot;
  }

  test("一条记录从活动、落盘、延后到墓碑结算的全程，每一步都满足不变量", () => {
    resetVerificationAttemptRuntime();
    const step = (): void => assertVerificationMirrorInvariants();

    expect(acceptVerificationUpsert({ type: "verificationUpsert", record: record(1, 1) })).toBeTrue();
    step();
    // 迟到或不匹配的落盘回执不改镜像。
    expect(recordVerificationPersisted(KEY, 1, 2)).toBeFalse();
    expect(recordVerificationPersisted(KEY, 1, 1)).toBeTrue();
    expect(persistedVerificationRevisions.get(KEY)).toEqual({ generation: 1, revision: 1 });
    step();

    expect(acceptVerificationUpsert({ type: "verificationUpsert", record: terminal(1, 2) })).toBeTrue();
    step();
    // 最新 revision 尚未落盘：延后请求挂在活动快照上等回执。
    expect(acceptVerificationDeferred({
      type: "verificationDeferred",
      record: { chatId: -1001, userId: 42, generation: 1, revision: 2 },
    })).toBeTrue();
    expect(pendingVerificationDeferrals.has(KEY)).toBeTrue();
    step();

    expect(recordVerificationPersisted(KEY, 1, 2)).toBeTrue();
    expect(settlePersistedVerificationDeferral(KEY, 1, 2)).toBeTrue();
    expect(activeVerificationSnapshots.has(KEY)).toBeFalse();
    expect(deferredVerificationRecords.has(KEY)).toBeTrue();
    step();

    expect(acceptVerificationDelete({
      type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 3,
    })).toBeTrue();
    expect(pendingVerificationDeletes.get(KEY)).toMatchObject({ generation: 1, revision: 3 });
    step();
    // 不匹配的删除回执保留墓碑，精确回执才移出。
    settleVerificationDeletePersisted(KEY, 1, 2);
    expect(pendingVerificationDeletes.has(KEY)).toBeTrue();
    settleVerificationDeletePersisted(KEY, 1, 3);
    expect(pendingVerificationDeletes.has(KEY)).toBeFalse();
    step();
  });

  test("代际提升只带走已精确落盘的水位线，hydrate 整体替换并以快照自身为水位", () => {
    expect(acceptVerificationUpsert({ type: "verificationUpsert", record: record(1, 1) })).toBeTrue();
    expect(recordVerificationPersisted(KEY, 1, 1)).toBeTrue();
    const other: VerificationSnapshot = { ...record(1, 1), userId: 43 };
    expect(acceptVerificationUpsert({ type: "verificationUpsert", record: other })).toBeTrue();

    advanceActiveVerificationGeneration(2);
    expect(activeVerificationSnapshots.get(KEY)?.generation).toBe(2);
    expect(persistedVerificationRevisions.get(KEY)).toEqual({ generation: 2, revision: 1 });
    expect(persistedVerificationRevisions.has("-1001:43")).toBeFalse();
    assertVerificationMirrorInvariants();

    pendingVerificationDeletes.set("-1001:44", { chatId: -1001, userId: 44, generation: 1, revision: 5 });
    replaceActiveVerificationMirror(new Map([["-1001:45", { ...record(3, 4), userId: 45 }]]));
    expect([...activeVerificationSnapshots.keys()]).toEqual(["-1001:45"]);
    expect(pendingVerificationDeletes.size).toBe(0);
    expect(persistedVerificationRevisions.get("-1001:45")).toEqual({ generation: 3, revision: 4 });
    assertVerificationMirrorInvariants();
  });

  test("不变量断言本身能拦住违例：同一 key 同时处在活动与墓碑", () => {
    activeVerificationSnapshots.set(KEY, record(1, 1));
    pendingVerificationDeletes.set(KEY, { chatId: -1001, userId: 42, generation: 1, revision: 2 });
    expect(assertVerificationMirrorInvariants).toThrow(`${KEY}: active and pending delete`);
  });
});
