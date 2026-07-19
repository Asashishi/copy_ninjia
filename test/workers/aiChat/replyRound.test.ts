import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReplyToolContext, ReplyToolset } from "../../../src/types/aiChat/replies";

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage },
});

const heartbeatStop = mock(async (): Promise<void> => {});
const startChatActionHeartbeat = mock((_chatId: number) => ({
  current: () => "idle" as const,
  set: (_phase: "idle" | "typing" | "choose_sticker"): void => {},
  settle: async (): Promise<void> => {},
  stop: heartbeatStop,
}));
const stickerLockRelease = mock((): void => {});
const createStickerSendLock = mock((_chatId: number) => ({
  tryAcquire: (): boolean => true,
  release: stickerLockRelease,
}));
const execute = mock(async (..._args: unknown[]): Promise<string> => JSON.stringify({ success: true }));
let messagesSent: number = 0;
let actionsUsed: number = 1;
let capturedContext: ReplyToolContext | null = null;
const createReplyToolset = mock(async (ctx: ReplyToolContext): Promise<ReplyToolset> => {
  capturedContext = ctx;
  return {
    definitions: [],
    tools: [],
    has: (): boolean => true,
    execute,
    messagesSent: (): number => messagesSent,
    actionsUsed: (): number => actionsUsed,
    isActive: ctx.isActive,
  };
});
const callGemini = mock(async (..._args: unknown[]): Promise<string | null> => "最终正文");
let builtContent: string | null = "用户上下文";
const buildUserContent = mock((..._args: unknown[]): string | null => builtContent);
const recordChatMessage = mock((..._args: unknown[]): void => {});
const logError = mock((..._args: unknown[]): void => {});

mock.module("../../../src/ai/chatActionHeartbeat", () => ({ startChatActionHeartbeat }));
mock.module("../../../src/ai/stickers/sendLock", () => ({ createStickerSendLock }));
mock.module("../../../src/ai/tools/replyToolset", () => ({ createReplyToolset }));
mock.module("../../../src/workers/aiChat/geminiReply", () => ({ callGemini }));
mock.module("../../../src/workers/aiChat/promptContext", () => ({ buildUserContent }));
mock.module("../../../src/workers/aiChat/rollingMemory", () => ({ recordChatMessage }));
mock.module("../../../src/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: logError,
  },
}));

const { startReplyRound } = await import("../../../src/workers/aiChat/replyRound");
const { botInfoState } = await import("../../../src/cache/aiChat/identity");
const {
  activeReplyCounts,
  longTriggerTimes,
  rateLimitNoticeTimes,
  resetAiChatReplyCache,
} = await import("../../../src/cache/aiChat/replies");
const { invalidateChatReplyCache } = await import("../../../src/cache/aiChat/replies");
const { LinkedQueue } = await import("../../../src/libs/linkedQueue");
const { RATE_LIMIT_LONG_MAX_TRIGGERS } = await import("../../../src/consts/aiChat/rateLimit");
const { SUPER_ADMIN_USER_ID } = await import("../../../src/infra/config");
const { SEND_MESSAGE_TOOL } = await import("../../../src/consts/tools");

function runRound(overrides: Partial<Parameters<typeof startReplyRound>[0]> = {}): Promise<number> {
  return new Promise((resolve) => {
    startReplyRound({
      chatId: -1001,
      triggerSenderId: 7,
      replyToMessageId: 10,
      isRandomTrigger: false,
      ...overrides,
    }, resolve);
  });
}

beforeEach(() => {
  resetAiChatReplyCache();
  botInfoState.current = { id: 99, first_name: "Ninja", username: "ninja_bot" };
  builtContent = "用户上下文";
  messagesSent = 0;
  actionsUsed = 1;
  capturedContext = null;
  postMessage.mockClear();
  heartbeatStop.mockClear();
  startChatActionHeartbeat.mockClear();
  stickerLockRelease.mockClear();
  createStickerSendLock.mockClear();
  createReplyToolset.mockClear();
  execute.mockClear();
  execute.mockImplementation(async (): Promise<string> => JSON.stringify({ success: true }));
  callGemini.mockClear();
  callGemini.mockImplementation(async (): Promise<string | null> => "最终正文");
  buildUserContent.mockClear();
  recordChatMessage.mockClear();
  logError.mockClear();
});

afterEach(() => {
  resetAiChatReplyCache();
  botInfoState.current = null;
});

afterAll(() => {
  if (originalSelfDescriptor) Object.defineProperty(globalThis, "self", originalSelfDescriptor);
  else delete (globalThis as { self?: unknown }).self;
});

