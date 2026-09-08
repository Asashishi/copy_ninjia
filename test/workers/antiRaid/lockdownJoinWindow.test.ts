import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  ANTI_RAID_PER_MINUTE_LIMIT,
  JOIN_WINDOW_CAPACITY,
  JOIN_WINDOW_MS,
  LOCKDOWN_RETRIGGER_COOLDOWN_MS,
} from "../../../packages/consts/antiRaid/lockdown";
import {
  joinWindows,
  lockdownRetriggerCooldowns,
} from "../../../packages/cache/workers/antiRaid/lockdown";
import {
  beginLockdownRetriggerCooldown,
  recordJoinWindow,
  retractJoinWindow,
  stopJoinWindowRuntime,
} from "../../../packages/workers/antiRaid/lockdownJoinWindow";
import { TimestampDeque } from "../../../packages/libs/timestampDeque";
import type { JoinWindow } from "../../../packages/types/antiRaid/internal";

const CHAT_ID: number = -1001;
const BASE_MS: number = Date.parse("2026-03-01T00:00:00Z");

afterEach((): void => {
  stopJoinWindowRuntime();
  jest.useRealTimers();
});

/** 冲满一整窗入群，返回最后一次的上报值。 */
function recordUpToThreshold(chatId: number, now: number): number | undefined {
  let last: number | undefined;
  for (let i: number = 0; i <= ANTI_RAID_PER_MINUTE_LIMIT; i++) {
    last = recordJoinWindow(chatId, now);
  }
  return last;
}

describe("入群滑窗静默清理 timer", () => {
  test("到点仍未静默则按剩余时间续排，真正静默后才释放窗口", (): void => {
    jest.useFakeTimers({ now: BASE_MS });
    recordJoinWindow(CHAT_ID, Date.now());
    const window: JoinWindow = joinWindows.get(CHAT_ID)!;

    // 首个 timer 到点之前又来一次入群：只推后 expiresAt，不新建 timer。
    jest.advanceTimersByTime(JOIN_WINDOW_MS / 2);
    recordJoinWindow(CHAT_ID, Date.now());
    expect(joinWindows.get(CHAT_ID)).toBe(window);

    // 首个 timer 到点：距离静默还差半个窗口，续排而不是删除。
    jest.advanceTimersByTime(JOIN_WINDOW_MS / 2);
    expect(joinWindows.get(CHAT_ID)).toBe(window);
    expect(window.resetTimeout).toBeDefined();

    // 续排的 timer 到点时确实已经静默满一个窗口：窗口连同 timer 一起释放。
    jest.advanceTimersByTime(JOIN_WINDOW_MS / 2);
    expect(joinWindows.has(CHAT_ID)).toBeFalse();
    expect(window.resetTimeout).toBeUndefined();
  });

  test("窗口已被换掉时旧 timer 原样退出，不误删新窗口", (): void => {
    jest.useFakeTimers({ now: BASE_MS });
    recordJoinWindow(CHAT_ID, Date.now());
    const stale: JoinWindow = joinWindows.get(CHAT_ID)!;

    // 直接换掉表里的条目（不走 clearJoinWindow，因此旧 timer 仍挂着）：
    // 这正是回调首行那道 identity 判据要挡的情形。
    const replacement: JoinWindow = {
      timestamps: new TimestampDeque(JOIN_WINDOW_CAPACITY, JOIN_WINDOW_CAPACITY),
      overflowThrough: undefined,
      expiresAt: Date.now() + JOIN_WINDOW_MS * 10,
      resetTimeout: undefined,
    };
    joinWindows.set(CHAT_ID, replacement);

    jest.advanceTimersByTime(JOIN_WINDOW_MS);
    expect(joinWindows.get(CHAT_ID)).toBe(replacement);
    // 旧窗口的 timer 已经跑完并退出，没有把 resetTimeout 清成 undefined。
    expect(stale.resetTimeout).toBeDefined();
  });
});

