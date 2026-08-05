import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  aiRecordMessageFixture,
  aiReplyReferenceFixture,
  bufferedReplyReferenceFixture,
} from "../../helpers/aiMemoryFixtures";
import type { ReplyPromptSections, ReplyToolContext, ReplyToolset } from "../../../packages/types/aiChat/replies";

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage },
});

const heartbeatStop = mock(async (): Promise<void> => {});
const startChatActionHeartbeat = mock((_chatId: number) => ({
  current: () => "idle" as const,
  set: (_phase: "idle" | "typing" | "upload_photo" | "choose_sticker"): void => {},
  settle: async (): Promise<void> => {},
  stop: heartbeatStop,
}));
const stickerLockRelease = mock((): void => {});
const createStickerSendLock = mock((_chatId: number) => ({
  tryAcquire: (): boolean => true,
  release: stickerLockRelease,
}));
const execute = mock(async (..._args: unknown[]): Promise<string> => JSON.stringify({ success: true }));
let actionsUsed: number = 1;
let capturedContext: ReplyToolContext | null = null;
const createReplyToolset = mock(async (ctx: ReplyToolContext): Promise<ReplyToolset> => {
  capturedContext = ctx;
  return {
    functions: [],
    webSearch: true,
    has: (): boolean => true,
    execute,
    actionsUsed: (): number => actionsUsed,
    isActive: ctx.isActive,
  };
});
const generateReply = mock(async (..._args: unknown[]): Promise<string | null> => "最终正文");
const defaultPromptSections = (): ReplyPromptSections => ({
  referenceMemory: "参考记忆",
  currentConversation: "当前会话",
  replyTask: "回复任务",
});
let builtPromptSections: ReplyPromptSections | null = defaultPromptSections();
const buildReplyPromptSections = mock((..._args: unknown[]): ReplyPromptSections | null => builtPromptSections);
const recordChatMessage = mock((..._args: unknown[]): void => {});
const logError = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/aiChat/ai/chatActionHeartbeat", () => ({ startChatActionHeartbeat }));
mock.module("../../../packages/aiChat/ai/stickers/sendLock", () => ({ createStickerSendLock }));
mock.module("../../../packages/aiChat/ai/tools/replyToolset/orchestrator", () => ({ createReplyToolset }));
mock.module("../../../packages/workers/aiChat/replyModel", () => ({ generateReply }));
mock.module("../../../packages/workers/aiChat/promptContext", () => ({ buildReplyPromptSections }));
mock.module("../../../packages/workers/aiChat/rollingMemory", () => ({ recordChatMessage }));
mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: logError,
  },
}));

const { startReplyRound } = await import("../../../packages/workers/aiChat/replyRound");
const { botInfoState } = await import("../../../packages/cache/workers/aiChat/identity");
const {
  activeReplyCounts,
  cachedReplyGeneration,
  isCachedReplyGenerationCurrent,
  longTriggerTimes,
  rateLimitNoticeTimes,
  replyGenerations,
  resetAiChatReplyCache,
} = await import("../../../packages/cache/workers/aiChat/replies");
const { invalidateChatReplyCache } = await import("../../../packages/cache/workers/aiChat/replies");
const { LinkedQueue } = await import("../../../packages/libs/linkedQueue");
const { RATE_LIMIT_LONG_MAX_TRIGGERS } = await import("../../../packages/consts/aiChat/rateLimit");
const { SUPER_ADMIN_USER_ID } = await import("../../../packages/infra/config");
const { SEND_MESSAGE_TOOL } = await import("../../../packages/consts/tools");

function runRound(overrides: Partial<Parameters<typeof startReplyRound>[0]> = {}): Promise<number> {
  return new Promise((resolve) => {
    startReplyRound({
      chatId: -1001,
      triggerSenderId: 7,
      replyToMessageId: 10,
      imageGenerationRequested: false,
      isRandomTrigger: false,
      ...overrides,
    }, resolve);
  });
}

