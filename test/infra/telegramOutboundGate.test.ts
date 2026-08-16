import { afterEach, describe, expect, test } from "bun:test";
import type { RawApi, Transformer } from "grammy";
import { settleTestBatch } from "../libs/helpers";
import {
  telegramOutboundAbortController,
  telegramOutboundAccepting,
  telegramOutboundGateState,
} from "../../packages/cache/main/telegram";
import type {
  TelegramRetryCategory,
  TelegramRetryLane,
} from "../../packages/types/telegramOutbound";
import {
  TELEGRAM_429_RETRY_QUEUE_MAX,
} from "../../packages/consts/telegram";
import {
  drainTelegramOutbound,
  initTelegramOutbound,
  quiesceTelegramOutbound,
  runTelegramCategorizedRequest,
  telegramOutboundGate,
} from "../../packages/infra/telegram/outboundGate";
import {
  telegramRetryCategoryFor,
  TelegramRetryQueueFullError,
} from "../../packages/infra/telegram/outboundRetryPolicy";

type PreviousCall = Parameters<Transformer<RawApi>>[0];

interface DeferredApiResponse {
  readonly promise: Promise<unknown>;
  readonly resolve: () => void;
}

function deferredApiResponse(): DeferredApiResponse {
  let resolvePromise!: (value: unknown) => void;
  const promise: Promise<unknown> = new Promise<unknown>((resolve: (value: unknown) => void): void => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (): void => resolvePromise({ ok: true, result: true }),
  };
}

function resetLane(lane: TelegramRetryLane): void {
  lane.head = null;
  lane.tail = null;
  lane.activeCount = 0;
  lane.pendingCount = 0;
  lane.retryAt = 0;
  if (lane.retryTimer !== null) clearTimeout(lane.retryTimer);
  lane.retryTimer = null;
  lane.recoveryLimit = 1;
  lane.recoveryActive = 0;
  lane.recovering = false;
}

function resetGateState(): void {
  telegramOutboundAbortController.current = new AbortController();
  telegramOutboundAccepting.current = true;
  telegramOutboundGateState.activeCount = 0;
  telegramOutboundGateState.retryPendingCount = 0;
  telegramOutboundGateState.aborting = false;
  telegramOutboundGateState.activeJobs.clear();
  for (const category of Object.keys(
    telegramOutboundGateState.lanes
  ) as TelegramRetryCategory[]) {
    resetLane(telegramOutboundGateState.lanes[category]);
  }
  for (const waiter of telegramOutboundGateState.drainWaiters) clearTimeout(waiter.timer);
  telegramOutboundGateState.drainWaiters.clear();
}

afterEach((): void => resetGateState());

