import { adoptTimeZone, getTimeZone } from "../../../packages/config/time";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { TOKYO_TIME_ZONE } from "../../../packages/consts/time";
import type { AiChatWorkerMessage } from "../../../packages/types/aiChat/protocol";
import type { AgentDeploymentConfig } from "../../../packages/types/config";

const INITIAL_TIME_ZONE: string = getTimeZone();
afterEach((): void => { adoptTimeZone(INITIAL_TIME_ZONE); });

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
const recordChatMessage = mock((..._args: unknown[]): void => { calls.push("record"); });
const recordChatMedia = mock((_message: unknown): void => { calls.push("recordMedia"); });
const generateAndSendReply = mock((..._args: unknown[]): void => { calls.push("trigger"); });
const drainPendingReplyQueues = mock((_now: number): void => { calls.push("drainReplyQueues"); });
const invalidateChatReplies = mock(async (_chatId: number): Promise<void> => {
  calls.push("invalidate");
});
const quiesceAiChatReplies = mock(async (): Promise<void> => { calls.push("drainReplies"); });
const initTelegramClients = mock((): void => { calls.push("telegram"); });
const currentMood = mock(() => ({ name: "平静", weight: 1, instruction: "" }));
const switchMood = mock(() => ({ name: "开心", weight: 1, instruction: "" }));
const refreshMood = mock((): void => {});
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
mock.module("../../../packages/aiChat/ai/mood", () => ({ currentMood, refreshMood, switchMood }));
mock.module("../../../packages/infra/logger", () => ({
  acceptForwardedLogBatch: (): boolean => false,
  logger: loggerStub({ error: loggerError }),
}));

const worker = await import("../../../packages/workers/aiChatWorker");
const { botInfoState, superAdminUserIdState, atmosphereState } = await import("../../../packages/cache/workers/aiChat/identity");
const { stickerMenuRevision } = await import("../../../packages/cache/workers/aiChat/stickers/menu");
const { agentDeploymentConfigCache, personaCache, voiceToolPromptCache } = await import("../../../packages/cache/perThread/config");
const { aiCacheUsageSink } = await import("../../../packages/cache/perThread/aiCacheUsage");
const { hasChatMemory, pendingSummaries, resetAiChatMemoryCache } = await import("../../../packages/cache/workers/aiChat/memory");

