import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiChatWorkerMessage } from "../../../packages/types/aiChat/protocol";
import type { AgentDeploymentConfig } from "../../../packages/types/config";

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
const workerSelf: {
  onmessage: ((event: MessageEvent<AiChatWorkerMessage>) => void) | null;
  postMessage: typeof postMessage;
} = { onmessage: null, postMessage };
Object.defineProperty(globalThis, "self", { configurable: true, value: workerSelf });

const calls: string[] = [];
const ensureStickerCatalogs = mock((_packs: readonly string[]): void => { calls.push("ensureCatalogs"); });
const drainStickerCatalogTasks = mock(async (): Promise<void> => { calls.push("drainCatalogs"); });
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
const quiesceAiChatReplies = mock(async (): Promise<void> => { calls.push("drainReplies"); });
const initTelegramClients = mock((): void => { calls.push("telegram"); });
const currentMood = mock((_chatId: number) => ({ name: "平静", weight: 1, instruction: "" }));
const switchMood = mock((_chatId: number) => ({ name: "开心", weight: 1, instruction: "" }));
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/aiChat/ai/stickers/catalog", () => ({
  ensureStickerCatalogs,
  drainStickerCatalogTasks,
  flushDirtyStickerCatalogs,
  hydrateStickerCatalogs,
  retryIncompleteStickerCatalogs,
}));
mock.module("../../../packages/config/stickers", () => ({ getStickerConfig }));
mock.module("../../../packages/aiChat/ai/weather", () => ({ startWeatherRefreshLoop, stopWeatherRefreshLoop }));
mock.module("../../../packages/cache/workers/aiChat/replies", () => ({ sweepAiChatReplyCache }));
mock.module("../../../packages/cache/workers/aiChat/imageGeneration", () => ({ sweepImageGenerationCache }));
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
  quiesceAiChatReplies,
  drainPendingReplyQueues,
}));
mock.module("../../../packages/infra/telegram", () => ({ initTelegramClients }));
mock.module("../../../packages/aiChat/ai/mood", () => ({ currentMood, switchMood }));
mock.module("../../../packages/infra/logger", () => ({
  acceptForwardedLogBatch: (): boolean => false,
  logger: { log(): void {}, info(): void {}, warn(): void {}, error: loggerError },
}));

const worker = await import("../../../packages/workers/aiChatWorker");
const { botInfoState, superAdminUserIdState } = await import("../../../packages/cache/workers/aiChat/identity");
const { agentDeploymentConfigCache } = await import("../../../packages/cache/perThread/config");

/** 主线程投递过来的那一代快照；断言 Worker 原样收进 holder，不另行读盘。 */
const injectedAgentConfig: AgentDeploymentConfig = {
  text: { provider: "google", apiKey: "injected-text-key", baseUrl: undefined, model: "injected-text" },
  summary: { provider: "openai", apiKey: "injected-summary-key", baseUrl: undefined, model: "injected-summary" },
  media: { provider: "google", apiKey: "injected-media-key", baseUrl: undefined, model: "injected-media" },
};
const { aiChatWorkerAbortController, aiChatWorkerDrain, aiChatWorkerQuiescing } =
  await import("../../../packages/cache/workers/aiChat/worker");

beforeEach(() => {
  worker.stopAiChatWorker();
  calls.length = 0;
  postMessage.mockClear();
  workerSelf.onmessage = null;
  botInfoState.current = null;
  superAdminUserIdState.current = null;
  // 新 isolate 的 holder 本来就是空的：init 之前取配置必须 fail-closed。
  agentDeploymentConfigCache.current = null;
  aiChatWorkerQuiescing.current = false;
  aiChatWorkerAbortController.current = new AbortController();
  aiChatWorkerDrain.current = null;
  for (const mocked of [
    ensureStickerCatalogs,
    drainStickerCatalogTasks,
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
    quiesceAiChatReplies,
    initTelegramClients,
    currentMood,
    switchMood,
    loggerError,
  ]) mocked.mockClear();
  quiesceAiChatReplies.mockImplementation(async (): Promise<void> => { calls.push("drainReplies"); });
  drainStickerCatalogTasks.mockImplementation(async (): Promise<void> => { calls.push("drainCatalogs"); });
});

