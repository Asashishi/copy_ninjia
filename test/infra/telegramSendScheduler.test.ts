import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { RawApi, Transformer } from "grammy";
import { telegramOutboundGateState } from "../../packages/cache/main/telegram";
import { sendChatLanes, sendSchedulerState } from "../../packages/cache/main/telegramSend";
import {
  TELEGRAM_MESSAGE_GROUP_PENDING_MAX,
  TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX,
  TELEGRAM_SEND_CHAT_BURST,
  TELEGRAM_SEND_CHAT_CAUTIOUS_MS,
  TELEGRAM_SEND_CHAT_REFILL_MS,
  TELEGRAM_SEND_GLOBAL_LIMIT,
  TELEGRAM_SEND_GLOBAL_WINDOW_MS,
  TELEGRAM_SEND_GROUP_LIMIT,
  TELEGRAM_SEND_GROUP_WINDOW_MS,
} from "../../packages/consts/telegram";
import { telegramOutboundGate } from "../../packages/infra/telegram/outboundGate";
import { drainTelegramOutbound, initTelegramOutbound } from "../../packages/infra/telegram/outboundLifecycle";
import { isTelegramMessageRequest } from "../../packages/infra/telegram/outboundRetryPolicy";
import { TelegramSendQueueFullError } from "../../packages/infra/telegram/sendScheduler";
import { resetTelegramOutboundGateState } from "../helpers/telegramOutboundGate";
import { settleTestBatch } from "../helpers/common";

type PreviousCall = Parameters<Transformer<RawApi>>[0];

/** 一次真正发出的请求：聊天、正文与发出时刻（相对用例起点）。 */
interface SentRequest {
  readonly chatId: unknown;
  readonly text: string;
  readonly at: number;
}

const sent: SentRequest[] = [];
let startedAt: number = 0;
/** 按正文决定响应；缺省立即成功。 */
let respond: (text: string) => Promise<unknown> = (): Promise<unknown> => Promise.resolve({ ok: true, result: true });

const previous: PreviousCall = ((_method: string, payload: { chat_id: unknown; text?: string }): Promise<unknown> => {
  const text: string = payload.text ?? "";
  sent.push({ chatId: payload.chat_id, text, at: performance.now() - startedAt });
  return respond(text);
}) as PreviousCall;

const gate: Transformer<RawApi> = telegramOutboundGate();

/** 发送方法与额外 payload 字段；缺省为一条 sendMessage。 */
interface SendOptions {
  readonly method?: keyof RawApi;
  readonly extra?: object;
}

function send(chatId: number | string, text: string, { method = "sendMessage", extra = {} }: SendOptions = {}): Promise<unknown> {
  return gate(previous, method, { chat_id: chatId, text, ...extra } as never) as Promise<unknown>;
}

/** 让已就绪的 Promise 链跑完。 */
async function flush(): Promise<void> {
  for (let tick: number = 0; tick < 30; tick++) await Promise.resolve();
}

/** 推进假时钟并让回调后的 Promise 链跑完。 */
async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flush();
}

function textsOf(chatId: unknown): string[] {
  return sent.filter((request: SentRequest): boolean => request.chatId === chatId).map((request: SentRequest): string => request.text);
}

const TOO_MANY_REQUESTS = (seconds: number): unknown => ({ ok: false, error_code: 429, parameters: { retry_after: seconds } });

beforeEach((): void => {
  jest.useFakeTimers();
  resetTelegramOutboundGateState();
  initTelegramOutbound();
  sent.length = 0;
  startedAt = performance.now();
  respond = (): Promise<unknown> => Promise.resolve({ ok: true, result: true });
});

afterEach(async (): Promise<void> => {
  await drainTelegramOutbound(0);
  resetTelegramOutboundGateState();
  jest.useRealTimers();
});

describe("发送类请求的识别", () => {
  test("只有实际产生聊天消息、媒体、文件或转发的调用进入发送调度器", () => {
    for (const method of ["sendMessage", "sendPhoto", "sendAudio", "sendDocument", "copyMessage", "forwardMessages", "sendMessageDraft"] as const) {
      expect(isTelegramMessageRequest(method)).toBeTrue();
    }
    for (const method of ["answerInlineQuery", "sendChatAction", "getChat", "getFile", "banChatMember", "deleteMessage", "setMessageReaction", "answerCallbackQuery", "sendGift"] as const) {
      expect(isTelegramMessageRequest(method)).toBeFalse();
    }
  });
});