/** 主线程投递的那一代快照；断言 Worker 原样收进 holder。 */
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
  // 新 isolate 的 holder 为空：init 之前取配置 fail-closed。
  agentDeploymentConfigCache.current = null;
  aiChatWorkerQuiescing.current = false;
  aiChatWorkerAbortController.current = new AbortController();
  aiChatWorkerDrain.current = null;
  resetAiChatMemoryCache();
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
    refreshMood,
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
  /** 每条协议路由用例都先送这一条 init，与主线程重放顺序一致。 */
  const INIT_MESSAGE: AiChatWorkerMessage = {
    atmosphere: "plain",
    type: "init",
    timeZone: "UTC",
    botInfo: { id: 99, first_name: "Ninja", username: "ninja_bot" },
    superAdminUserId: 1,
    agent: injectedAgentConfig,
    mood: { moods: [{ name: "平静", weight: 100, instruction: "平静。" }] },
    stickers: { packs: ["pack"] },
    persona: "测试人设",
    voiceToolPrompt: "测试语音说明",
  };

  /** 先 init，再依次投递 messages，并让同步路由排出的微任务跑完。 */
  async function routeAfterInit(messages: readonly AiChatWorkerMessage[]): Promise<void> {
    worker.handleAiChatWorkerMessage(INIT_MESSAGE);
    for (const message of messages) worker.handleAiChatWorkerMessage(message);
    await Bun.sleep(0);
  }

  test("只有启动时区为东京时 init 才启动东京天气刷新", async () => {
    startWeatherRefreshLoop.mockClear();
    await routeAfterInit([]);
    expect(startWeatherRefreshLoop).not.toHaveBeenCalled();

    worker.handleAiChatWorkerMessage({ ...INIT_MESSAGE, timeZone: TOKYO_TIME_ZONE });
    expect(startWeatherRefreshLoop).toHaveBeenCalledTimes(1);
    worker.handleAiChatWorkerMessage({ ...INIT_MESSAGE, timeZone: "UTC" });
  });

  test("init 接管身份、时区、人设与主线程投来的配置快照，并按贴纸白名单补目录", async () => {
    await routeAfterInit([]);

    expect(botInfoState.current?.id).toBe(99);
    expect(superAdminUserIdState.current).toBe(1);
    expect(atmosphereState.current).toBe("plain");
    expect(getTimeZone()).toBe("UTC");
    // 本进程人设与 send_voice 说明随 init 接管，所有群共用这一份。
    expect(personaCache.current).toBe("测试人设");
    expect(voiceToolPromptCache.current).toBe("测试语音说明");
    // 配置快照进 holder，且是主线程投来的那一个对象本身。
    expect(agentDeploymentConfigCache.current).toBe(injectedAgentConfig);
    expect(ensureStickerCatalogs).toHaveBeenCalledWith(["pack"]);
  });

  test("记录类消息交给各自的记录器，回复 bot 图片时解析被回复的图，要求立即落盘的才刷快照", async () => {
    const repliedEntry = { messageId: 11 };
    recordChatMessage.mockImplementationOnce((): void => { calls.push("record"); });
    recordChatMessage.mockImplementationOnce(((): unknown => {
      calls.push("record");
      return repliedEntry;
    }) as () => void);
    await routeAfterInit([
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
    ]);

    expect(recordChatMessage).toHaveBeenCalledTimes(2);
    expect(resolveRepliedBotImage).toHaveBeenCalledTimes(1);
    expect(resolveRepliedBotImage).toHaveBeenCalledWith(-1001, repliedEntry, { fileId: "bot-photo", fileUniqueId: "bot-photo-u", caption: "" });
    expect(recordBotImage).toHaveBeenCalledWith({ type: "recordBotImage", chatId: -1001, messageId: 12, caption: "图注", edited: false, persistImmediately: true });
    expect(recordChatMedia).toHaveBeenCalledTimes(1);
    expect(flushMemorySnapshot).toHaveBeenCalledTimes(3);
    expect(flushMemorySnapshot.mock.calls.every((call: unknown[]): boolean => call[0] === -1001 && call[1] === true)).toBeTrue();
  });

  test("trigger 原样交给回复生成", async () => {
    const trigger: AiChatWorkerMessage = {
      type: "trigger",
      messageThreadId: undefined,
      chatId: -1001,
      triggerSenderId: 7,
      replyToMessageId: 10,
      isRandomTrigger: false,
      telegramBackpressured: true,
      imageGenerationRequested: true,
      imageGenerationReference: { fileId: "reference-file", fileUniqueId: "reference-unique", width: 1600, height: 900 },
      chatQa: undefined,
    };
    await routeAfterInit([trigger]);
    expect(generateAndSendReply).toHaveBeenCalledWith(trigger);
  });

  test("hydrate 两类快照各接管一次，flushMemory 回 memoryFlushed", async () => {
    await routeAfterInit([
      { type: "hydrate", memories: new Map<number, string>() },
      { type: "hydrateStickerCatalog", catalogs: new Map<string, string>() },
      { type: "flushMemory", flushId: 8 },
    ]);
    expect(hydrateMemories).toHaveBeenCalledTimes(1);
    expect(hydrateStickerCatalogs).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryFlushed", flushId: 8 });
  });

  test("invalidateChat 失效回复并恒带记忆清理，分别回执记忆删除与失效完成", async () => {
    pendingSummaries.set(-1001, "摘要");
    pendingSummaries.set(-1002, "摘要");
    await routeAfterInit([
      { type: "invalidateChat", chatId: -1001, requestId: 1 },
      { type: "invalidateChat", chatId: -1002, requestId: 2 },
    ]);
    expect(invalidateChatReplies).toHaveBeenCalledTimes(2);
    // invalidateChat 恒带记忆清理。
    expect(hasChatMemory(-1001)).toBeFalse();
    expect(hasChatMemory(-1002)).toBeFalse();
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryDeleted", chatId: -1001 });
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryDeleted", chatId: -1002 });
    expect(postMessage).toHaveBeenCalledWith({ type: "chatInvalidated", chatId: -1001, requestId: 1 });
    expect(postMessage).toHaveBeenCalledWith({ type: "chatInvalidated", chatId: -1002, requestId: 2 });
  });

  test("queryMood 与 switchMood 按 requestId 回当前或新抽的心情名", async () => {
    await routeAfterInit([
      { type: "queryMood", requestId: 3, deadlineAt: Number.MAX_SAFE_INTEGER },
      { type: "switchMood", requestId: 4, deadlineAt: Number.MAX_SAFE_INTEGER },
    ]);
    expect(currentMood).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: "moodQueried", requestId: 3, moodName: "平静" });
    expect(switchMood).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: "moodSwitched", requestId: 4, moodName: "开心" });
  });

  test("启动时装上缓存用量出口，把用量作为事件发回主线程；停止时卸下", () => {
    worker.startAiChatWorker();
    const usage = {
      kind: "tokens", timestamp: 1, capability: "text", provider: "google", model: "m", inputTokens: 10, cachedInputTokens: 0, outputTokens: 1,
    } as const;
    aiCacheUsageSink.current!(usage);
    expect(postMessage).toHaveBeenCalledWith({ type: "aiCacheUsage", usage });
    worker.stopAiChatWorker();
    expect(aiCacheUsageSink.current).toBeNull();
  });

  test("configReload 只替换变化的领域并失效各自的派生状态", () => {
    worker.handleAiChatWorkerMessage({ atmosphere: "plain",
      type: "init", timeZone: getTimeZone(),
      botInfo: { id: 99, first_name: "Ninja", username: "ninja_bot" },
      superAdminUserId: 1,
      agent: injectedAgentConfig,
      mood: { moods: [{ name: "平静", weight: 100, instruction: "平静。" }] },
      stickers: { packs: ["pack"] },
      persona: "测试人设",
      voiceToolPrompt: null,
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
    expect(refreshMood).not.toHaveBeenCalled();
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
    expect(refreshMood).toHaveBeenCalledTimes(1);
    expect(adoptStickerConfig).toHaveBeenCalledWith(stickers);
    expect(pruneStickerCatalogs).toHaveBeenCalledWith(["pack", "new_pack"]);
    expect(pruneStickerSets).toHaveBeenCalledWith(["pack", "new_pack"]);
    expect(ensureStickerCatalogs).toHaveBeenCalledWith(["pack", "new_pack"]);
    // 配置替换显式失效菜单；目录生成与剪枝没有改写条目时，revision 仍递增。
    expect(stickerMenuRevision.current).toBeGreaterThan(menuRevision);
    // 顺序：先接管配置、再剪枝、最后启动对账；剪枝使用新白名单。
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
      imageGenerationReference: undefined,
      chatQa: undefined,
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
    // 白名单剪枝处理热重载时正在生成、当时跳过的包；排在 dirty 上报之前。
    expect(pruneStickerCatalogs).toHaveBeenCalledWith(["pack"]);
    expect(pruneStickerCatalogs.mock.invocationCallOrder[0]!)
      .toBeLessThan(flushDirtyStickerCatalogs.mock.invocationCallOrder[0]!);
  });

  test("显式启动只安装双工 handler 与维护 timer，不初始化 Telegram 客户端，天气刷新留给 init", () => {
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
      expect(startWeatherRefreshLoop).not.toHaveBeenCalled();
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
