import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import type { CronAction, CronDeliveryOutcome, CronGroupTargets, CronTaskSchedule } from "../../packages/types/cron";

const delivered: string[] = [];
const destinations: number[] = [];
const outcomes: CronDeliveryOutcome[] = [];
const deliverCronAction = mock(async (
  chatId: number,
  action: CronAction,
  _signal: AbortSignal
): Promise<CronDeliveryOutcome> => {
  destinations.push(chatId);
  delivered.push(action.type === "send_message" ? action.content : action.type);
  return outcomes.shift() ?? { kind: "sent" };
});
let groupTargets: CronGroupTargets = { chatIds: [], skipped: 0 };
const resolveCronGroupTargets = mock(async (): Promise<CronGroupTargets> => groupTargets);
const loggerError = mock((..._args: unknown[]): void => {});
const loggerLog = mock((..._args: unknown[]): void => {});
mock.module("../../packages/cron/delivery", () => ({ deliverCronAction }));
mock.module("../../packages/cron/targets", () => ({ resolveCronGroupTargets }));
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError, log: loggerLog }) }));

const { runCronRound } = await import("../../packages/cron/run");

function schedule(actions: readonly CronAction[], chatId: number | "all" = -1001): CronTaskSchedule {
  return {
    task: {
      name: "daily",
      chatId,
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
  destinations.length = 0;
  outcomes.length = 0;
  groupTargets = { chatIds: [], skipped: 0 };
  deliverCronAction.mockClear();
  resolveCronGroupTargets.mockClear();
  loggerError.mockClear();
  loggerLog.mockClear();
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

  test("单个会话的任务不解析群列表，按配置的会话投递", async () => {
    await settle(runCronRound(schedule(MESSAGES), new AbortController().signal));
    expect(resolveCronGroupTargets).not.toHaveBeenCalled();
    expect(destinations).toEqual([-1001, -1001, -1001]);
  });
});

describe("chat_id: \"all\" 的一轮", () => {
  const TWO: readonly CronAction[] = [
    { type: "send_message", content: "one" },
    { type: "send_message", content: "two" },
  ];

  test("按目标群顺序逐群跑完整套动作，群与群之间同样间隔 1 秒", async () => {
    groupTargets = { chatIds: [-2, -1], skipped: 0 };
    const round: Promise<void> = runCronRound(schedule(TWO, "all"), new AbortController().signal);
    for (let tick: number = 0; tick < 10; tick++) await Promise.resolve();
    expect(delivered).toEqual(["one"]);
    await settle(round);
    expect(destinations).toEqual([-2, -2, -1, -1]);
    expect(delivered).toEqual(["one", "two", "one", "two"]);
    expect(loggerLog).not.toHaveBeenCalled();
  });

  test("一个群失败只中止该群剩余动作并写明群 id，随后继续下一个群；跳过的群记一行", async () => {
    groupTargets = { chatIds: [-2, -1], skipped: 3 };
    outcomes.push({ kind: "permanent", detail: "400 Bad Request: not enough rights" });
    await settle(runCronRound(schedule(TWO, "all"), new AbortController().signal));
    expect(destinations).toEqual([-2, -1, -1]);
    expect(loggerError.mock.calls[0]![0]).toBe(
      "Cron task \"daily\" action #1 (send_message) failed in chat -2 after 1 attempt(s); " +
      "skipping the remaining actions for this chat: 400 Bad Request: not enough rights"
    );
    expect(loggerLog).toHaveBeenCalledWith("Cron task \"daily\" skipped 3 chat(s) without send permission.");
  });

  test("调度被撤销后不再进入下一个群", async () => {
    groupTargets = { chatIds: [-2, -1], skipped: 0 };
    const target: CronTaskSchedule = schedule([{ type: "send_message", content: "one" }], "all");
    deliverCronAction.mockImplementationOnce(async (chatId: number): Promise<CronDeliveryOutcome> => {
      destinations.push(chatId);
      target.cancelled = true;
      return { kind: "sent" };
    });
    await settle(runCronRound(target, new AbortController().signal));
    expect(destinations).toEqual([-2]);
  });
});