describe("Telegram 主线程出站总闸", () => {
  test("正常请求不进入 429 队列，也没有普通消息占满并发位后饿死踢人的问题", async () => {
    const started: string[] = [];
    const deferred: DeferredApiResponse[] = [];
    const previous: PreviousCall = ((method: string, payload: unknown): Promise<unknown> => {
      const response: DeferredApiResponse = deferredApiResponse();
      const text: string = typeof payload === "object" && payload !== null && "text" in payload
        ? String(payload.text)
        : String(method);
      started.push(text);
      deferred.push(response);
      return response.promise;
    }) as PreviousCall;
    const transform: Transformer<RawApi> = telegramOutboundGate();
    const message: Promise<unknown> = transform(previous, "sendMessage", {
      chat_id: -1001,
      text: "message",
    }) as Promise<unknown>;
    const kick: Promise<unknown> = transform(previous, "banChatMember", {
      chat_id: -1001,
      user_id: 7,
    }) as Promise<unknown>;

    expect(started).toEqual(["message", "banChatMember"]);
    expect(telegramOutboundGateState.activeCount).toBe(2);
    expect(telegramOutboundGateState.retryPendingCount).toBe(0);
    for (const response of deferred) response.resolve();
    await settleTestBatch([message, kick]);
    expect(telegramOutboundGateState.activeCount).toBe(0);
    expect(telegramOutboundGateState.retryPendingCount).toBe(0);
  });

  test("81,920 容量只约束 429 等待项，满载时新等待项被丢弃", async () => {
    const previous: PreviousCall = (() => Promise.resolve({ ok: true, result: true })) as PreviousCall;
    const transform: Transformer<RawApi> = telegramOutboundGate();
    const queryLane: TelegramRetryLane = telegramOutboundGateState.lanes.query;
    queryLane.recovering = true;
    telegramOutboundGateState.retryPendingCount = TELEGRAM_429_RETRY_QUEUE_MAX;

    await expect(transform(previous, "getChat", {
      chat_id: -1001,
    })).rejects.toBeInstanceOf(TelegramRetryQueueFullError);

    telegramOutboundGateState.retryPendingCount = 0;
    const controller: AbortController = new AbortController();
    const queued: Promise<unknown> = transform(previous, "getChat", {
      chat_id: -1001,
    }, controller.signal as never) as Promise<unknown>;
    expect(telegramOutboundGateState.retryPendingCount).toBe(1);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(telegramOutboundGateState.retryPendingCount).toBe(0);
  });

  test("getUpdates 绕过出站闸，排空等待覆盖已接纳请求", async () => {
    const response: DeferredApiResponse = deferredApiResponse();
    let calls: number = 0;
    const previous: PreviousCall = (() => {
      calls++;
      return response.promise;
    }) as PreviousCall;
    const transform: Transformer<RawApi> = telegramOutboundGate();

    const inbound: Promise<unknown> = transform(previous, "getUpdates", {
      timeout: 0,
    }) as Promise<unknown>;
    expect(calls).toBe(1);
    response.resolve();
    await inbound;

    const outboundResponse: DeferredApiResponse = deferredApiResponse();
    const outboundPrevious: PreviousCall = (() => outboundResponse.promise) as PreviousCall;
    const outbound: Promise<unknown> = transform(outboundPrevious, "sendMessage", {
      chat_id: -1001,
      text: "status",
    }) as Promise<unknown>;
    const drain: Promise<"flushed" | "timedOut" | "failed"> =
      drainTelegramOutbound(1_000);
    outboundResponse.resolve();

    await expect(outbound).resolves.toEqual({ ok: true, result: true });
    await expect(drain).resolves.toBe("flushed");
  });

  test("排空超时会中止永不结算的真实请求并把统计归零", async () => {
    let requestSignal: AbortSignal | undefined;
    const request: Promise<unknown> = runTelegramCategorizedRequest({
      category: "query",
      execute: (signal: AbortSignal): Promise<unknown> => {
        requestSignal = signal;
        return new Promise<unknown>(() => {});
      },
    });

    expect(telegramOutboundGateState.activeCount).toBe(1);
    const outcome: Promise<unknown> = request.then(
      (value: unknown): unknown => value,
      (error: unknown): unknown => error
    );
    await expect(drainTelegramOutbound(1)).resolves.toBe("timedOut");
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(requestSignal?.aborted).toBeTrue();
    expect(telegramOutboundGateState.activeCount).toBe(0);
    expect(telegramOutboundGateState.activeJobs.size).toBe(0);
    expect(telegramOutboundGateState.retryPendingCount).toBe(0);
  });

  test("零预算取消 active，迟到完成不能让计数复活", async () => {
    let resolveLate: ((value: unknown) => void) | undefined;
    const late: Promise<unknown> = runTelegramCategorizedRequest({
      category: "query",
      execute: (_signal: AbortSignal): Promise<unknown> =>
        new Promise<unknown>((resolve: (value: unknown) => void): void => {
          resolveLate = resolve;
        }),
    });
    expect(telegramOutboundGateState.activeCount).toBe(1);
    await expect(drainTelegramOutbound(0)).resolves.toBe("timedOut");
    await expect(late).rejects.toMatchObject({ name: "AbortError" });
    resolveLate?.({ ok: true, result: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(telegramOutboundGateState.activeCount).toBe(0);
    expect(telegramOutboundGateState.retryPendingCount).toBe(0);
    expect(telegramOutboundGateState.lanes.query.retryTimer).toBeNull();
  });

  test("零预算取消 429 timer 和等待队列，并结算原请求", async () => {
    const request: Promise<unknown> = runTelegramCategorizedRequest({
      category: "query",
      execute: (_signal: AbortSignal): Promise<unknown> => Promise.resolve({
        ok: false,
        error_code: 429,
        parameters: { retry_after: 60 },
      }),
    });
    const outcome: Promise<unknown> = request.catch(
      (error: unknown): unknown => error
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(telegramOutboundGateState.retryPendingCount).toBe(1);
    expect(telegramOutboundGateState.lanes.query.retryTimer).not.toBeNull();

    await expect(drainTelegramOutbound(0)).resolves.toBe("timedOut");
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(telegramOutboundGateState.retryPendingCount).toBe(0);
    expect(telegramOutboundGateState.lanes.query.retryTimer).toBeNull();
  });

  test("quiesce 后拒绝新工作，显式初始化以新代际恢复接纳", async () => {
    let calls: number = 0;
    quiesceTelegramOutbound();
    await expect(runTelegramCategorizedRequest({
      category: "query",
      execute: (_signal: AbortSignal): Promise<unknown> => {
        calls++;
        return Promise.resolve({ ok: true });
      },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);

    initTelegramOutbound();
    await expect(runTelegramCategorizedRequest({
      category: "query",
      execute: (_signal: AbortSignal): Promise<unknown> => {
        calls++;
        return Promise.resolve({ ok: true });
      },
    })).resolves.toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  test("非发送请求收到 429 后释放并发位并按 retry_after 重新排队", async () => {
    let attempts: number = 0;
    const previous: PreviousCall = ((): Promise<unknown> => {
      attempts++;
      if (attempts !== 1) {
        return Promise.resolve({ ok: true, result: { id: -1001 } });
      }
      return Promise.resolve({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 0 },
      });
    }) as PreviousCall;
    const transform: Transformer<RawApi> = telegramOutboundGate();
    const request: Promise<unknown> = transform(previous, "getChat", {
      chat_id: -1001,
    }) as Promise<unknown>;

    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(1);
    expect(telegramOutboundGateState.activeCount).toBe(0);
    expect(telegramOutboundGateState.retryPendingCount).toBe(1);
    expect(telegramOutboundGateState.lanes.query.retryTimer).not.toBeNull();

    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 10);
    });
    await expect(request).resolves.toEqual({ ok: true, result: { id: -1001 } });
    expect(attempts).toBe(2);
    expect(telegramOutboundGateState.retryPendingCount).toBe(0);
  });

  test("查询 429 只暂停查询，不阻塞发送、踢人、禁言或删除类别", async () => {
    const controller: AbortController = new AbortController();
    const calledMethods: string[] = [];
    const previous: PreviousCall = ((method: string): Promise<unknown> => {
      calledMethods.push(method);
      if (method !== "getChat") {
        return Promise.resolve({ ok: true, result: true });
      }
      return Promise.resolve({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 60 },
      });
    }) as PreviousCall;
    const transform: Transformer<RawApi> = telegramOutboundGate();
    const adaptive: Promise<unknown> = transform(previous, "getChat", {
      chat_id: -1001,
    }, controller.signal as never) as Promise<unknown>;

    await Promise.resolve();
    await Promise.resolve();
    expect(telegramOutboundGateState.retryPendingCount).toBe(1);

    const messageRequest: Promise<unknown> = transform(previous, "sendMessage", {
      chat_id: -1001,
      text: "still flowing",
    }) as Promise<unknown>;
    await expect(messageRequest).resolves.toEqual({ ok: true, result: true });
    const kickRequest: Promise<unknown> = transform(previous, "banChatMember", {
      chat_id: -1001,
      user_id: 7,
    }) as Promise<unknown>;
    await expect(kickRequest).resolves.toEqual({ ok: true, result: true });
    const restrictRequest: Promise<unknown> = transform(
      previous,
      "restrictChatMember",
      {
        chat_id: -1001,
        user_id: 7,
        permissions: { can_send_messages: false },
      }
    ) as Promise<unknown>;
    await expect(restrictRequest).resolves.toEqual({ ok: true, result: true });
    const deleteRequest: Promise<unknown> = transform(previous, "deleteMessage", {
      chat_id: -1001,
      message_id: 42,
    }) as Promise<unknown>;
    await expect(deleteRequest).resolves.toEqual({ ok: true, result: true });
    expect(calledMethods).toEqual([
      "getChat",
      "sendMessage",
      "banChatMember",
      "restrictChatMember",
      "deleteMessage",
    ]);

    controller.abort();
    await expect(adaptive).rejects.toMatchObject({ name: "AbortError" });
    expect(telegramOutboundGateState.retryPendingCount).toBe(0);
  });

  test("超级群纯踢出命中 429 后重放前现查，目标已被封禁时不执行 unban", async () => {
    const calledMethods: string[] = [];
    let unbanAttempts: number = 0;
    const previous: PreviousCall = ((method: string): Promise<unknown> => {
      calledMethods.push(method);
      if (method === "getChatMember") {
        return Promise.resolve({
          ok: true,
          result: { status: "kicked", user: { id: 7, is_bot: false, first_name: "x" } },
        });
      }
      if (method === "unbanChatMember") {
        unbanAttempts++;
        if (unbanAttempts === 1) {
          return Promise.resolve({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 0 },
          });
        }
      }
      return Promise.resolve({ ok: true, result: true });
    }) as PreviousCall;
    const transform: Transformer<RawApi> = telegramOutboundGate();
    const request: Promise<unknown> = transform(previous, "unbanChatMember", {
      chat_id: -1001,
      user_id: 7,
    }) as Promise<unknown>;

    await expect(request).rejects.toMatchObject({
      name: "TelegramRetryPreconditionChangedError",
    });
    expect(unbanAttempts).toBe(1);
    expect(calledMethods).toEqual(["unbanChatMember", "getChatMember"]);
    expect(telegramOutboundGateState.retryPendingCount).toBe(0);
  });

  test("drain 后已接纳的纯踢重试仍可完成内部成员复核", async () => {
    let unbanAttempts: number = 0;
    const previous: PreviousCall = ((method: string): Promise<unknown> => {
      if (method === "getChatMember") {
        return Promise.resolve({
          ok: true,
          result: { status: "member", user: { id: 7, is_bot: false, first_name: "x" } },
        });
      }
      unbanAttempts++;
      // 用一个极小的正数把重试排到下一个 tick：非正值会被下限 clamp 到
      // TELEGRAM_429_FALLBACK_RETRY_MS（见下面那条零延迟回归），本例关心的
      // 是「重试仍能完成内部复核」，不是退避时长。
      return Promise.resolve(unbanAttempts === 1
        ? {
          ok: false,
          error_code: 429,
          parameters: { retry_after: 0.001 },
        }
        : { ok: true, result: true });
    }) as PreviousCall;
    const transform: Transformer<RawApi> = telegramOutboundGate();
    const request: Promise<unknown> = transform(previous, "unbanChatMember", {
      chat_id: -1001,
      user_id: 7,
    }) as Promise<unknown>;
    await Promise.resolve();
    await Promise.resolve();
    expect(telegramOutboundGateState.retryPendingCount).toBe(1);

    const drain: Promise<"flushed" | "timedOut" | "failed"> =
      drainTelegramOutbound(1_000);
    await expect(request).resolves.toEqual({ ok: true, result: true });
    await expect(drain).resolves.toBe("flushed");
    expect(unbanAttempts).toBe(2);
  });

  // 零延迟重试就是对着一个刚说过 429 的服务端空转（实测持续 429 时 300ms 内近
  // 三百次请求，正常兜底只有两次）。空串与纯空白会被 Number 归成 0 从而绕过
  // null 兜底；`Retry-After: 0` 本身还是 RFC 9110 的合法取值。三条路都必须落到
  // 统一兜底值上。
  for (const retryAfter of ["", "   ", "0"]) {
    test(`回归：Retry-After 为 ${JSON.stringify(retryAfter)} 时按兜底退避，不做零延迟空转`, async () => {
      let attempts: number = 0;
      const request: Promise<unknown> = runTelegramCategorizedRequest({
        category: "download",
        execute: (): Promise<Response> => {
          attempts++;
          return Promise.resolve(attempts === 1
            ? new Response(null, { status: 429, headers: { "retry-after": retryAfter } })
            : new Response(null, { status: 200 }));
        },
      });
      // 先接住结局再排空：排空超时会同步 abort 这个请求，晚一拍挂 handler
      // 会被当成未处理的 rejection（同「排空超时会中止永不结算的真实请求」）。
      const outcome: Promise<unknown> = request.then(
        (value: unknown): unknown => value,
        (error: unknown): unknown => error
      );
      // 排空预算远小于兜底退避：重试还没到点，只能超时收场。若退避是 0，
      // 这一轮会当场重试成功并让排空返回 flushed。
      await expect(drainTelegramOutbound(10)).resolves.toBe("timedOut");
      expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(attempts).toBe(1);
    });
  }

  test("显式解封的 only_if_banned 请求不套用纯踢出的重试前置条件", async () => {
    const calledMethods: string[] = [];
    let attempts: number = 0;
    const previous: PreviousCall = ((method: string): Promise<unknown> => {
      calledMethods.push(method);
      attempts++;
      return Promise.resolve(attempts === 1
        ? {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 0 },
        }
        : { ok: true, result: true });
    }) as PreviousCall;
    const transform: Transformer<RawApi> = telegramOutboundGate();

    const request: Promise<unknown> = transform(previous, "unbanChatMember", {
      chat_id: -1001,
      user_id: 7,
      only_if_banned: true,
    }) as Promise<unknown>;
    await expect(request).resolves.toEqual({ ok: true, result: true });
    expect(calledMethods).toEqual(["unbanChatMember", "unbanChatMember"]);
  });

  test("inline、聊天状态和普通消息进入彼此独立的类别", () => {
    expect(telegramRetryCategoryFor("answerInlineQuery")).toBe("inline");
    expect(telegramRetryCategoryFor("answerWebAppQuery")).toBe("inline");
    expect(telegramRetryCategoryFor("sendChatAction")).toBe("chatAction");
    expect(telegramRetryCategoryFor("sendMessage")).toBe("message");
    expect(telegramRetryCategoryFor("getFile")).toBe("download");
    expect(telegramRetryCategoryFor("restrictChatMember")).toBe("restrict");
    expect(telegramRetryCategoryFor("deleteMessage")).toBe("delete");
    expect(telegramRetryCategoryFor("deleteEphemeralMessage")).toBe("delete");
    expect(telegramRetryCategoryFor("deleteBusinessMessages")).toBe("delete");
    expect(telegramRetryCategoryFor("kickChatMember")).toBe("kick");
  });
});
