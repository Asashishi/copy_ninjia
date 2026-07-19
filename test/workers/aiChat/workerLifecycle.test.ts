import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiChatWorkerMessage } from "../../../src/types/aiChat/protocol";

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
const workerSelf: {
  onmessage: ((event: MessageEvent<AiChatWorkerMessage>) => void) | null;
  postMessage: typeof postMessage;
} = { onmessage: null, postMessage };
Object.defineProperty(globalThis, "self", { configurable: true, value: workerSelf });

const calls: string[] = [];
const ensureStickerCatalogs = mock((_packs: readonly string[]): void => { calls.push("ensureCatalogs"); });
const flushDirtyStickerCatalogs = mock((emit: (event: unknown) => void): void => {
  calls.push("flushCatalogs");
  emit({ type: "stickerCatalogSnapshot", name: "pack" });
});
const hydrateStickerCatalogs = mock((_catalogs: unknown): void => { calls.push("hydrateCatalogs"); });
const getStickerConfig = mock(() => ({ packs: ["pack"] }));
const startWeatherRefreshLoop = mock((): void => { calls.push("weather"); });
const sweepAiChatReplyCache = mock((_now: number): void => { calls.push("sweep"); });
const sweepImageGenerationCache = mock((_now: number): void => { calls.push("sweepImageGeneration"); });
const flushDirtyMemories = mock((): void => { calls.push("flushMemories"); });
const hydrateMemories = mock((_memories: unknown): void => { calls.push("hydrateMemories"); });
const purgeChatMemory = mock((_chatId: number): void => { calls.push("purgeMemory"); });
const recordChatMessage = mock((..._args: unknown[]): void => { calls.push("record"); });
const recordChatMedia = mock((_message: unknown): void => { calls.push("recordMedia"); });
const generateAndSendReply = mock((..._args: unknown[]): void => { calls.push("trigger"); });
const invalidateChatReplies = mock((_chatId: number): void => { calls.push("invalidate"); });
const initTelegramClients = mock((): void => { calls.push("telegram"); });

mock.module("../../../src/ai/stickers/catalog", () => ({
  ensureStickerCatalogs,
  flushDirtyStickerCatalogs,
  hydrateStickerCatalogs,
}));
mock.module("../../../src/config/stickers", () => ({ getStickerConfig }));
mock.module("../../../src/ai/weather", () => ({ startWeatherRefreshLoop }));
mock.module("../../../src/cache/aiChat/replies", () => ({ sweepAiChatReplyCache }));
mock.module("../../../src/cache/aiChat/imageGeneration", () => ({ sweepImageGenerationCache }));
mock.module("../../../src/workers/aiChat/rollingMemory", () => ({
  flushDirtyMemories,
  hydrateMemories,
  purgeChatMemory,
  recordChatMessage,
}));
mock.module("../../../src/workers/aiChat/mediaIngest", () => ({ recordChatMedia }));
mock.module("../../../src/workers/aiChat/replyPipeline", () => ({ generateAndSendReply, invalidateChatReplies }));
mock.module("../../../src/infra/telegram", () => ({ initTelegramClients }));

const worker = await import("../../../src/workers/aiChatWorker");
const { botInfoState } = await import("../../../src/cache/aiChat/identity");

beforeEach(() => {
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
    sweepAiChatReplyCache,
    sweepImageGenerationCache,
    flushDirtyMemories,
    hydrateMemories,
    purgeChatMemory,
    recordChatMessage,
    recordChatMedia,
    generateAndSendReply,
    invalidateChatReplies,
    initTelegramClients,
  ]) mocked.mockClear();
});

afterAll(() => {
  if (originalSelfDescriptor) Object.defineProperty(globalThis, "self", originalSelfDescriptor);
  else delete (globalThis as { self?: unknown }).self;
});

describe("AI Chat Worker lifecycle", () => {
  test("协议路由覆盖恢复、记录、触发、刷盘与可选记忆清除", () => {
    const messages: AiChatWorkerMessage[] = [
      { type: "init", botInfo: { id: 99, first_name: "Ninja", username: "ninja_bot" } },
      { type: "record", chatId: -1001, senderId: 7, firstName: "Alice", lastName: "", username: "alice", text: "hi" },
      { type: "recordMedia", chatId: -1001, senderId: 7, firstName: "Alice", lastName: "", kind: "photo", fileId: "file", messageId: 10 } as unknown as AiChatWorkerMessage,
      { type: "trigger", chatId: -1001, triggerSenderId: 7, replyToMessageId: 10, isRandomTrigger: false },
      { type: "hydrate", memories: new Map<number, string>() },
      { type: "hydrateStickerCatalog", catalogs: new Map<string, string>() },
      { type: "flushMemory", flushId: 8 },
      { type: "invalidateChat", chatId: -1001, purgeMemory: false },
      { type: "invalidateChat", chatId: -1002, purgeMemory: true },
    ];

    for (const message of messages) worker.handleAiChatWorkerMessage(message);

    expect(botInfoState.current?.id).toBe(99);
    expect(ensureStickerCatalogs).toHaveBeenCalledWith(["pack"]);
    expect(recordChatMessage).toHaveBeenCalledTimes(1);
    expect(recordChatMedia).toHaveBeenCalledTimes(1);
    expect(generateAndSendReply).toHaveBeenCalledWith({
      type: "trigger",
      chatId: -1001,
      triggerSenderId: 7,
      replyToMessageId: 10,
      isRandomTrigger: false,
    });
    expect(hydrateMemories).toHaveBeenCalledTimes(1);
    expect(hydrateStickerCatalogs).toHaveBeenCalledTimes(1);
    expect(invalidateChatReplies).toHaveBeenCalledTimes(2);
    expect(purgeChatMemory).toHaveBeenCalledWith(-1002);
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryFlushed", flushId: 8 });
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryDeleted", chatId: -1002 });
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
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    try {
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
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });
});