describe("AI 单轮回复生命周期", () => {
  test("模型只返回最终正文时统一走 send_message 兜底，并成对释放资源", async () => {
    await expect(runRound()).resolves.toBe(-1001);

    expect(execute).toHaveBeenCalledWith(
      SEND_MESSAGE_TOOL,
      JSON.stringify({ text: "最终正文", reply_to_trigger: true })
    );
    expect(heartbeatStop).toHaveBeenCalledTimes(1);
    expect(stickerLockRelease).toHaveBeenCalledTimes(1);
    expect(activeReplyCounts.has(-1001)).toBe(false);
    expect(longTriggerTimes.get(-1001)?.size).toBe(1);
  });

  test("工具发送回调回传消息 ID，并只在代际仍有效时登记滚动记忆", async () => {
    messagesSent = 2;
    actionsUsed = 2;
    callGemini.mockImplementationOnce(async (): Promise<null> => {
      capturedContext!.onMessageSent("文字消息", 101);
      capturedContext!.onStickerSent("[贴纸：挥手]", 102);
      capturedContext!.onImageSent("[生成图片：夜空]", 103);
      return null;
    });

    await runRound();

    expect(postMessage).toHaveBeenNthCalledWith(1, { type: "sent", chatId: -1001, messageId: 101 });
    expect(postMessage).toHaveBeenNthCalledWith(2, { type: "sent", chatId: -1001, messageId: 102 });
    expect(postMessage).toHaveBeenNthCalledWith(3, { type: "sent", chatId: -1001, messageId: 103 });
    expect(recordChatMessage).toHaveBeenCalledTimes(3);
  });

  test("仅 superAdmin 触发的轮次绕过图片生成冷却", async () => {
    await runRound({ triggerSenderId: SUPER_ADMIN_USER_ID });
    expect(capturedContext?.bypassImageGenerationCooldown).toBe(true);

    await runRound({ triggerSenderId: 7 });
    expect(capturedContext?.bypassImageGenerationCooldown).toBe(false);
  });

  test("构造上下文失败仍释放贴纸锁与并发位，但不会启动心跳", async () => {
    builtContent = null;

    await runRound();

    expect(startChatActionHeartbeat).not.toHaveBeenCalled();
    expect(stickerLockRelease).toHaveBeenCalledTimes(1);
    expect(activeReplyCounts.has(-1001)).toBe(false);
  });

  test("生成异常也会停止心跳、释放锁并完成轮次", async () => {
    callGemini.mockRejectedValueOnce(new Error("generation failed"));

    await runRound();
    await Promise.resolve();

    expect(heartbeatStop).toHaveBeenCalledTimes(1);
    expect(stickerLockRelease).toHaveBeenCalledTimes(1);
    expect(activeReplyCounts.has(-1001)).toBe(false);
    expect(logError).toHaveBeenCalledWith("Error in AI reply task:", expect.any(Error));
  });

  test("捕获代际已失效或身份尚未初始化时不占用任何资源", () => {
    invalidateChatReplyCache(-1001);
    const finished = mock((_chatId: number): void => {});
    startReplyRound({
      chatId: -1001,
      triggerSenderId: 7,
      replyToMessageId: 10,
      isRandomTrigger: false,
      generation: 0,
    }, finished);
    botInfoState.current = null;
    startReplyRound({
      chatId: -1002,
      triggerSenderId: 8,
      replyToMessageId: 11,
      isRandomTrigger: false,
    }, finished);

    expect(finished).not.toHaveBeenCalled();
    expect(createStickerSendLock).not.toHaveBeenCalled();
    expect(activeReplyCounts.size).toBe(0);
  });

  test("滑动窗口达到上限时拒绝新轮，通知冷却避免重复发送", () => {
    const now: number = Date.now();
    const times = new LinkedQueue<number>();
    for (let index: number = 0; index < RATE_LIMIT_LONG_MAX_TRIGGERS; index++) times.push(now);
    longTriggerTimes.set(-1001, times);
    rateLimitNoticeTimes.set(-1001, now);
    const finished = mock((_chatId: number): void => {});

    startReplyRound({ chatId: -1001, triggerSenderId: 7, replyToMessageId: 10, isRandomTrigger: false }, finished);

    expect(finished).not.toHaveBeenCalled();
    expect(createStickerSendLock).not.toHaveBeenCalled();
    expect(activeReplyCounts.has(-1001)).toBe(false);
    expect(longTriggerTimes.get(-1001)?.size).toBe(RATE_LIMIT_LONG_MAX_TRIGGERS);
  });
});
