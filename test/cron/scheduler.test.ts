import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import type { CronRuntime, CronTask, CronTaskSchedule } from "../../packages/types/cron";

const rounds: string[] = [];
let pendingRound: Promise<void> | null = null;
const runCronRound = mock(async (schedule: CronTaskSchedule, _signal: AbortSignal): Promise<void> => {
  rounds.push(schedule.task.name);
  if (pendingRound !== null) await pendingRound;
});
mock.module("../../packages/cron/run", () => ({ runCronRound }));

const {
  drainCronScheduler,
  quiesceCronScheduler,
  reconcileCronSchedule,
  startCronScheduler,
} = await import("../../packages/cron/scheduler");
const { cronConfigCache, cronRuntime } = await import("../../packages/cache/main/cron");

/** 东京时间 09:00 前一秒。 */
const START_MS: number = Date.parse("2026-09-20T08:59:59+09:00");
const MINUTE_MS: number = 60_000;

function task(overrides: Partial<CronTask> = {}): CronTask {
  return {
    name: "daily",
    chatId: -1001,
    messageThreadId: undefined,
    cron: "* * * * *",
    timeZone: "Asia/Tokyo",
    randomInterval: undefined,
    justOnce: false,
    actions: [{ type: "send_message", content: "hi" }],
    ...overrides,
  };
}

function runtime(): CronRuntime {
  if (cronRuntime.current === null) throw new Error("scheduler not started");
  return cronRuntime.current;
}

/** 推进假时钟并让 cron handler 的 Promise 链走完。 */
async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  for (let index: number = 0; index < 10; index++) await Promise.resolve();
}

beforeEach(() => {
  rounds.length = 0;
  pendingRound = null;
  runCronRound.mockClear();
  jest.useFakeTimers({ now: START_MS });
  cronRuntime.current = null;
  cronConfigCache.current = null;
});

afterEach(async () => {
  await drainCronScheduler(0);
  jest.useRealTimers();
});

describe("cron 调度", () => {
  test("缺省任务表不登记任何调度", () => {
    startCronScheduler();
    expect(runtime().schedules.size).toBe(0);
  });

  test("普通任务按表达式在任务时区里每次触发", async () => {
    cronConfigCache.current = [task()];
    startCronScheduler();
    await advance(1_050);
    expect(rounds).toEqual(["daily"]);
    await advance(MINUTE_MS);
    await advance(MINUTE_MS);
    expect(rounds).toEqual(["daily", "daily", "daily"]);
  });

  test("just_once 触发一次即停，登记执行记录；原样对账或改其它字段都不再执行", async () => {
    cronConfigCache.current = [task({ justOnce: true })];
    startCronScheduler();
    await advance(1_050);
    await advance(MINUTE_MS * 3);
    expect(rounds).toEqual(["daily"]);
    expect(runtime().justOnceRecords.has("daily")).toBe(true);

    reconcileCronSchedule();
    cronConfigCache.current = [task({ justOnce: true, cron: "*/2 * * * *" })];
    reconcileCronSchedule();
    await advance(MINUTE_MS * 4);
    expect(rounds).toEqual(["daily"]);
  });

  test("just_once 改为 false 清除记录并转为周期任务；删除后同名加回仍算已执行", async () => {
    cronConfigCache.current = [task({ justOnce: true })];
    startCronScheduler();
    await advance(1_050);
    cronConfigCache.current = [];
    reconcileCronSchedule();
    cronConfigCache.current = [task({ justOnce: true })];
    reconcileCronSchedule();
    await advance(MINUTE_MS * 2);
    expect(rounds).toEqual(["daily"]);

    cronConfigCache.current = [task({ justOnce: false })];
    reconcileCronSchedule();
    expect(runtime().justOnceRecords.has("daily")).toBe(false);
    await advance(MINUTE_MS);
    expect(rounds).toEqual(["daily", "daily"]);

    cronConfigCache.current = [task({ justOnce: true })];
    reconcileCronSchedule();
    await advance(MINUTE_MS);
    await advance(MINUTE_MS);
    expect(rounds).toEqual(["daily", "daily", "daily"]);
  });

  test("rand_cron 首次按 cron 触发，之后在区间内按随机等待循环", async () => {
    const random = spyOn(Math, "random").mockReturnValue(0.5);
    try {
      cronConfigCache.current = [task({ cron: "0 9 * * *", randomInterval: { minMs: MINUTE_MS, maxMs: 3 * MINUTE_MS } })];
      startCronScheduler();
      await advance(1_050);
      expect(rounds).toEqual(["daily"]);
      const schedule: CronTaskSchedule = runtime().schedules.get("daily")!;
      expect(schedule.job).toBeNull();
      expect(schedule.timer).not.toBeNull();

      // 0.5 落在 [1m, 3m] 的正中：第一轮在 09:00:00 结束，2 分钟后第二轮。
      // 此刻假时钟停在 09:00:00.050。
      await advance(2 * MINUTE_MS - 60);
      expect(rounds).toHaveLength(1);
      await advance(20);
      expect(rounds).toHaveLength(2);
    } finally {
      random.mockRestore();
    }
  });

  test("原样对账保留句柄；变更或删除的任务撤销，在途一轮据此停下", async () => {
    cronConfigCache.current = [task(), task({ name: "other" })];
    startCronScheduler();
    const kept: CronTaskSchedule = runtime().schedules.get("daily")!;
    const changed: CronTaskSchedule = runtime().schedules.get("other")!;

    cronConfigCache.current = [task(), task({ name: "other", chatId: -2002 })];
    reconcileCronSchedule();
    expect(runtime().schedules.get("daily")).toBe(kept);
    expect(changed.cancelled).toBe(true);
    expect(runtime().schedules.get("other")).not.toBe(changed);

    cronConfigCache.current = [task({ name: "other", chatId: -2002 })];
    reconcileCronSchedule();
    expect(kept.cancelled).toBe(true);
    expect([...runtime().schedules.keys()]).toEqual(["other"]);
  });

  test("停机先停止触发，再在预算内等在途轮次；超时取消", async () => {
    let finish!: () => void;
    pendingRound = new Promise<void>((resolve: () => void): void => {
      finish = resolve;
    });
    cronConfigCache.current = [task()];
    startCronScheduler();
    await advance(1_050);
    expect(runtime().runs.size).toBe(1);

    quiesceCronScheduler();
    await advance(MINUTE_MS * 2);
    expect(rounds).toEqual(["daily"]);
    reconcileCronSchedule();
    expect(runtime().schedules.get("daily")!.cancelled).toBe(true);

    expect(await drainCronScheduler(0)).toBe("timedOut");
    expect(runtime().controller.signal.aborted).toBe(true);
    finish();
    pendingRound = null;
  });
});