describe("重触发冷却", () => {
  test("冷却期内不再上报越阈，到期后就地删除条目并恢复计数", (): void => {
    jest.useFakeTimers({ now: BASE_MS });
    expect(recordUpToThreshold(CHAT_ID, Date.now())).toBeGreaterThan(
      ANTI_RAID_PER_MINUTE_LIMIT
    );

    beginLockdownRetriggerCooldown(
      CHAT_ID,
      "commitPreparationFailed",
      LOCKDOWN_RETRIGGER_COOLDOWN_MS
    );
    // 冷却写入时立即释放窗口，计数从零开始。
    expect(joinWindows.has(CHAT_ID)).toBeFalse();
    expect(lockdownRetriggerCooldowns.has(CHAT_ID)).toBeTrue();

    // 冷却期内：即便再冲满一整窗也不上报，也不建立窗口。
    jest.advanceTimersByTime(LOCKDOWN_RETRIGGER_COOLDOWN_MS - 1);
    expect(recordUpToThreshold(CHAT_ID, Date.now())).toBeUndefined();
    expect(joinWindows.has(CHAT_ID)).toBeFalse();

    // 冷却到期：第一次 recordJoinWindow 就地摘掉条目并重新开始计数。
    jest.advanceTimersByTime(1);
    expect(recordJoinWindow(CHAT_ID, Date.now())).toBeUndefined();
    expect(lockdownRetriggerCooldowns.has(CHAT_ID)).toBeFalse();
    expect(joinWindows.has(CHAT_ID)).toBeTrue();
  });

  test("写入新冷却时顺带扫掉其它群已过期的冷却", (): void => {
    jest.useFakeTimers({ now: BASE_MS });
    const staleChatId: number = -2002;
    beginLockdownRetriggerCooldown(staleChatId, "commitPreparationFailed", 1_000);
    expect(lockdownRetriggerCooldowns.has(staleChatId)).toBeTrue();

    // 另一个群在 stale 条目过期之后才写冷却：那条过期项被顺带删掉，
    // 不必等它自己那一群的下一次入群。
    jest.advanceTimersByTime(1_000);
    beginLockdownRetriggerCooldown(CHAT_ID, "persistFailed", LOCKDOWN_RETRIGGER_COOLDOWN_MS);
    expect(lockdownRetriggerCooldowns.has(staleChatId)).toBeFalse();
    expect(lockdownRetriggerCooldowns.has(CHAT_ID)).toBeTrue();
  });
});

describe("撤销与停机", () => {
  test("按加入时刻撤销一次计数；没有窗口的群静默返回", (): void => {
    expect(recordJoinWindow(CHAT_ID, BASE_MS)).toBeUndefined();
    expect(joinWindows.get(CHAT_ID)!.timestamps.size).toBe(1);

    retractJoinWindow(CHAT_ID, BASE_MS);
    expect(joinWindows.get(CHAT_ID)!.timestamps.size).toBe(0);

    expect((): void => retractJoinWindow(-9999, BASE_MS)).not.toThrow();
  });

  test("Worker 停止释放全部窗口 timer、窗口与冷却", (): void => {
    jest.useFakeTimers({ now: BASE_MS });
    recordJoinWindow(CHAT_ID, Date.now());
    recordJoinWindow(-2003, Date.now());
    beginLockdownRetriggerCooldown(-2004, "persistFailed", LOCKDOWN_RETRIGGER_COOLDOWN_MS);
    const first: JoinWindow = joinWindows.get(CHAT_ID)!;
    expect(joinWindows.size).toBe(2);
    expect(lockdownRetriggerCooldowns.size).toBe(1);

    stopJoinWindowRuntime();

    expect(joinWindows.size).toBe(0);
    expect(lockdownRetriggerCooldowns.size).toBe(0);
    // 已释放的 timer 不得再回调，空表也不会被重新写入。
    jest.advanceTimersByTime(JOIN_WINDOW_MS * 3);
    expect(joinWindows.size).toBe(0);
    expect(first.resetTimeout).toBeDefined();
  });
});
