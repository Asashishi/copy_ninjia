import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiChatWorkerMessage } from "../../../packages/types/aiChat/protocol";

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
const workerSelf: {
  onmessage: ((event: MessageEvent<AiChatWorkerMessage>) => void) | null;
  postMessage: typeof postMessage;
} = { onmessage: null, postMessage };
Object.defineProperty(globalThis, "self", { configurable: true, value: workerSelf });

const calls: string[] = [];
const ensureStickerCatalogs = mock((_packs: readonly string[]): void => { calls.push("ensureCatalogs"); });
const retryIncompleteStickerCatalogs = mock((_packs: readonly string[], _now?: number): void => {
  calls.push("retryCatalogs");
});
const flushDirtyStickerCatalogs = mock((emit: (event: unknown) => void): void => {
  calls.push("flushCatalogs");
  emit({ type: "stickerCatalogSnapshot", name: "pack" });
});
const hydrateStickerCatalogs = mock((_catalogs: unknown): void => { calls.push("hydrateCatalogs"); });
const getStickerConfig = mock(() => ({ packs: ["pack"] }));
const startWeatherRefreshLoop = mock((): void => { calls.push("weather"); });
const stopWeatherRefreshLoop = mock((): void => { calls.push("stopWeather"); });
const sweepAiChatReplyCache = mock((_now: number): void => { calls.push("sweep"); });
const sweepImageGenerationCache = mock((_now: number): void => { calls.push("sweepImageGeneration"); });
const flushDirtyMemories = mock((): void => { calls.push("flushMemories"); });
const flushMemorySnapshot = mock((_chatId: number, _persistImmediately?: boolean): void => {
  calls.push("flushMemorySnapshot");
});
const hydrateMemories = mock((_memories: unknown): void => { calls.push("hydrateMemories"); });
const purgeChatMemory = mock((_chatId: number): void => { calls.push("purgeMemory"); });
const recordChatMessage = mock((..._args: unknown[]): void => { calls.push("record"); });
const recordChatMedia = mock((_message: unknown): void => { calls.push("recordMedia"); });
const generateAndSendReply = mock((..._args: unknown[]): void => { calls.push("trigger"); });
const drainPendingReplyQueues = mock((_now: number): void => { calls.push("drainReplyQueues"); });
const invalidateChatReplies = mock(async (_chatId: number): Promise<void> => {
  calls.push("invalidate");
});
const initTelegramClients = mock((): void => { calls.push("telegram"); });
const switchMood = mock((_chatId: number) => ({ name: "开心", weight: 1, instruction: "" }));

mock.module("../../../packages/ai/stickers/catalog", () => ({
  ensureStickerCatalogs,
  flushDirtyStickerCatalogs,
  hydrateStickerCatalogs,
  retryIncompleteStickerCatalogs,
}));
mock.module("../../../packages/config/stickers", () => ({ getStickerConfig }));
mock.module("../../../packages/ai/weather", () => ({ startWeatherRefreshLoop, stopWeatherRefreshLoop }));
mock.module("../../../packages/cache/aiChat/replies", () => ({ sweepAiChatReplyCache }));
mock.module("../../../packages/cache/aiChat/imageGeneration", () => ({ sweepImageGenerationCache }));
mock.module("../../../packages/workers/aiChat/rollingMemory", () => ({
  flushDirtyMemories,
  flushMemorySnapshot,
  hydrateMemories,
  purgeChatMemory,
  recordChatMessage,
}));
mock.module("../../../packages/workers/aiChat/mediaIngest", () => ({ recordChatMedia }));
mock.module("../../../packages/workers/aiChat/replyPipeline", () => ({
  generateAndSendReply,
  invalidateChatReplies,
  drainPendingReplyQueues,
}));
mock.module("../../../packages/infra/telegram", () => ({ initTelegramClients }));
mock.module("../../../packages/ai/mood", () => ({ switchMood }));

const worker = await import("../../../packages/workers/aiChatWorker");
const { botInfoState } = await import("../../../packages/cache/aiChat/identity");

beforeEach(() => {
  worker.stopAiChatWorker();
  calls.length = 0;
  postMessage.mockClear();
  workerSelf.onmessage = null;
  botInfoState.current = null;
  for (const mocked of [
    ensureStickerCatalogs,
    flushDirtyStickerCatalogs,
    hydrateStickerCatalogs,
    getStickerConfig,
    startWeatherRefreshLoop,
    stopWeatherRefreshLoop,
    sweepAiChatReplyCache,
    sweepImageGenerationCache,
    flushDirtyMemories,
    flushMemorySnapshot,
    hydrateMemories,
    purgeChatMemory,
    recordChatMessage,
    recordChatMedia,
    generateAndSendReply,
    invalidateChatReplies,
    initTelegramClients,
    switchMood,
  ]) mocked.mockClear();
});

afterAll(() => {
  if (originalSelfDescriptor) Object.defineProperty(globalThis, "self", originalSelfDescriptor);
  else delete (globalThis as { self?: unknown }).self;
});