beforeEach(() => {
  resetAiChatReplyCache();
  botInfoState.current = { id: 99, first_name: "Ninja", username: "ninja_bot" };
  builtPromptSections = defaultPromptSections();
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
  generateReply.mockClear();
  generateReply.mockImplementation(async (): Promise<string | null> => "最终正文");
  buildReplyPromptSections.mockClear();
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
    actionsUsed = 0;
    execute.mockImplementationOnce(async (): Promise<string> => {
      actionsUsed = 1;
      return JSON.stringify({ success: true });
    });
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

  test("非文本动作已成功时忽略尾随正文，文字必须由模型显式调用 send_message", async () => {
    actionsUsed = 1;

    await runRound();

    expect(execute).not.toHaveBeenCalled();
  });

  test("工具发送回调回传消息 ID，并只在代际仍有效时登记滚动记忆", async () => {
    actionsUsed = 2;
    generateReply.mockImplementationOnce(async (): Promise<null> => {
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

  test("实际回复目标已滑出热区时，用轮次捕获的触发快照保留自录回复边", async () => {
    actionsUsed = 1;
    generateReply.mockImplementationOnce(async (): Promise<null> => {
      capturedContext!.onMessageSent("排队后才发出的回复", 104, 555);
      return null;
    });

    await runRound({
      replyToMessageId: 555,
      triggerReference: bufferedReplyReferenceFixture({
        messageId: 555,
        id: 7,
        firstName: "Alice",
        lastName: "Chen",
        username: "alice_dev",
        text: "很早以前排队的触发消息",
        forwardedFrom: "频道 [id:-100666] 东京日报",
      }),
    });

    expect(recordChatMessage).toHaveBeenCalledWith(aiRecordMessageFixture({
      chatId: -1001,
      senderId: 99,
      firstName: "Ninja",
      lastName: "",
      username: "ninja_bot",
      messageId: 104,
      replyTo: aiReplyReferenceFixture({
        messageId: 555,
        id: 7,
        firstName: "Alice",
        lastName: "Chen",
        username: "alice_dev",
        text: "很早以前排队的触发消息",
        forwardedFrom: "频道 [id:-100666] 东京日报",
      }),
      text: "排队后才发出的回复",
    }));
  });

  test("Telegram 未实际挂回复时，即使有触发快照也不建立自录回复边", async () => {
    actionsUsed = 1;
    generateReply.mockImplementationOnce(async (): Promise<null> => {
      capturedContext!.onMessageSent("退化成普通消息", 105, undefined);
      return null;
    });

    await runRound({
      replyToMessageId: 556,
      triggerReference: bufferedReplyReferenceFixture({
        messageId: 556,
        id: 8,
        firstName: "Bob",
        lastName: "",
        text: "已经删除的触发消息",
      }),
    });

    expect(recordChatMessage).toHaveBeenCalledWith(aiRecordMessageFixture({
      chatId: -1001,
      senderId: 99,
      firstName: "Ninja",
      lastName: "",
      username: "ninja_bot",
      messageId: 105,
      text: "退化成普通消息",
    }));
  });

  test("仅 superAdmin 触发的轮次绕过图片生成冷却", async () => {
    await runRound({ triggerSenderId: SUPER_ADMIN_USER_ID });
    expect(capturedContext?.bypassImageGenerationCooldown).toBe(true);

    await runRound({ triggerSenderId: 7 });
    expect(capturedContext?.bypassImageGenerationCooldown).toBe(false);
  });

  test("参考图短期引用原样进入本轮工具上下文", async () => {
    await runRound({
      imageGenerationRequested: true,
      imageGenerationReference: { fileId: "reference-file", fileUniqueId: "reference-unique", width: 1600, height: 900 },
    });

    expect(capturedContext?.imageGenerationReference).toEqual({
      fileId: "reference-file",
      fileUniqueId: "reference-unique",
      width: 1600,
      height: 900,
    });
  });

  test("自动文字回复与随机媒体评价即使被误传资格，也会强制关闭生图", async () => {
    const reference = { fileId: "must-drop", fileUniqueId: "must-drop-unique", width: 512, height: 512 };

    await runRound({
      isRandomTrigger: true,
      imageGenerationRequested: true,
      imageGenerationReference: reference,
    });
    expect(capturedContext?.imageGenerationRequested).toBe(false);
    expect(capturedContext?.imageGenerationReference).toBeUndefined();

    await runRound({
      imageGenerationRequested: true,
      imageGenerationReference: reference,
      mediaComment: { kind: "photo", senderId: 7, senderName: "Alice", description: "一张夜景" },
    });
    expect(capturedContext?.imageGenerationRequested).toBe(false);
    expect(capturedContext?.imageGenerationReference).toBeUndefined();
  });

  test("用户直接叫机器人的媒体轮仍可把生图资格交给模型判断", async () => {
    await runRound({
      imageGenerationRequested: true,
      mediaComment: {
        kind: "sticker",
        senderId: 7,
        senderName: "Alice",
        description: "一枚猫猫贴纸",
        directTriggerReason: "mention",
      },
    });

    expect(capturedContext?.imageGenerationRequested).toBe(true);
  });

  test("仅回复或 @ 直接触发把发送者 id 交给唤起者重点区块", async () => {
    await runRound({ triggerSenderId: 7 });
    expect(buildReplyPromptSections.mock.calls.at(-1)?.[2]).toEqual(
      expect.objectContaining({ directInvokerId: 7 })
    );

    await runRound({ triggerSenderId: 8, isRandomTrigger: true });
    expect(buildReplyPromptSections.mock.calls.at(-1)?.[2]).not.toHaveProperty("directInvokerId");

    await runRound({
      triggerSenderId: 9,
      mediaComment: { kind: "photo", senderId: 9, senderName: "Carol", description: "一张夜景" },
    });
    expect(buildReplyPromptSections.mock.calls.at(-1)?.[2]).not.toHaveProperty("directInvokerId");

    await runRound({
      triggerSenderId: 10,
      mediaComment: {
        kind: "photo",
        senderId: 10,
        senderName: "Dave",
        description: "一张夜景",
        directTriggerReason: "reply",
      },
    });
    expect(buildReplyPromptSections.mock.calls.at(-1)?.[2]).toEqual(
      expect.objectContaining({ directInvokerId: 10 })
    );
  });

  test("构造上下文失败仍释放贴纸锁与并发位，但不会启动心跳", async () => {
    builtPromptSections = null;

    await runRound();

    expect(startChatActionHeartbeat).not.toHaveBeenCalled();
    expect(stickerLockRelease).toHaveBeenCalledTimes(1);
    expect(activeReplyCounts.has(-1001)).toBe(false);
  });

  test("生成异常也会停止心跳、释放锁并完成轮次", async () => {
    generateReply.mockRejectedValueOnce(new Error("generation failed"));

    await runRound();
    await Promise.resolve();

    expect(heartbeatStop).toHaveBeenCalledTimes(1);
    expect(stickerLockRelease).toHaveBeenCalledTimes(1);
    expect(activeReplyCounts.has(-1001)).toBe(false);
    expect(logError).toHaveBeenCalledWith("Error in AI reply task:", expect.any(Error));
  });

  test("唯一 epoch 允许回收大量历史群，旧任务也不会在群重新启用后复活", () => {
    const captured: number = cachedReplyGeneration(-1001);
    invalidateChatReplyCache(-1001);
    expect(replyGenerations.has(-1001)).toBe(false);
    expect(isCachedReplyGenerationCurrent(-1001, captured)).toBe(false);

    // 每个群都先真正捕获 epoch，再模拟 disable/teardown；历史项应全部释放。
    for (let chatId: number = -9000; chatId > -14_000; chatId--) {
      cachedReplyGeneration(chatId);
      invalidateChatReplyCache(chatId);
    }

    expect(replyGenerations.size).toBe(0);
    const replacement: number = cachedReplyGeneration(-1001);
    expect(replacement).not.toBe(captured);
    expect(isCachedReplyGenerationCurrent(-1001, captured)).toBe(false);
  });

  test("捕获代际已失效或身份尚未初始化时不占用任何资源", () => {
    invalidateChatReplyCache(-1001);
    const finished = mock((_chatId: number): void => {});
    startReplyRound({
      chatId: -1001,
      triggerSenderId: 7,
      replyToMessageId: 10,
      imageGenerationRequested: false,
      isRandomTrigger: false,
      generation: 0,
    }, finished);
    botInfoState.current = null;
    startReplyRound({
      chatId: -1002,
      triggerSenderId: 8,
      replyToMessageId: 11,
      imageGenerationRequested: false,
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

    startReplyRound({
      chatId: -1001,
      triggerSenderId: 7,
      replyToMessageId: 10,
      imageGenerationRequested: false,
      isRandomTrigger: false,
    }, finished);

    expect(finished).not.toHaveBeenCalled();
    expect(createStickerSendLock).not.toHaveBeenCalled();
    expect(activeReplyCounts.has(-1001)).toBe(false);
    expect(longTriggerTimes.get(-1001)?.size).toBe(RATE_LIMIT_LONG_MAX_TRIGGERS);
  });

  test("长窗口在上限时遇到时钟回拨，清空旧时间轴并正常开启新轮", async () => {
    const now: number = Date.now();
    const times = new LinkedQueue<number>();
    for (let index: number = 0; index < RATE_LIMIT_LONG_MAX_TRIGGERS; index++) {
      times.push(now + 60_000 + index);
    }
    longTriggerTimes.set(-1001, times);

    await expect(runRound()).resolves.toBe(-1001);

    expect(createReplyToolset).toHaveBeenCalledTimes(1);
    expect(longTriggerTimes.get(-1001)?.size).toBe(1);
    expect(longTriggerTimes.get(-1001)?.peek()).toBeLessThan(now + 60_000);
  });
});