describe("每聊天发送调度器", () => {
  test("单聊天令牌桶：连发突发容量那么多条，之后每个补充周期放行一条，并保持同聊天顺序", async () => {
    const total: number = TELEGRAM_SEND_CHAT_BURST + 2;
    const requests: Promise<unknown>[] = Array.from({ length: total }, (_: unknown, index: number): Promise<unknown> => send(42, `m${index}`));
    await flush();
    expect(textsOf(42)).toHaveLength(TELEGRAM_SEND_CHAT_BURST);
    await advance(TELEGRAM_SEND_CHAT_REFILL_MS - 1);
    expect(textsOf(42)).toHaveLength(TELEGRAM_SEND_CHAT_BURST);
    await advance(1);
    expect(textsOf(42)).toHaveLength(TELEGRAM_SEND_CHAT_BURST + 1);
    await advance(TELEGRAM_SEND_CHAT_REFILL_MS);
    await settleTestBatch(requests);
    expect(textsOf(42)).toEqual(Array.from({ length: total }, (_: unknown, index: number): string => `m${index}`));
  });

  test("同一聊天最多一条在途，后一条等前一条的网络结算", async () => {
    const release: PromiseWithResolvers<unknown> = Promise.withResolvers<unknown>();
    respond = (text: string): Promise<unknown> => text === "first" ? release.promise : Promise.resolve({ ok: true, result: true });
    const first: Promise<unknown> = send(-1001, "first");
    const second: Promise<unknown> = send(-1001, "second");
    await flush();
    expect(textsOf(-1001)).toEqual(["first"]);
    release.resolve({ ok: true, result: true });
    await settleTestBatch([first, second]);
    expect(textsOf(-1001)).toEqual(["first", "second"]);
  });

  test("群类聊天任意一分钟不超过上限：超出上限的那条等最早那条满一分钟；私聊不受分钟窗口约束", async () => {
    const groupRequests: Promise<unknown>[] = [];
    const privateRequests: Promise<unknown>[] = [];
    for (let index: number = 0; index <= TELEGRAM_SEND_GROUP_LIMIT; index++) {
      groupRequests.push(send(-1001, `g${index}`));
      privateRequests.push(send(42, `p${index}`));
    }
    // 令牌桶约束下私聊每秒一条；推进到分钟窗口满之前，私聊全部发完，群只发到上限。
    const refillSteps: number = TELEGRAM_SEND_GROUP_LIMIT + 1 - TELEGRAM_SEND_CHAT_BURST;
    for (let step: number = 0; step < refillSteps; step++) await advance(TELEGRAM_SEND_CHAT_REFILL_MS);
    await settleTestBatch(privateRequests);
    expect(textsOf(42)).toHaveLength(TELEGRAM_SEND_GROUP_LIMIT + 1);
    expect(textsOf(-1001)).toHaveLength(TELEGRAM_SEND_GROUP_LIMIT);
    const firstAt: number = sent.find((request: SentRequest): boolean => request.text === "g0")!.at;
    await advance(firstAt + TELEGRAM_SEND_GROUP_WINDOW_MS - (performance.now() - startedAt) - 1);
    expect(textsOf(-1001)).toHaveLength(TELEGRAM_SEND_GROUP_LIMIT);
    await advance(1);
    await settleTestBatch(groupRequests);
    expect(sent.find((request: SentRequest): boolean => request.text === `g${TELEGRAM_SEND_GROUP_LIMIT}`)!.at)
      .toBe(firstAt + TELEGRAM_SEND_GROUP_WINDOW_MS);
  });

  test("全局秒窗口跨聊天共用，额度用完后按到达顺序轮转放行", async () => {
    const chats: number = TELEGRAM_SEND_GLOBAL_LIMIT + 2;
    const requests: Promise<unknown>[] = Array.from({ length: chats }, (_: unknown, index: number): Promise<unknown> => send(1_000 + index, `c${index}`));
    await flush();
    expect(sent).toHaveLength(TELEGRAM_SEND_GLOBAL_LIMIT);
    await advance(TELEGRAM_SEND_GLOBAL_WINDOW_MS);
    await settleTestBatch(requests);
    expect(sent.slice(TELEGRAM_SEND_GLOBAL_LIMIT).map((request: SentRequest): string => request.text))
      .toEqual([`c${TELEGRAM_SEND_GLOBAL_LIMIT}`, `c${TELEGRAM_SEND_GLOBAL_LIMIT + 1}`]);
  });

  test("相册按张数扣额度；单次条数超过桶容量时等桶满放行，欠额顺延到下一条", async () => {
    const album: readonly object[] = Array.from({ length: TELEGRAM_SEND_CHAT_BURST + 2 }, (): object => ({ type: "photo", media: "f" }));
    const first: Promise<unknown> = send(42, "album", { method: "sendMediaGroup", extra: { media: album } });
    const next: Promise<unknown> = send(42, "after");
    await flush();
    expect(textsOf(42)).toEqual(["album"]);
    // 欠额：桶从满额扣到 TELEGRAM_SEND_CHAT_BURST - 相册张数，补回到 1 才放行下一条。
    const debtSteps: number = album.length - TELEGRAM_SEND_CHAT_BURST + 1;
    await advance(debtSteps * TELEGRAM_SEND_CHAT_REFILL_MS - 1);
    expect(textsOf(42)).toEqual(["album"]);
    await advance(1);
    await settleTestBatch([first, next]);
    expect(textsOf(42)).toEqual(["album", "after"]);
  });

  test("429 只冻结这一个聊天，冻结期满重发，随后保守档内每次只放一条，保守档结束恢复突发", async () => {
    let throttled: boolean = true;
    respond = (text: string): Promise<unknown> => {
      if (text === "hot" && throttled) {
        throttled = false;
        return Promise.resolve(TOO_MANY_REQUESTS(5));
      }
      return Promise.resolve({ ok: true, result: true });
    };
    const hot: Promise<unknown> = send(-1001, "hot");
    await flush();
    expect(telegramOutboundGateState.lanes.message.pendingCount).toBe(1);
    // 另一个群照常发送。
    await send(-1002, "other");
    expect(textsOf(-1002)).toEqual(["other"]);
    const followers: Promise<unknown>[] = [send(-1001, "f1"), send(-1001, "f2")];
    await advance(5_000 - 1);
    expect(textsOf(-1001)).toEqual(["hot"]);
    await advance(1);
    await hot;
    expect(telegramOutboundGateState.lanes.message.pendingCount).toBe(0);
    // 保守档突发容量为 1：重发用掉唯一的令牌，后面每条隔一个补充周期。
    expect(textsOf(-1001)).toEqual(["hot", "hot"]);
    await advance(TELEGRAM_SEND_CHAT_REFILL_MS);
    expect(textsOf(-1001)).toEqual(["hot", "hot", "f1"]);
    await advance(TELEGRAM_SEND_CHAT_REFILL_MS);
    await settleTestBatch(followers);
    // 保守档结束后突发容量恢复。
    await advance(TELEGRAM_SEND_CHAT_CAUTIOUS_MS);
    sent.length = 0;
    await settleTestBatch(Array.from({ length: TELEGRAM_SEND_CHAT_BURST }, (_: unknown, index: number): Promise<unknown> => send(-1001, `b${index}`)));
    expect(textsOf(-1001)).toHaveLength(TELEGRAM_SEND_CHAT_BURST);
  });

  test("@username 不分大小写归入同一个群类车道，数字字符串与数字 id 同车道", async () => {
    await send("@SomeChannel", "a");
    await send("@somechannel", "b");
    expect(sendChatLanes.size).toBe(1);
    expect(sendChatLanes.get("@somechannel")?.groupClass).toBeTrue();
    await send("-1001", "c");
    await send(-1001, "d");
    expect(sendChatLanes.size).toBe(2);
  });

  test("排队中取消立即出队且不扣额度，在途计数随之归还", async () => {
    const queued: Promise<unknown>[] = Array.from({ length: TELEGRAM_SEND_CHAT_BURST }, (_: unknown, index: number): Promise<unknown> => send(42, `m${index}`));
    const controller: AbortController = new AbortController();
    const cancelled: Promise<unknown> = (gate(previous, "sendMessage", { chat_id: 42, text: "cancelled" } as never, controller.signal as never) as Promise<unknown>)
      .catch((error: unknown): unknown => error);
    const after: Promise<unknown> = send(42, "after");
    await flush();
    expect(telegramOutboundGateState.lanes.message.activeCount).toBe(2);
    controller.abort();
    expect(await cancelled).toMatchObject({ name: "AbortError" });
    expect(telegramOutboundGateState.lanes.message.activeCount).toBe(1);
    await settleTestBatch(queued);
    // 被取消的那条没扣令牌：下一条只等一个补充周期。
    await advance(TELEGRAM_SEND_CHAT_REFILL_MS);
    await after;
    expect(textsOf(42)).toEqual([...Array.from({ length: TELEGRAM_SEND_CHAT_BURST }, (_: unknown, index: number): string => `m${index}`), "after"]);
  });

  test("单群与单私聊的排队上限满时当即拒绝新请求，不计入在途", async () => {
    const never: Promise<unknown> = new Promise<unknown>((): void => {});
    respond = (): Promise<unknown> => never;
    const outcomes: Promise<unknown>[] = [];
    for (let index: number = 0; index <= TELEGRAM_MESSAGE_GROUP_PENDING_MAX; index++) {
      outcomes.push(send(-1001, `g${index}`).catch((error: unknown): unknown => error));
    }
    for (let index: number = 0; index <= TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX; index++) {
      outcomes.push(send(42, `p${index}`).catch((error: unknown): unknown => error));
    }
    const groupRejected: unknown = await send(-1001, "overflow").catch((error: unknown): unknown => error);
    const privateRejected: unknown = await send(42, "overflow").catch((error: unknown): unknown => error);
    expect(groupRejected).toBeInstanceOf(TelegramSendQueueFullError);
    expect(privateRejected).toBeInstanceOf(TelegramSendQueueFullError);
    // 各一条在途，其余排队到上限。
    expect(sendChatLanes.get(-1001)?.queued).toBe(TELEGRAM_MESSAGE_GROUP_PENDING_MAX);
    expect(sendChatLanes.get(42)?.queued).toBe(TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX);
    expect(telegramOutboundGateState.lanes.message.activeCount)
      .toBe(TELEGRAM_MESSAGE_GROUP_PENDING_MAX + TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX + 2);
    await drainTelegramOutbound(0);
    for (const outcome of await settleTestBatch(outcomes)) expect(outcome).toMatchObject({ name: "AbortError" });
    expect(sendSchedulerState.queuedTotal).toBe(0);
    expect(telegramOutboundGateState.lanes.message.activeCount).toBe(0);
  });

  test("空闲车道在分钟窗口过去后删除", async () => {
    await send(-1001, "once");
    expect(sendChatLanes.has(-1001)).toBeTrue();
    await advance(TELEGRAM_SEND_GROUP_WINDOW_MS - 1);
    expect(sendChatLanes.has(-1001)).toBeTrue();
    await advance(1);
    expect(sendChatLanes.has(-1001)).toBeFalse();
  });

  test("排空等待覆盖等额度的排队请求，额度到点发出后才算排空", async () => {
    const requests: Promise<unknown>[] = Array.from({ length: TELEGRAM_SEND_CHAT_BURST + 1 }, (_: unknown, index: number): Promise<unknown> => send(42, `m${index}`));
    await flush();
    let drained: unknown;
    const drain: Promise<unknown> = drainTelegramOutbound(10 * TELEGRAM_SEND_CHAT_REFILL_MS).then((result: unknown): unknown => {
      drained = result;
      return result;
    });
    await flush();
    expect(drained).toBeUndefined();
    await advance(TELEGRAM_SEND_CHAT_REFILL_MS);
    await settleTestBatch(requests);
    expect(await drain).toBe("flushed");
  });
});
