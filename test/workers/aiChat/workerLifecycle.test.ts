import { chatPersonas } from "../../../packages/cache/workers/aiChat/persona";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
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
const pruneStickerCatalogs = mock((_packs: readonly string[]): void => { calls.push("pruneCatalogs"); });
const pruneStickerSets = mock((_packs: readonly string[]): void => { calls.push("pruneSets"); });
mock.module("../../../packages/aiChat/ai/stickers/sets", () => ({ pruneStickerSets }));
const getStickerConfig = mock(() => ({ packs: ["pack"] }));
const adoptStickerConfig = mock((_config: unknown): void => {});
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
const refreshChatMoods = mock((): void => { calls.push("refreshMoods"); });
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/aiChat/ai/stickers/catalog", () => ({
  ensureStickerCatalogs,
  drainStickerCatalogTasks,
  flushDirtyStickerCatalogs,
  hydrateStickerCatalogs,
  pruneStickerCatalogs,
  retryIncompleteStickerCatalogs,
}));
mock.module("../../../packages/config/stickers", () => ({
  adoptStickerConfig,
  getStickerConfig,
}));
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
const recordBotImage = mock((..._args: unknown[]): void => {});
const resolveRepliedBotImage = mock((..._args: unknown[]): void => {});
mock.module("../../../packages/workers/aiChat/botImages", () => ({ recordBotImage, resolveRepliedBotImage }));
mock.module("../../../packages/workers/aiChat/replyPipeline", () => ({
  generateAndSendReply,
  drainPendingReplyQueues,
}));
mock.module("../../../packages/workers/aiChat/replyGeneration", () => ({
  invalidateChatReplies,
  quiesceAiChatReplies,
}));
mock.module("../../../packages/infra/telegram", () => ({ initTelegramClients }));
const handleSynthesizeVoice = mock((..._args: unknown[]): void => { calls.push("synthesizeVoice"); });
const handleCancelVoiceSynthesis = mock((..._args: unknown[]): void => { calls.push("cancelVoiceSynthesis"); });
mock.module("../../../packages/workers/aiChat/voiceSynthesis", () => ({ handleCancelVoiceSynthesis, handleSynthesizeVoice }));
mock.module("../../../packages/aiChat/ai/mood", () => ({ currentMood, refreshChatMoods, switchMood }));
mock.module("../../../packages/infra/logger", () => ({
  acceptForwardedLogBatch: (): boolean => false,
  logger: loggerStub({ error: loggerError }),
}));

const worker = await import("../../../packages/workers/aiChatWorker");
const { botInfoState, superAdminUserIdState, defaultAtmosphereState } = await import("../../../packages/cache/workers/aiChat/identity");
const { stickerMenuRevision } = await import("../../../packages/cache/workers/aiChat/stickers/menu");
const { agentDeploymentConfigCache } = await import("../../../packages/cache/perThread/config");
const { aiCacheUsageSink } = await import("../../../packages/cache/perThread/aiCacheUsage");

