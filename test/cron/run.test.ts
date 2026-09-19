import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import type { CronAction, CronDeliveryOutcome, CronTask, CronTaskSchedule } from "../../packages/types/cron";

const delivered: string[] = [];
const outcomes: CronDeliveryOutcome[] = [];
const deliverCronAction = mock(async (
  _task: CronTask,
  action: CronAction,
  _signal: AbortSignal
): Promise<CronDeliveryOutcome> => {
  delivered.push(action.type === "send_message" ? action.content : action.type);
  return outcomes.shift() ?? { kind: "sent" };
});
const loggerError = mock((..._args: unknown[]): void => {});
mock.module("../../packages/cron/delivery", () => ({ deliverCronAction }));
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));

const { runCronRound } = await import("../../packages/cron/run");

function schedule(actions: readonly CronAction[]): CronTaskSchedule {
  return {
    task: {
      name: "daily",
      chatId: -1001,
      messageThreadId: undefined,
      cron: "* * * * *",
      timeZone: "Asia/Tokyo",
      randomInterval: undefined,
      justOnce: false,
      actions,
    },
    job: null,
    timer: null,
    cancelled: false,
  };
}

const MESSAGES: readonly CronAction[] = [
  { type: "send_message", content: "one" },
  { type: "send_message", content: "two" },
  { type: "send_message", content: "three" },
];

/** 推进假时钟直到本轮结算。 */
async function settle(round: Promise<void>, stepMs: number = 500): Promise<void> {
  let done: boolean = false;
  void round.then((): void => { done = true; });
  for (let index: number = 0; index < 200 && !done; index++) {
    jest.advanceTimersByTime(stepMs);
    for (let tick: number = 0; tick < 5; tick++) await Promise.resolve();
  }
  await round;
}

beforeEach(() => {
  delivered.length = 0;
  outcomes.length = 0;
  deliverCronAction.mockClear();
  loggerError.mockClear();
  jest.useFakeTimers({ now: 0 });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("cron 一轮", () => {
  test("按顺序投递，相邻动作间隔 1 秒", async () => {
    const round: Promise<void> = runCronRound(schedule(MESSAGES), new AbortController().signal);
    for (let tick: number = 0; tick < 5; tick++) await Promise.resolve();
    expect(delivered).toEqual(["one"]);
    jest.advanceTimersByTime(999);
    for (let tick: number = 0; tick < 5; tick++) await Promise.resolve();
    expect(delivered).toEqual(["one"]);
    await settle(round);
    expect(delivered).toEqual(["one", "two", "three"]);
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("可重试失败按 2s/4s/8s 退避，最多重试 3 次后中止剩余动作并记一条错误", async () => {
    for (let index: number = 0; index < 4; index++) outcomes.push({ kind: "retryable", detail: "502 Bad Gateway" });
    await settle(runCronRound(schedule(MESSAGES), new AbortController().signal));
    expect(delivered).toEqual(["one", "one", "one", "one"]);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0]![0]).toBe(
      "Cron task \"daily\" action #1 (send_message) failed after 4 attempt(s); " +
      "skipping the remaining actions of this run: 502 Bad Gateway"
    );
  });

  test("重试成功后继续后续动作", async () => {
    outcomes.push({ kind: "retryable", detail: "network" });
    await settle(runCronRound(schedule(MESSAGES), new AbortController().signal));
    expect(delivered).toEqual(["one", "one", "two", "three"]);
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("不可重试失败立即中止，不再重试", async () => {
    outcomes.push({ kind: "sent" }, { kind: "permanent", detail: "403 Forbidden: bot was kicked" });
    await settle(runCronRound(schedule(MESSAGES), new AbortController().signal));
    expect(delivered).toEqual(["one", "two"]);
    expect(loggerError.mock.calls[0]![0]).toContain("action #2 (send_message) failed after 1 attempt(s)");
  });

  test("调度被撤销时在下一个动作前停下，不记错误", async () => {
    const target: CronTaskSchedule = schedule(MESSAGES);
    deliverCronAction.mockImplementationOnce(async (): Promise<CronDeliveryOutcome> => {
      delivered.push("one");
      target.cancelled = true;
      return { kind: "sent" };
    });
    await settle(runCronRound(target, new AbortController().signal));
    expect(delivered).toEqual(["one"]);
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("停机取消打断退避等待，在途投递返回 aborted 时不记错误", async () => {
    const controller: AbortController = new AbortController();
    outcomes.push({ kind: "retryable", detail: "network" });
    const round: Promise<void> = runCronRound(schedule(MESSAGES), controller.signal);
    for (let tick: number = 0; tick < 5; tick++) await Promise.resolve();
    controller.abort();
    await round;
    expect(delivered).toEqual(["one"]);

    outcomes.push({ kind: "aborted" });
    await settle(runCronRound(schedule(MESSAGES), new AbortController().signal));
    expect(loggerError).not.toHaveBeenCalled();
  });
});