afterAll(() => {
  if (originalSelfDescriptor) Object.defineProperty(globalThis, "self", originalSelfDescriptor);
  else delete (globalThis as { self?: unknown }).self;
});

describe("AI Chat Worker lifecycle", () => {
  test("协议路由覆盖恢复、记录、触发、刷盘与可选记忆清除", async () => {
    const messages: AiChatWorkerMessage[] = [
      {
        type: "init",
        botInfo: { id: 99, first_name: "Ninja", username: "ninja_bot" },
        superAdminUserId: 1,
        agent: injectedAgentConfig,
      },
      {
        type: "record",
        chatId: -1001,
        senderId: 7,
        firstName: "Alice",
        lastName: "",
        username: "alice",
        messageId: 9,
        replyTo: undefined,
        forwardedFrom: undefined,
        persistImmediately: true,
        text: "hi",
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
        messageThreadId: undefined,
        chatId: -1001,
        triggerSenderId: 7,
        replyToMessageId: 10,
        isRandomTrigger: false,
        telegramBackpressured: true,
        imageGenerationRequested: true,
        imageGenerationReference: { fileId: "reference-file", fileUniqueId: "reference-unique", width: 1600, height: 900 },
      },
      { type: "hydrate", memories: new Map<number, string>() },
      { type: "hydrateStickerCatalog", catalogs: new Map<string, string>() },
      { type: "flushMemory", flushId: 8 },
      { type: "invalidateChat", chatId: -1001, purgeMemory: false, requestId: 1 },
      { type: "invalidateChat", chatId: -1002, purgeMemory: true, requestId: 2 },
      { type: "queryMood", chatId: -1001, requestId: 3, deadlineAt: Number.MAX_SAFE_INTEGER },
      { type: "switchMood", chatId: -1001, requestId: 4, deadlineAt: Number.MAX_SAFE_INTEGER },
    ];

    for (const message of messages) worker.handleAiChatWorkerMessage(message);
    await Bun.sleep(0);

    expect(botInfoState.current?.id).toBe(99);
    expect(superAdminUserIdState.current).toBe(1);
    // 配置快照进 holder，且是主线程投来的那一个对象本身：本线程此后不读盘。
    expect(agentDeploymentConfigCache.current).toBe(injectedAgentConfig);
    expect(ensureStickerCatalogs).toHaveBeenCalledWith(["pack"]);
    expect(recordChatMessage).toHaveBeenCalledTimes(1);
    expect(recordChatMedia).toHaveBeenCalledTimes(1);
    expect(flushMemorySnapshot).toHaveBeenNthCalledWith(1, -1001, true);
    expect(flushMemorySnapshot).toHaveBeenNthCalledWith(2, -1001, true);
    expect(generateAndSendReply).toHaveBeenCalledWith({
      type: "trigger",
      messageThreadId: undefined,
      chatId: -1001,
      triggerSenderId: 7,
      replyToMessageId: 10,
      isRandomTrigger: false,
      telegramBackpressured: true,
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
    expect(currentMood).toHaveBeenCalledWith(-1001);
    expect(postMessage).toHaveBeenCalledWith({ type: "moodQueried", chatId: -1001, requestId: 3, moodName: "平静" });
    expect(switchMood).toHaveBeenCalledWith(-1001);
    expect(postMessage).toHaveBeenCalledWith({ type: "moodSwitched", chatId: -1001, requestId: 4, moodName: "开心" });
  });

  test("hydrate decoder 失败时异常离开消息边界，由 Worker supervisor 接管", () => {
    hydrateMemories.mockImplementationOnce((): void => {
      throw new Error("AI memory hydrate payload: $ must be the current schema.");
    });
    expect((): void => worker.handleAiChatWorkerMessage({
      type: "hydrate",
      memories: new Map([[-1001, "bad"]]),
    })).toThrow("AI memory hydrate payload: $ must be the current schema.");

    hydrateStickerCatalogs.mockImplementationOnce((): void => {
      throw new Error("Sticker catalog hydrate payload: $ must be the current schema.");
    });
    expect((): void => worker.handleAiChatWorkerMessage({
      type: "hydrateStickerCatalog",
      catalogs: new Map([["pack", "bad"]]),
    })).toThrow("Sticker catalog hydrate payload: $ must be the current schema.");
  });

  test("flush 等回复与贴纸目录任务全部结算后才上报最终快照", async () => {
    const workerSignal: AbortSignal = aiChatWorkerAbortController.current.signal;
    let releaseReplies: (() => void) | undefined;
    let releaseCatalogs: (() => void) | undefined;
    quiesceAiChatReplies.mockImplementationOnce((): Promise<void> =>
      new Promise<void>((resolve: () => void): void => { releaseReplies = resolve; }));
    drainStickerCatalogTasks.mockImplementationOnce((): Promise<void> =>
      new Promise<void>((resolve: () => void): void => { releaseCatalogs = resolve; }));

    worker.handleAiChatWorkerMessage({ type: "flushMemory", flushId: 9 });
    expect(workerSignal.aborted).toBeTrue();
    worker.handleAiChatWorkerMessage({
      type: "trigger",
      messageThreadId: undefined,
      chatId: -1001,
      triggerSenderId: 7,
      replyToMessageId: 10,
      isRandomTrigger: false,
      telegramBackpressured: false,
      imageGenerationRequested: false,
    });
    await Promise.resolve();

    expect(generateAndSendReply).not.toHaveBeenCalled();
    expect(flushDirtyMemories).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalledWith({ type: "memoryFlushed", flushId: 9 });

    releaseReplies!();
    await Promise.resolve();
    expect(flushDirtyMemories).not.toHaveBeenCalled();

    releaseCatalogs!();
    await Bun.sleep(0);
    expect(flushDirtyMemories).toHaveBeenCalledTimes(1);
    expect(flushDirtyStickerCatalogs).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryFlushed", flushId: 9 });
  });

  test("flush 阶段单项拒绝仍等待另一项结算，并按阶段名留下聚合诊断", async () => {
    const failure: Error = new Error("reply drain failed");
    let releaseCatalogs: (() => void) | undefined;
    quiesceAiChatReplies.mockRejectedValueOnce(failure);
    drainStickerCatalogTasks.mockImplementationOnce((): Promise<void> =>
      new Promise<void>((resolve: () => void): void => { releaseCatalogs = resolve; }));

    worker.handleAiChatWorkerMessage({ type: "flushMemory", flushId: 10 });
    await Promise.resolve();

    expect(drainStickerCatalogTasks).toHaveBeenCalledTimes(1);
    expect(loggerError).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalledWith({ type: "memoryFlushed", flushId: 10 });

    releaseCatalogs!();
    await Bun.sleep(0);
    expect(loggerError).toHaveBeenCalledWith(
      "AI Worker flush 10 rejected before acknowledgement:",
      expect.any(AggregateError)
    );
    const aggregate: AggregateError = loggerError.mock.calls[0]?.[1] as AggregateError;
    expect((aggregate.errors[0] as Error).message).toContain("reply generation");
    expect(flushDirtyMemories).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalledWith({ type: "memoryFlushed", flushId: 10 });
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

  test("过期的 queryMood 请求不再读取或初始化心情", () => {
    worker.handleAiChatWorkerMessage({
      type: "queryMood",
      chatId: -1001,
      requestId: 5,
      deadlineAt: 0,
    });

    expect(currentMood).not.toHaveBeenCalled();
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

  test("显式启动只安装双工 handler、维护 timer 与天气刷新，不初始化 Telegram 客户端", () => {
    const originalSetInterval: typeof setInterval = globalThis.setInterval;
    let maintenance: (() => void) | null = null;
    globalThis.setInterval = ((handler: (...args: unknown[]) => void): ReturnType<typeof setInterval> => {
      maintenance = handler as () => void;
      return { unref(): void {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    try {
      worker.startAiChatWorker();
      worker.startAiChatWorker();
      expect(initTelegramClients).not.toHaveBeenCalled();
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
