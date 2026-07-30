import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * 限频/溢出提示的投递路径（replyState.ts 的 notifyRateLimited）：按群冷却避免
 * 刷屏，发送成功后与普通 AI 回复一样登记自发消息并写入滚动记忆。
 */

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage },
});

let nextSentMessageId: number | undefined = 501;
const sendMessage = mock(async (_message: { chatId: number; text: string }): Promise<number | undefined> =>
  nextSentMessageId
);
const recordChatMessage = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/infra/telegram", () => ({ sendMessage }));
mock.module("../../../packages/workers/aiChat/rollingMemory", () => ({ recordChatMessage }));

const { currentReplyGeneration, notifyRateLimited } = await import("../../../packages/workers/aiChat/replyState");
const { botInfoState } = await import("../../../packages/cache/workers/aiChat/identity");
const {
  invalidateChatReplyCache,
  rateLimitNoticeTimes,
  resetAiChatReplyCache,
} = await import("../../../packages/cache/workers/aiChat/replies");
const { RATE_LIMIT_NOTICE_COOLDOWN_MS, RATE_LIMIT_NOTICE_TEXT } =
  await import("../../../packages/consts/aiChat/rateLimit");

const CHAT_ID: number = -1001;
const NOW: number = 1_700_000_000_000;

beforeEach(() => {
  resetAiChatReplyCache();
  botInfoState.current = { id: 99, first_name: "Ninja", username: "ninja_bot" };
  nextSentMessageId = 501;
  postMessage.mockClear();
  sendMessage.mockClear();
  recordChatMessage.mockClear();
});

afterAll(() => {
  resetAiChatReplyCache();
  botInfoState.current = null;
  if (originalSelfDescriptor) Object.defineProperty(globalThis, "self", originalSelfDescriptor);
  else delete (globalThis as { self?: unknown }).self;
});

describe("AI 限频提示", () => {
  test("首次触发发送提示、回报自发消息并写入滚动记忆", async () => {
    notifyRateLimited(CHAT_ID, NOW);
    await Bun.sleep(0);

    expect(sendMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      text: RATE_LIMIT_NOTICE_TEXT,
      signal: expect.any(AbortSignal),
    });
    expect(postMessage).toHaveBeenCalledWith({ type: "sent", chatId: CHAT_ID, messageId: 501 });
    expect(recordChatMessage).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      senderId: 99,
      firstName: "Ninja",
      lastName: "",
      username: "ninja_bot",
      messageId: 501,
      text: RATE_LIMIT_NOTICE_TEXT,
    });
    expect(rateLimitNoticeTimes.get(CHAT_ID)).toBe(NOW);
  });

  test("冷却窗口内不重复刷屏，窗口一满才允许再提示", async () => {
    notifyRateLimited(CHAT_ID, NOW);
    notifyRateLimited(CHAT_ID, NOW + RATE_LIMIT_NOTICE_COOLDOWN_MS - 1);
    await Bun.sleep(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(rateLimitNoticeTimes.get(CHAT_ID)).toBe(NOW);

    notifyRateLimited(CHAT_ID, NOW + RATE_LIMIT_NOTICE_COOLDOWN_MS);
    await Bun.sleep(0);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(rateLimitNoticeTimes.get(CHAT_ID)).toBe(NOW + RATE_LIMIT_NOTICE_COOLDOWN_MS);
  });

  test("提示没发出去时不回报也不写记忆，但冷却照常记账", async () => {
    nextSentMessageId = undefined;

    notifyRateLimited(CHAT_ID, NOW);
    await Bun.sleep(0);

    expect(postMessage).not.toHaveBeenCalled();
    expect(recordChatMessage).not.toHaveBeenCalled();
    expect(rateLimitNoticeTimes.get(CHAT_ID)).toBe(NOW);
  });

  test("发送在途期间群被清空时仍回报自发消息，但不再写进新一代记忆", async () => {
    const generation: number = currentReplyGeneration(CHAT_ID);
    sendMessage.mockImplementationOnce(async (): Promise<number> => {
      invalidateChatReplyCache(CHAT_ID);
      return 502;
    });

    notifyRateLimited(CHAT_ID, NOW, generation);
    await Bun.sleep(0);

    expect(postMessage).toHaveBeenCalledWith({ type: "sent", chatId: CHAT_ID, messageId: 502 });
    expect(recordChatMessage).not.toHaveBeenCalled();
  });

  test("身份尚未初始化时不写滚动记忆", async () => {
    botInfoState.current = null;

    notifyRateLimited(CHAT_ID, NOW);
    await Bun.sleep(0);

    expect(postMessage).toHaveBeenCalledWith({ type: "sent", chatId: CHAT_ID, messageId: 501 });
    expect(recordChatMessage).not.toHaveBeenCalled();
  });
});