/** 主线程投递过来的那一代快照；断言 Worker 原样收进 holder，不另行读盘。 */
const injectedAgentConfig: AgentDeploymentConfig = {
  text: { provider: "google", apiKey: "injected-text-key", baseUrl: undefined, headers: undefined, model: "injected-text" },
  summary: { provider: "openai", apiKey: "injected-summary-key", baseUrl: undefined, headers: undefined, model: "injected-summary" },
  media: { provider: "google", apiKey: "injected-media-key", baseUrl: undefined, headers: undefined, model: "injected-media" },
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
    pruneStickerCatalogs,
    pruneStickerSets,
    getStickerConfig,
    adoptStickerConfig,
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
    recordBotImage,
    resolveRepliedBotImage,
    generateAndSendReply,
    invalidateChatReplies,
    quiesceAiChatReplies,
    initTelegramClients,
    currentMood,
    switchMood,
    refreshChatMoods,
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
      { defaultAtmosphere: "plain",
        type: "init",
        botInfo: { id: 99, first_name: "Ninja", username: "ninja_bot" },
        superAdminUserId: 1,
        agent: injectedAgentConfig,
        mood: { moods: [{ name: "平静", weight: 100, instruction: "平静。" }] },
        stickers: { packs: ["pack"] },
        persona: "测试人设",
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
        type: "record",
        chatId: -1001,
        senderId: 7,
        firstName: "Alice",
        lastName: "",
        username: "alice",
        messageId: 11,
        replyTo: {
          messageId: 5, id: 99, firstName: "Ninja", lastName: "", username: undefined,
          text: "[图片]", quote: undefined, forwardedFrom: undefined,
          botImage: { fileId: "bot-photo", fileUniqueId: "bot-photo-u", caption: "" },
        },
        forwardedFrom: undefined,
        persistImmediately: false,
        text: "这是谁",
      },
      { type: "recordBotImage", chatId: -1001, messageId: 12, caption: "图注", edited: false, persistImmediately: true },
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
      { type: "invalidateChat", chatId: -1001, requestId: 1 },
      { type: "invalidateChat", chatId: -1002, requestId: 2 },
      { type: "queryMood", chatId: -1001, requestId: 3, deadlineAt: Number.MAX_SAFE_INTEGER },
      { type: "switchMood", chatId: -1001, requestId: 4, deadlineAt: Number.MAX_SAFE_INTEGER },
    ];

    const repliedEntry = { messageId: 11 };
    recordChatMessage.mockImplementationOnce((): void => { calls.push("record"); });
    recordChatMessage.mockImplementationOnce(((): unknown => {
      calls.push("record");
      return repliedEntry;
    }) as () => void);
    for (const message of messages) worker.handleAiChatWorkerMessage(message);
    await Bun.sleep(0);

    expect(botInfoState.current?.id).toBe(99);
    expect(superAdminUserIdState.current).toBe(1);
    expect(defaultAtmosphereState.current).toBe("plain");
    // 配置快照进 holder，且是主线程投来的那一个对象本身：本线程此后不读盘。
    expect(agentDeploymentConfigCache.current).toBe(injectedAgentConfig);
    expect(ensureStickerCatalogs).toHaveBeenCalledWith(["pack"]);
    expect(recordChatMessage).toHaveBeenCalledTimes(2);
    expect(resolveRepliedBotImage).toHaveBeenCalledTimes(1);
    expect(resolveRepliedBotImage).toHaveBeenCalledWith(-1001, repliedEntry, { fileId: "bot-photo", fileUniqueId: "bot-photo-u", caption: "" });
    expect(recordBotImage).toHaveBeenCalledWith({ type: "recordBotImage", chatId: -1001, messageId: 12, caption: "图注", edited: false, persistImmediately: true });
    expect(recordChatMedia).toHaveBeenCalledTimes(1);
    expect(flushMemorySnapshot).toHaveBeenNthCalledWith(1, -1001, true);
    expect(flushMemorySnapshot).toHaveBeenNthCalledWith(2, -1001, true);
    expect(flushMemorySnapshot).toHaveBeenNthCalledWith(3, -1001, true);
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
    // invalidateChat 恒带记忆清理：主线程只有「失效并删记忆」这一条路。
    expect(purgeChatMemory).toHaveBeenCalledTimes(2);
    expect(purgeChatMemory).toHaveBeenCalledWith(-1001);
    expect(purgeChatMemory).toHaveBeenCalledWith(-1002);
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryFlushed", flushId: 8 });
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryDeleted", chatId: -1001 });
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryDeleted", chatId: -1002 });
    expect(postMessage).toHaveBeenCalledWith({ type: "chatInvalidated", chatId: -1001, requestId: 1 });
    expect(postMessage).toHaveBeenCalledWith({ type: "chatInvalidated", chatId: -1002, requestId: 2 });
    expect(currentMood).toHaveBeenCalledWith(-1001);
    expect(postMessage).toHaveBeenCalledWith({ type: "moodQueried", chatId: -1001, requestId: 3, moodName: "平静" });
    expect(switchMood).toHaveBeenCalledWith(-1001);
    expect(postMessage).toHaveBeenCalledWith({ type: "moodSwitched", chatId: -1001, requestId: 4, moodName: "开心" });
  });

  test("启动时装上缓存用量出口，把用量作为事件发回主线程；停止时卸下", () => {
    worker.startAiChatWorker();
    const usage = {
      timestamp: 1, capability: "text", provider: "google", model: "m", inputTokens: 10, cachedInputTokens: 0, outputTokens: 1,
    } as const;
    aiCacheUsageSink.current!(usage);
    expect(postMessage).toHaveBeenCalledWith({ type: "aiCacheUsage", usage });
    worker.stopAiChatWorker();
    expect(aiCacheUsageSink.current).toBeNull();
  });

  test("configReload 只替换变化的领域并失效各自的派生状态", () => {
    worker.handleAiChatWorkerMessage({ defaultAtmosphere: "plain",
      type: "init",
      botInfo: { id: 99, first_name: "Ninja", username: "ninja_bot" },
      superAdminUserId: 1,
      agent: injectedAgentConfig,
      mood: { moods: [{ name: "平静", weight: 100, instruction: "平静。" }] },
      stickers: { packs: ["pack"] },
      persona: "测试人设",
    });
    ensureStickerCatalogs.mockClear();
    pruneStickerCatalogs.mockClear();
    adoptStickerConfig.mockClear();

    const reloadedAgent: AgentDeploymentConfig = {
      ...injectedAgentConfig,
      text: { ...injectedAgentConfig.text, model: "reloaded-text" },
    };
    worker.handleAiChatWorkerMessage({ type: "configReload", agent: reloadedAgent, mood: undefined, stickers: undefined });
    expect(agentDeploymentConfigCache.current).toBe(reloadedAgent);
    expect(refreshChatMoods).not.toHaveBeenCalled();
    expect(adoptStickerConfig).not.toHaveBeenCalled();

    const stickers = { packs: ["pack", "new_pack"] };
    const menuRevision: number = stickerMenuRevision.current;
    worker.handleAiChatWorkerMessage({
      type: "configReload",
      agent: undefined,
      mood: { moods: [{ name: "开心", weight: 100, instruction: "开心。" }] },
      stickers,
    });
    expect(agentDeploymentConfigCache.current).toBe(reloadedAgent);
    expect(refreshChatMoods).toHaveBeenCalledTimes(1);
    expect(adoptStickerConfig).toHaveBeenCalledWith(stickers);
    expect(pruneStickerCatalogs).toHaveBeenCalledWith(["pack", "new_pack"]);
    expect(pruneStickerSets).toHaveBeenCalledWith(["pack", "new_pack"]);
    expect(ensureStickerCatalogs).toHaveBeenCalledWith(["pack", "new_pack"]);
    // 配置替换显式失效菜单；即使目录生成与剪枝没有改写条目，revision 仍须递增。
    expect(stickerMenuRevision.current).toBeGreaterThan(menuRevision);
    // 先接管配置、再剪枝、最后启动对账：剪枝用的是新白名单，新加入的包不会被自己剪掉。
    expect(pruneStickerCatalogs.mock.invocationCallOrder[0]!)
      .toBeLessThan(ensureStickerCatalogs.mock.invocationCallOrder[0]!);

    // 停机排空期间只接管快照并剪枝，不再启动贴纸目录对账。
    aiChatWorkerQuiescing.current = true;
    const quiescedRevision: number = stickerMenuRevision.current;
    worker.handleAiChatWorkerMessage({ type: "configReload", agent: undefined, mood: undefined, stickers });
    expect(adoptStickerConfig).toHaveBeenCalledTimes(2);
    expect(pruneStickerCatalogs).toHaveBeenCalledTimes(2);
    expect(stickerMenuRevision.current).toBeGreaterThan(quiescedRevision);
    expect(ensureStickerCatalogs).toHaveBeenCalledTimes(1);
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

  test("语音合成请求与撤回交给 Worker 侧转交模块", () => {
    const synthesize: AiChatWorkerMessage = { type: "synthesizeVoice", requestId: 1, text: "hi", tone: undefined };
    const cancel: AiChatWorkerMessage = { type: "cancelVoiceSynthesis", requestId: 1 };
    worker.handleAiChatWorkerMessage(synthesize);
    worker.handleAiChatWorkerMessage(cancel);
    expect(calls).toEqual(["synthesizeVoice", "cancelVoiceSynthesis"]);
    expect(handleSynthesizeVoice).toHaveBeenCalledWith(synthesize);
    expect(handleCancelVoiceSynthesis).toHaveBeenCalledWith(cancel);
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
    // 白名单剪枝兜住热重载时正在生成、当时跳过的包；必须排在 dirty 上报之前，
    // 已下架包的 dirty 标记才不会换来一次下次启动就被删掉的落盘。
    expect(pruneStickerCatalogs).toHaveBeenCalledWith(["pack"]);
    expect(pruneStickerCatalogs.mock.invocationCallOrder[0]!)
      .toBeLessThan(flushDirtyStickerCatalogs.mock.invocationCallOrder[0]!);
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

test("人设协议按群更新只读使用侧镜像，null 删除群级覆盖", async () => {
  const { handleAiChatWorkerMessage } = await import("../../../packages/workers/aiChatWorker");
  chatPersonas.clear();
  handleAiChatWorkerMessage({ type: "persona", chatId: -1001, persona: "人设一" });
  handleAiChatWorkerMessage({ type: "persona", chatId: -1002, persona: "人设二" });
  expect(chatPersonas.get(-1001)).toBe("人设一");
  handleAiChatWorkerMessage({ type: "persona", chatId: -1001, persona: null });
  expect(chatPersonas.has(-1001)).toBeFalse();
  expect(chatPersonas.get(-1002)).toBe("人设二");
  chatPersonas.clear();
});
