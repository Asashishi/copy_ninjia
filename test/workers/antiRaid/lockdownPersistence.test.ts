import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { lockdownEntries } from "../../../packages/cache/workers/antiRaid/lockdown";
import { publishLockdownState } from "../../../packages/workers/antiRaid/lockdownPersistence";
import type { LockdownEntry } from "../../../packages/types/antiRaid/internal";
import type { LockdownState } from "../../../packages/types/states/lockdown";

const CHAT_ID: number = -1001;
const posted: unknown[] = [];

function entry(state: LockdownState, restoreAt: number | undefined): LockdownEntry {
  return { state, restoreTimer: undefined, retryTimer: undefined, restoreAt };
}

const ACTIVE: LockdownState = {
  kind: "active",
  originalPermissions: { can_invite_users: true },
  intentId: 3,
  announced: true,
  announcementPending: false,
  announcementMessageId: 55,
};

beforeEach((): void => {
  posted.length = 0;
  lockdownEntries.clear();
  // 落盘投影走 `self.postMessage`；测试线程没有 Worker 通道，替掉即可。
  spyOn(globalThis, "postMessage").mockImplementation((message: unknown): void => { posted.push(message); });
});

afterEach((): void => {
  lockdownEntries.clear();
  jest.restoreAllMocks();
});

test("ACTIVE 以恢复截止作为落盘的到期时刻，并带上公告记账", (): void => {
  lockdownEntries.set(CHAT_ID, entry(ACTIVE, 9_000));

  publishLockdownState(CHAT_ID);

  expect(posted).toEqual([expect.objectContaining({
    type: "lockdown",
    chatId: CHAT_ID,
    phase: "active",
    intentId: 3,
    announced: true,
    announcementMessageId: 55,
    expiresAt: 9_000,
  })]);
});

test("ACTIVE 缺恢复截止是状态机不变量被破坏：直接抛错，不落一份没有到期时刻的记录", (): void => {
  lockdownEntries.set(CHAT_ID, entry(ACTIVE, undefined));

  expect(() => publishLockdownState(CHAT_ID)).toThrow("missing its restore deadline");
  expect(posted).toEqual([]);
});

test("尚未准备好的 APPLYING 与不存在的条目都不落盘", (): void => {
  lockdownEntries.set(CHAT_ID, entry({
    kind: "applying",
    stage: "preparing",
    announced: false,
    announcementPending: false,
    announcementMessageId: undefined,
  } as LockdownState, undefined));

  publishLockdownState(CHAT_ID);
  publishLockdownState(-2002);

  expect(posted).toEqual([]);
});
