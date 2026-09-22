/**
 * durable 投递与停机排空的失败语义：「Worker 压根没收到」必须以可判别的
 * WorkerUndeliveredError 报出，屏障与落盘失败则只能是普通错误；排空不收敛时
 * 按 failed 收场并记一条错误日志。
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { ANTI_RAID_DRAIN_MAX_ROUNDS } from "../../packages/consts/antiRaid/protocol";
import { WorkerUndeliveredError } from "../../packages/libs/workerDelivery";
import { loggerStub } from "../helpers/loggerMock";
import type { AntiRaidWorkerMessage } from "../../packages/types/antiRaid/protocol";
import type { FlushResult } from "../../packages/types/lifecycle";

const { antiRaidBarrier, antiRaidRuntimeState } =
  await import("../../packages/cache/main/antiRaid/proxy");

/** 每轮 flush 的结局；用例按需改写。 */
let diskResult: FlushResult | Error = "flushed";
let stateResult: FlushResult | Error = "flushed";
/** 每收到一条 drain 就推进一次持久化代数，模拟副作用又发布了新镜像。 */
let bumpPersistenceOnDrain: boolean = false;
/** postAntiRaid 的结局；false 代表「消息压根没进信箱」。 */
let deliverable: boolean = true;
/** 屏障回执；不是 flushed 时按「收到了但没落定」处理。 */
let barrierResult: FlushResult = "flushed";
const loggerErrors: unknown[][] = [];

const realDiskIO = await import("../../packages/infra/diskIO");
mock.module("../../packages/infra/diskIO", () => ({
  ...realDiskIO,
  flushDiskIO: async (): Promise<FlushResult> => {
    if (diskResult instanceof Error) throw diskResult;
    return diskResult;
  },
}));
const realStateStore = await import("../../packages/infra/storage/stateStore");
mock.module("../../packages/infra/storage/stateStore", () => ({
  ...realStateStore,
  flushStateToDisk: async (): Promise<FlushResult> => {
    if (stateResult instanceof Error) throw stateResult;
    return stateResult;
  },
}));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ error: (...args: unknown[]): void => { loggerErrors.push(args); } }),
}));
mock.module("../../packages/antiRaid/workerBridge/controller", () => ({
  postAntiRaid: (message: AntiRaidWorkerMessage): boolean => {
    if (!deliverable) return false;
    if (message.type === "drain") {
      if (bumpPersistenceOnDrain) antiRaidRuntimeState.persistenceVersion++;
      antiRaidBarrier.settle(message.drainId, barrierResult);
    }
    if (message.type === "barrier") antiRaidBarrier.settle(message.barrierId, barrierResult);
    return true;
  },
}));

const { drainAntiRaid, postAntiRaidDurably } =
  await import("../../packages/antiRaid/durableDelivery");

const NOTICE: AntiRaidWorkerMessage = { type: "clearAdDetect", chatId: -1_001 };

beforeEach((): void => {
  diskResult = "flushed";
  stateResult = "flushed";
  bumpPersistenceOnDrain = false;
  deliverable = true;
  barrierResult = "flushed";
  loggerErrors.length = 0;
  antiRaidRuntimeState.initialized = true;
  antiRaidRuntimeState.persistenceVersion = 0;
});

afterEach((): void => { antiRaidRuntimeState.initialized = false; });

test("投不进信箱时抛可判别的 WorkerUndeliveredError", async () => {
  deliverable = false;

  const error: unknown = await postAntiRaidDurably([NOTICE]).catch((thrown: unknown): unknown => thrown);

  expect(error).toBeInstanceOf(WorkerUndeliveredError);
  expect((error as Error).name).toBe("WorkerUndeliveredError");
});

test("屏障没落定时是普通错误，调用方据此知道 Worker 已经收下", async () => {
  barrierResult = "timedOut";

  const error: unknown = await postAntiRaidDurably([NOTICE]).catch((thrown: unknown): unknown => thrown);

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(WorkerUndeliveredError);
  expect((error as Error).message).toContain("timedOut");
});

test("落盘边界拒绝时聚合原因，同样不是投递失败", async () => {
  antiRaidRuntimeState.persistenceVersion = 0;
  diskResult = new Error("disk boom");
  const posted: Promise<number> = postAntiRaidDurably([NOTICE]);
  antiRaidRuntimeState.persistenceVersion = 1;

  const error: unknown = await posted.catch((thrown: unknown): unknown => thrown);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error).not.toBeInstanceOf(WorkerUndeliveredError);
  expect((error as AggregateError).errors.map((reason: unknown): string => String(reason)))
    .toEqual(["Error: disk boom"]);
});

test("排空在上限轮数内不收敛时按 failed 收场并记录", async () => {
  bumpPersistenceOnDrain = true;

  expect(await drainAntiRaid(60_000)).toBe("failed");
  expect(loggerErrors).toHaveLength(1);
  expect(String(loggerErrors[0]?.[0]))
    .toContain(`${ANTI_RAID_DRAIN_MAX_ROUNDS} persistence rounds`);
});

test("落盘领域报 failed 时排空原样上报，不当成收敛", async () => {
  diskResult = "failed";

  expect(await drainAntiRaid(60_000)).toBe("failed");
  expect(loggerErrors).toHaveLength(0);
});