describe("AI Chat Worker lifecycle", () => {
  test("协议路由覆盖恢复、记录、触发、刷盘与可选记忆清除", async () => {
    const messages: AiChatWorkerMessage[] = [
      { type: "init", botInfo: { id: 99, first_name: "Ninja", username: "ninja_bot" } },
      {
        type: "record",
        chatId: -1001,
        senderId: 7,
        firstName: "Alice",
        lastName: "",
        username: "alice",
        messageId: 9,
        text: "hi",
        persistImmediately: true,
      },
      {
        type: "recordMedia",
        chatId: -1001,
        senderId: 7,
        firstName: "Alice",
        lastName: "",
        kind: "photo",
        fileId: "file",
        messageId: 10,
        persistImmediately: true,
      } as unknown as AiChatWorkerMessage,
      {
        type: "trigger",
        chatId: -1001,
        triggerSenderId: 7,
        replyToMessageId: 10,
        isRandomTrigger: false,
        imageGenerationRequested: true,
        imageGenerationReference: { fileId: "reference-file", fileUniqueId: "reference-unique", width: 1600, height: 900 },
      },
      { type: "hydrate", memories: new Map<number, string>() },
      { type: "hydrateStickerCatalog", catalogs: new Map<string, string>() },
      { type: "flushMemory", flushId: 8 },
      { type: "invalidateChat", chatId: -1001, purgeMemory: false, requestId: 1 },
      { type: "invalidateChat", chatId: -1002, purgeMemory: true, requestId: 2 },
      { type: "switchMood", chatId: -1001, requestId: 3, deadlineAt: Number.MAX_SAFE_INTEGER },
    ];

    for (const message of messages) worker.handleAiChatWorkerMessage(message);
    await Promise.resolve();

    expect(botInfoState.current?.id).toBe(99);
    expect(ensureStickerCatalogs).toHaveBeenCalledWith(["pack"]);
    expect(recordChatMessage).toHaveBeenCalledTimes(1);
    expect(recordChatMedia).toHaveBeenCalledTimes(1);
    expect(flushMemorySnapshot).toHaveBeenNthCalledWith(1, -1001, true);
    expect(flushMemorySnapshot).toHaveBeenNthCalledWith(2, -1001, true);
    expect(generateAndSendReply).toHaveBeenCalledWith({
      type: "trigger",
      chatId: -1001,
      triggerSenderId: 7,
      replyToMessageId: 10,
      isRandomTrigger: false,
      imageGenerationRequested: true,
      imageGenerationReference: { fileId: "reference-file", fileUniqueId: "reference-unique", width: 1600, height: 900 },
    });
    expect(hydrateMemories).toHaveBeenCalledTimes(1);
    expect(hydrateStickerCatalogs).toHaveBeenCalledTimes(1);
    expect(invalidateChatReplies).toHaveBeenCalledTimes(2);
    expect(purgeChatMemory).toHaveBeenCalledWith(-1002);
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryFlushed", flushId: 8 });
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryDeleted", chatId: -1002 });
    expect(postMessage).toHaveBeenCalledWith({ type: "chatInvalidated", chatId: -1001, requestId: 1 });
    expect(postMessage).toHaveBeenCalledWith({ type: "chatInvalidated", chatId: -1002, requestId: 2 });
    expect(switchMood).toHaveBeenCalledWith(-1001);
    expect(postMessage).toHaveBeenCalledWith({ type: "moodSwitched", chatId: -1001, requestId: 3, moodName: "开心" });
  });

  test("过期的 switchMood 请求不再迟到改写心情", () => {
    worker.handleAiChatWorkerMessage({
      type: "switchMood",
      chatId: -1001,
      requestId: 4,
      deadlineAt: 0,
    });

    expect(switchMood).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("统一维护周期清理限频缓存并上报两类 dirty 快照", () => {
    worker.runAiChatWorkerMaintenance(1234);

    expect(sweepAiChatReplyCache).toHaveBeenCalledWith(1234);
    expect(sweepImageGenerationCache).toHaveBeenCalledWith(1234);
    expect(flushDirtyMemories).toHaveBeenCalledTimes(1);
    expect(flushDirtyStickerCatalogs).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: "stickerCatalogSnapshot", name: "pack" });
  });

  test("显式启动只在 Worker 入口安装 handler、维护 timer 与天气刷新", () => {
    const originalSetInterval: typeof setInterval = globalThis.setInterval;
    let maintenance: (() => void) | null = null;
    globalThis.setInterval = ((handler: (...args: unknown[]) => void): ReturnType<typeof setInterval> => {
      maintenance = handler as () => void;
      return { unref(): void {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    try {
      worker.startAiChatWorker();
      worker.startAiChatWorker();
      expect(initTelegramClients).toHaveBeenCalledTimes(1);
      expect(startWeatherRefreshLoop).toHaveBeenCalledTimes(1);
      expect(workerSelf.onmessage).not.toBeNull();
      expect(maintenance).not.toBeNull();

      workerSelf.onmessage!({
        data: { type: "record", chatId: -1003, senderId: 8, firstName: "Bob", lastName: "", text: "hello" },
      } as MessageEvent<AiChatWorkerMessage>);
      maintenance!();
      expect(recordChatMessage).toHaveBeenCalledTimes(1);
      expect(sweepAiChatReplyCache).toHaveBeenCalledTimes(1);
      expect(sweepImageGenerationCache).toHaveBeenCalledTimes(1);
      worker.stopAiChatWorker();
      expect(workerSelf.onmessage).toBeNull();
      expect(stopWeatherRefreshLoop).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });
});
