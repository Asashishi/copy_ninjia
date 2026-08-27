import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VERIFICATION_FLUSH_INTERVAL_MS,
} from "../../../packages/consts/diskIO/verification";
import {
  resetVerificationPersistenceCache,
  verificationFileState,
  verificationFlushTimer,
  verificationPendingChanges,
  verificationRolloverTimer,
  verificationWorkerCache,
} from "../../../packages/cache/workers/diskIO/verification";
import {
  adoptVerificationDay,
  inspectVerificationDay,
  maintainVerificationDay,
} from "../../../packages/workers/diskIO/verificationRecovery";
import {
  handleVerificationUpsert,
  scheduleVerificationRollover,
} from "../../../packages/workers/diskIO/verificationWrites";
import type {
  PendingVerificationSnapshot,
  VerificationSnapshot,
  VerificationSnapshotBase,
} from "../../../packages/types/antiRaid/verification";
import type { VerificationPersistedReply } from
  "../../../packages/types/diskIO";

const DAY_ONE: string = "2026-07-19";
const DAY_TWO: string = "2026-07-20";
const DAY_ONE_START_MS: number = Date.parse("2026-07-19T00:00:00+09:00");
const BEFORE_DAY_TWO_MS: number = Date.parse("2026-07-19T23:59:59.900+09:00");

let dir: string;
let replies: VerificationPersistedReply[];

function snapshot(revision: number): PendingVerificationSnapshot {
  const base: VerificationSnapshotBase = {
    chatId: -1001,
    userId: 42,
    generation: 1,
    revision,
    label: "@pending_user",
    isBot: false,
    trackedMessageTimes: [1_000],
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: 1_000,
    expiresAt: 121_000,
  };
  return { ...base, phase: "pending" };
}

function receiveReply(reply: VerificationPersistedReply): void {
  replies.push(reply);
}

function upsert(revision: number, critical: boolean): void {
  handleVerificationUpsert({
    msg: {
      type: "verificationUpsert",
      record: snapshot(revision),
      critical,
    },
    reply: receiveReply,
    dir,
    day: DAY_ONE,
  });
}

function restartFixtureClock(now: number): void {
  resetVerificationPersistenceCache();
  jest.useRealTimers();
  jest.useFakeTimers({ now });
  recoverVerificationDay(DAY_ONE, dir);
}

/**
 * 单领域恢复的测试编排：按生产 handleDiskIOStartupLoad 的顺序跑
 * inspect -> adopt -> maintenance（见 workers/diskIO/startup.ts）。
 *
 * 生产没有这个包装。两点与生产不同，读断言时要记住：生产的 runMaintenance 对
 * 每个领域单独 try/catch 并只记一行 console.error，不上抛、也不重置本领域缓存；
 * 这里保留旧包装的「重置后上抛」，好让维护阶段的失败在用例里可断言。
 */
function recoverVerificationDay(
  day: string,
  dir: string
): Map<string, VerificationSnapshot> {
  const inspection = inspectVerificationDay(day, dir);
  const recovered = adoptVerificationDay(inspection);
  try {
    maintainVerificationDay(inspection);
  } catch (error: unknown) {
    resetVerificationPersistenceCache();
    throw error;
  }
  return recovered;
}

beforeEach((): void => {
  jest.useFakeTimers({ now: DAY_ONE_START_MS });
  dir = mkdtempSync(join(tmpdir(), "verification-timer-test-"));
  replies = [];
  resetVerificationPersistenceCache();
  recoverVerificationDay(DAY_ONE, dir);
});

afterEach((): void => {
  resetVerificationPersistenceCache();
  jest.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("pending verification 定时落盘与午夜轮换", (): void => {
  test("普通变化由唯一 unref timer 自动 flush 并精确 ACK", (): void => {
    upsert(1, false);
    const timer: ReturnType<typeof setTimeout> | null = verificationFlushTimer.timer;
    expect(timer).not.toBeNull();
    expect(timer?.hasRef()).toBeFalse();
    expect(verificationPendingChanges).toHaveLength(1);

    jest.advanceTimersByTime(VERIFICATION_FLUSH_INTERVAL_MS);

    expect(verificationFlushTimer.timer).toBeNull();
    expect(verificationPendingChanges).toHaveLength(0);
    expect(replies).toEqual([{
      type: "verificationPersisted",
      key: "-1001:42",
      generation: 1,
      revision: 1,
      deleted: false,
    }]);
    expect(JSON.parse(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8")))
      .toHaveProperty("-1001:42.revision", 1);
  });

  test("append 失败保留 pending、失效文件游标并自动重试", (): void => {
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "not-a-directory");

    upsert(1, true);

    expect(verificationPendingChanges).toHaveLength(1);
    expect(verificationFileState.current).toBeNull();
    expect(verificationFlushTimer.timer).not.toBeNull();
    expect(verificationFlushTimer.timer?.hasRef()).toBeFalse();
    expect(replies).toHaveLength(0);

    rmSync(dir, { force: true });
    mkdirSync(dir, { recursive: true });
    jest.advanceTimersByTime(VERIFICATION_FLUSH_INTERVAL_MS);

    expect(verificationPendingChanges).toHaveLength(0);
    expect(verificationFlushTimer.timer).toBeNull();
    expect(verificationFileState.current?.day).toBe(DAY_ONE);
    expect(replies).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8")))
      .toHaveProperty("-1001:42.revision", 1);
  });

  test("午夜 timer 先发布新日快照、清理旧日，再排下一次 unref 轮换", (): void => {
    restartFixtureClock(BEFORE_DAY_TWO_MS);
    upsert(1, false);
    scheduleVerificationRollover(receiveReply, dir);
    expect(verificationRolloverTimer.timer?.hasRef()).toBeFalse();

    jest.advanceTimersByTime(300);

    expect(existsSync(join(dir, `${DAY_ONE}.json`))).toBeFalse();
    expect(existsSync(join(dir, `${DAY_TWO}.json`))).toBeTrue();
    expect(verificationPendingChanges).toHaveLength(0);
    expect(verificationFlushTimer.timer).toBeNull();
    expect(verificationRolloverTimer.timer).not.toBeNull();
    expect(verificationRolloverTimer.timer?.hasRef()).toBeFalse();
    expect(replies.at(-1)).toMatchObject({ revision: 1, deleted: false });
  });

  test("午夜发布失败按一秒重试，active 镜像不丢失", (): void => {
    restartFixtureClock(BEFORE_DAY_TWO_MS);
    upsert(1, true);
    replies.length = 0;
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "not-a-directory");
    scheduleVerificationRollover(receiveReply, dir);

    jest.advanceTimersByTime(200);

    expect(verificationWorkerCache.get("-1001:42")?.revision).toBe(1);
    expect(verificationRolloverTimer.timer).not.toBeNull();
    expect(verificationRolloverTimer.timer?.hasRef()).toBeFalse();
    expect(replies).toHaveLength(0);

    rmSync(dir, { force: true });
    mkdirSync(dir, { recursive: true });
    jest.advanceTimersByTime(1_000);

    expect(existsSync(join(dir, `${DAY_TWO}.json`))).toBeTrue();
    expect(JSON.parse(readFileSync(join(dir, `${DAY_TWO}.json`), "utf8")))
      .toHaveProperty("-1001:42.revision", 1);
    expect(verificationRolloverTimer.timer).not.toBeNull();
    expect(verificationRolloverTimer.timer?.hasRef()).toBeFalse();
  });
});
