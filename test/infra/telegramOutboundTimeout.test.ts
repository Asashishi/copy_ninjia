/**
 * 主线程出站总闸交给调用方的取消形状：调用方超时预算耗尽给 TimeoutError，调用方主动取消与
 * 停机撤销给 AbortError（infra/telegram/outboundSettle.ts 的 jobAbortReason）；真实 429 开始
 * 一段退避等待时记一条 warn。
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { RawApi, Transformer } from "grammy";
import { telegramOutboundGateState } from "../../packages/cache/main/telegram";
import { logger } from "../../packages/infra/logger";
import {
  runTelegramCategorizedRequest,
  telegramOutboundGate,
} from "../../packages/infra/telegram/outboundGate";
import { drainTelegramOutbound } from "../../packages/infra/telegram/outboundLifecycle";
import { resetTelegramOutboundGateState } from "../helpers/telegramOutboundGate";

type PreviousCall = Parameters<Transformer<RawApi>>[0];

/** 一个已经因超时中止的信号。 */
async function expiredTimeoutSignal(): Promise<AbortSignal> {
  const signal: AbortSignal = AbortSignal.timeout(1);
  await new Promise<void>((resolve: () => void): void => {
    signal.addEventListener("abort", (): void => resolve(), { once: true });
  });
  return signal;
}

function neverSettles(): Promise<unknown> {
  return new Promise<unknown>((): void => {});
}

afterEach((): void => resetTelegramOutboundGateState());

describe("出站总闸区分超时与取消", () => {
  test("在途请求的调用方超时预算耗尽时给 TimeoutError，主动取消仍给 AbortError", async () => {
    const timed: Promise<unknown> = runTelegramCategorizedRequest({
      category: "download",
      signal: AbortSignal.timeout(5),
      execute: neverSettles,
    });
    await expect(timed).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Telegram outbound request timed out.",
    });

    const controller: AbortController = new AbortController();
    const cancelled: Promise<unknown> = runTelegramCategorizedRequest({
      category: "download",
      signal: controller.signal,
      execute: neverSettles,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(telegramOutboundGateState.activeCount).toBe(0);
  });

  test("在 429 队列里等到超时给 TimeoutError，移出队列且从未出站", async () => {
    telegramOutboundGateState.lanes.download.recovering = true;
    let attempts: number = 0;
    const queued: Promise<unknown> = runTelegramCategorizedRequest({
      category: "download",
      signal: AbortSignal.timeout(5),
      execute: (): Promise<unknown> => {
        attempts++;
        return Promise.resolve(new Response(null));
      },
    });
    expect(telegramOutboundGateState.retryPendingCount).toBe(1);
    await expect(queued).rejects.toMatchObject({ name: "TimeoutError" });
    expect(telegramOutboundGateState.retryPendingCount).toBe(0);
    expect(attempts).toBe(0);
  });

  test("接纳时信号已因超时中止，分类请求与 transformer 都给 TimeoutError 且不出站", async () => {
    const signal: AbortSignal = await expiredTimeoutSignal();
    let calls: number = 0;
    await expect(runTelegramCategorizedRequest({
      category: "query",
      signal,
      execute: (): Promise<unknown> => {
        calls++;
        return Promise.resolve(true);
      },
    })).rejects.toMatchObject({ name: "TimeoutError" });
    const previous: PreviousCall = ((): Promise<unknown> => {
      calls++;
      return Promise.resolve({ ok: true, result: true });
    }) as PreviousCall;
    await expect(telegramOutboundGate()(previous, "getChat", { chat_id: -1001 }, signal as never))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toBe(0);
  });

  test("发送类在途时调用方超时给 TimeoutError", async () => {
    const previous: PreviousCall = neverSettles as PreviousCall;
    const sent: Promise<unknown> = telegramOutboundGate()(previous, "sendMessage", {
      chat_id: -1001,
      text: "slow",
    }, AbortSignal.timeout(5) as never) as Promise<unknown>;
    await expect(sent).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("停机撤销给 AbortError，与调用方是否带着尚未耗尽的超时预算无关", async () => {
    const request: Promise<unknown> = runTelegramCategorizedRequest({
      category: "download",
      signal: AbortSignal.timeout(60_000),
      execute: neverSettles,
    });
    const outcome: Promise<unknown> = request.catch((error: unknown): unknown => error);
    await expect(drainTelegramOutbound(0)).resolves.toBe("timedOut");
    expect(await outcome).toMatchObject({ name: "AbortError" });
  });
});

describe("429 退避留痕", () => {
  test("真实 429 开始一段等待时记一条 warn，等待期间的后续 429 不重复记录", async () => {
    const warn = spyOn(logger, "warn").mockImplementation((): void => {});
    try {
      const resolvers: ((value: unknown) => void)[] = [];
      const previous: PreviousCall = ((): Promise<unknown> =>
        new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolvers.push(resolve);
        })) as PreviousCall;
      const transform: Transformer<RawApi> = telegramOutboundGate();
      const outcomes: Promise<PromiseSettledResult<unknown>[]> = Promise.allSettled([
        transform(previous, "getChat", { chat_id: -1001 }),
        transform(previous, "getChat", { chat_id: -1002 }),
      ]);
      expect(resolvers).toHaveLength(2);
      for (const resolve of resolvers) {
        resolve({ ok: false, error_code: 429, parameters: { retry_after: 60 } });
      }
      for (let tick: number = 0; tick < 10 && telegramOutboundGateState.retryPendingCount < 2; tick++) {
        await Promise.resolve();
      }
      expect(telegramOutboundGateState.retryPendingCount).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("Telegram query requests hit 429; backing off for 60000 ms.");
      await expect(drainTelegramOutbound(0)).resolves.toBe("timedOut");
      await outcomes;
    } finally {
      warn.mockRestore();
    }
  });
});
