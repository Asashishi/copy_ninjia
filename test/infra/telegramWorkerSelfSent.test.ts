import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { TelegramWorkerRequest } from "../../packages/types/telegramWorker";

/**
 * Worker 代理发送的自发登记时序。
 *
 * 本文件把 Worker 侧的代理客户端接到**真实的**主线程 handler 上，钉住的是一条
 * 时序不变量：`workerTelegramApi.*` 解开的那一刻，主线程的自发消息表里已经有这条
 * 消息了。Worker 最早也要等到这一刻才拿得到 message id，因此它不需要、也无法比
 * 主线程更早知道自己发了什么——「Worker 不回投自己发了什么」这条设计由本文件
 * 负责证明（见 infra/telegram/workerRequests.ts 的 markWorkerSentMessage）。
 *
 * 代理客户端自己**不**调用 markSelfSent（`infra/telegram/workerClient.ts` 只做
 * 载荷编组），所以这里读到的 true 只可能来自主线程边界的登记——不会因为单进程
 * 测试里两侧共用同一张 per-thread 表而给出假阳性。这条前提由最后一个用例钉住。
 */

/** 主线程 handler 的注入位；mock 工厂在 import 时才求值，此处按调用时读取。 */
let mainThreadHandler:
  | ((request: TelegramWorkerRequest, signal: AbortSignal) => Promise<unknown>)
  | null = null;

mock.module("../../packages/libs/workerDuplex", () => ({
  requestMainThread: async (
    request: TelegramWorkerRequest,
    signal?: AbortSignal
  ): Promise<unknown> => {
    if (mainThreadHandler === null) throw new Error("main-thread handler is not installed");
    return mainThreadHandler(request, signal ?? new AbortController().signal);
  },
}));

interface SentPayload {
  readonly chat_id: number;
}

let nextMessageId: number = 900;
/** 下一次代理返回值的一次性覆盖；用来构造「结果里没有 chat」这种形态。 */
let nextResultOverride: Record<string, unknown> | null = null;

function sentMessage(chatId: number): Record<string, unknown> {
  if (nextResultOverride !== null) {
    const override: Record<string, unknown> = nextResultOverride;
    nextResultOverride = null;
    return override;
  }
  nextMessageId += 1;
  return { message_id: nextMessageId, chat: { id: chatId, type: "supergroup" } };
}

mock.module("../../packages/infra/telegram/mainClient", () => ({
  bot: {
    api: {
      raw: {
        sendMessage: async (payload: SentPayload): Promise<unknown> => sentMessage(payload.chat_id),
        sendSticker: async (payload: SentPayload): Promise<unknown> => sentMessage(payload.chat_id),
      },
      sendPhoto: async (chatId: number): Promise<unknown> => sentMessage(chatId),
      sendAudio: async (chatId: number): Promise<unknown> => sentMessage(chatId),
    },
  },
}));

const { workerTelegramApi } = await import("../../packages/infra/telegram/workerClient");
const {
  handleAiWorkerTelegramRequest,
  handleAntiRaidWorkerTelegramRequest,
} = await import("../../packages/infra/telegram/workerRequests");
const { isSelfSent } = await import("../../packages/infra/selfSentTracker");

const CHAT_ID: number = -1001;

beforeEach((): void => {
  mainThreadHandler = handleAiWorkerTelegramRequest;
  nextResultOverride = null;
});

/** 从代理返回的 Message 取出 id；四条能力的返回形状一致。 */
function messageIdOf(sent: unknown): number {
  const id: unknown = (sent as { message_id?: unknown }).message_id;
  if (typeof id !== "number") throw new Error("proxy did not return a message id");
  return id;
}

describe("Worker 拿到 id 之前，主线程已经登记了这条自发消息", () => {
  test("文本", async (): Promise<void> => {
    const sent: unknown = await workerTelegramApi.sendMessage(CHAT_ID, "reply");

    expect(isSelfSent(CHAT_ID, messageIdOf(sent))).toBeTrue();
  });

  test("贴纸", async (): Promise<void> => {
    const sent: unknown = await workerTelegramApi.sendSticker(CHAT_ID, "sticker-file-id");

    expect(isSelfSent(CHAT_ID, messageIdOf(sent))).toBeTrue();
  });

  test("生图", async (): Promise<void> => {
    const sent: unknown = await workerTelegramApi.sendPhoto(
      CHAT_ID,
      { bytes: new Uint8Array([1, 2, 3]), fileName: "generated.png" }
    );

    expect(isSelfSent(CHAT_ID, messageIdOf(sent))).toBeTrue();
  });

  test("生歌", async (): Promise<void> => {
    const sent: unknown = await workerTelegramApi.sendAudio(
      CHAT_ID,
      { bytes: new Uint8Array([4, 5, 6]), fileName: "song.mp3" }
    );

    expect(isSelfSent(CHAT_ID, messageIdOf(sent))).toBeTrue();
  });

  test("Anti-Raid 的公告同样登记——它没有 sent 事件可回投", async (): Promise<void> => {
    mainThreadHandler = handleAntiRaidWorkerTelegramRequest;

    const sent: unknown = await workerTelegramApi.sendMessage(CHAT_ID, "公告");

    expect(isSelfSent(CHAT_ID, messageIdOf(sent))).toBeTrue();
  });

  test("键取自结果里的 chat.id，不取 payload 的 chat_id", async (): Promise<void> => {
    // payload 的 chat_id 可以是 `@username` 字符串，拼不出主线程那张表的数字键。
    // 判据因此只认结果的形状：没有 chat 就不登记。
    nextResultOverride = { message_id: 18 };

    await workerTelegramApi.sendMessage(CHAT_ID, "reply");

    expect(isSelfSent(CHAT_ID, 18)).toBeFalse();
  });

  test("代理客户端自己不登记：主线程不登记时上面的断言必然为假", async (): Promise<void> => {
    // 本用例是上面五条 true 的对照组。绕开主线程 handler 直接返回一条 Message，
    // 若代理客户端或共用的 per-thread 表会顺手登记，这里就会是 true——那样
    // 上面那五条 true 全都证明不了「登记来自主线程边界」。
    mainThreadHandler = async (): Promise<unknown> => sentMessage(CHAT_ID);

    const sent: unknown = await workerTelegramApi.sendMessage(CHAT_ID, "reply");

    expect(isSelfSent(CHAT_ID, messageIdOf(sent))).toBeFalse();
  });
});
