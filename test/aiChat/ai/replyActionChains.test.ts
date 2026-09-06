import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { ReplyToolContext } from "../../../packages/types/aiChat/replies";
import type { StickerPackCandidate } from "../../../packages/types/stickers/tools";
import type { ChatActionHeartbeatControl } from "../../../packages/types/aiChat/chatAction";
import type { TelegramSendResult } from "../../../packages/types/telegram";
import type { AiReplySession, AiReplyTurn, AiToolOutput } from "../../../packages/types/aiChat/provider";

const sendMessage = mock(async (_params: unknown): Promise<TelegramSendResult | undefined> => ({ messageId: 101 }));
const sendSticker = mock(async (_params: unknown): Promise<number | undefined> => 102);
const sendPhoto = mock(async (_params: unknown): Promise<TelegramSendResult | undefined> => ({ messageId: 103 }));
const sendAudio = mock(async (_params: unknown): Promise<TelegramSendResult | undefined> => ({ messageId: 104 }));
const reaction = mock(async (_params: unknown): Promise<boolean> => true);
const sleep = mock(async (_ms: number, _signal?: AbortSignal): Promise<void> => {});
const generateImage = mock(async (_params: unknown) => ({ bytes: new Uint8Array([1]), mimeType: "image/png" as const }));
const generateSong = mock(async (_params: unknown) => ({ bytes: new Uint8Array([1]), mimeType: "audio/mpeg" }));
const heartbeatControls: ChatActionHeartbeatControl[] = [];
let session: AiReplySession;
function heartbeat(): ChatActionHeartbeatControl {
  const control: ChatActionHeartbeatControl = {
    current: (): "idle" => "idle",
    set: mock((): void => {}),
    settle: mock(async (): Promise<void> => {}),
    stop: mock(async (): Promise<void> => {}),
  };
  heartbeatControls.push(control);
  return control;
}
const menu: readonly StickerPackCandidate[] = [{
  pack: "cats",
  title: "猫猫",
  summary: "友好回应",
  stickers: [{
    sticker: { file_id: "cat-file", file_unique_id: "cat-uid", type: "regular", width: 100, height: 100, is_animated: false, is_video: false },
    emoji: "👋",
    description: "猫咪挥手",
  }],
}];

const realTelegram = await import("../../../packages/infra/telegram");
const realStickers = await import("../../../packages/aiChat/ai/tools/stickers");
const realProvider = await import("../../../packages/aiChat/provider");
mock.module("../../../packages/infra/telegram", () => ({
  ...realTelegram,
  sendMessageWithResult: sendMessage,
  sendSticker,
  sendPhotoWithResult: sendPhoto,
  sendAudioWithResult: sendAudio,
  setMessageReaction: reaction,
}));
mock.module("../../../packages/aiChat/ai/tools/stickers", () => ({
  ...realStickers,
  buildStickerPackMenu: async (): Promise<readonly StickerPackCandidate[]> => menu,
}));
mock.module("../../../packages/aiChat/ai/chatActionHeartbeat", () => ({ startChatActionHeartbeat: heartbeat }));
mock.module("../../../packages/libs/sleep", () => ({ sleep }));
mock.module("../../../packages/aiChat/ai/imageGeneration", () => ({ generateChatImage: generateImage }));
mock.module("../../../packages/aiChat/ai/songCover", () => ({ generateSongCover: async (): Promise<null> => null }));
mock.module("../../../packages/aiChat/provider", () => ({
  ...realProvider,
  imageAiProvider: () => ({}),
  songAiProvider: () => ({ generateSong }),
  textAiProvider: () => ({ createReplySession: (): AiReplySession => session }),
}));

const { createReplyToolset } = await import("../../../packages/aiChat/ai/tools/replyToolset/orchestrator");
const { generateReply } = await import("../../../packages/workers/aiChat/replyModel");
const { resetImageGenerationCache } = await import("../../../packages/cache/workers/aiChat/imageGeneration");
const { resetSongGenerationCache } = await import("../../../packages/cache/workers/aiChat/songGeneration");
const { HARD_MAX_ACTIONS_PER_REPLY } = await import("../../../packages/consts/aiChat/tools");
const { TELEGRAM_CAPTION_MAX_CHARS } = await import("../../../packages/consts/telegram");
const { runTelegramCategorizedRequest } = await import("../../../packages/infra/telegram/outboundGate");
const { initTelegramOutbound, drainTelegramOutbound, telegramOutboundStats } = await import("../../../packages/infra/telegram/outboundLifecycle");

function context(controller: AbortController = new AbortController()): ReplyToolContext {
  return {
    chatId: -1001,
    replyToMessageId: 50,
    messageThreadId: 7,
    mediaToolsRequested: true,
    bypassMediaToolCooldown: true,
    chatAction: heartbeat(),
    stickerLock: { tryAcquire: (): boolean => true, release: (): void => {} },
    roundHasTypo: false,
    signal: controller.signal,
    isActive: (): boolean => !controller.signal.aborted,
    onMessageSent: mock((): void => {}),
    onStickerSent: mock((): void => {}),
    onImageSent: mock((): void => {}),
    onSongSent: mock((): void => {}),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt: number = 0; attempt < 100 && !predicate(); attempt++) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

beforeEach(() => {
  heartbeatControls.length = 0;
  resetImageGenerationCache();
  resetSongGenerationCache();
  sendMessage.mockReset().mockResolvedValue({ messageId: 101 });
  sendSticker.mockReset().mockResolvedValue(102);
  sendPhoto.mockReset().mockResolvedValue({ messageId: 103 });
  sendAudio.mockReset().mockResolvedValue({ messageId: 104 });
  reaction.mockReset().mockResolvedValue(true);
  sleep.mockReset().mockResolvedValue();
  generateImage.mockReset().mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "image/png" });
  generateSong.mockReset().mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "audio/mpeg" });
  initTelegramOutbound();
});

afterEach(async () => {
  await drainTelegramOutbound(0);
});

test("发送等待期间立即回接纳结果，真实发送结果只交给自己的回调", async () => {
  const pending = Promise.withResolvers<TelegramSendResult | undefined>();
  sendMessage.mockImplementationOnce(() => pending.promise);
  const ctx = context();
  const toolset = await createReplyToolset(ctx);
  try {
    const receipt = JSON.parse(await toolset.execute("send_message", JSON.stringify({ text: "稍后到达", reply_to_trigger: true })));
    expect(receipt).toEqual({ success: true, queued: true, actions_used: 1 });
    expect(receipt.message_id).toBeUndefined();
    await waitUntil((): boolean => sendMessage.mock.calls.length === 1);
    expect(ctx.onMessageSent).not.toHaveBeenCalled();
    expect(toolset.actionsCompleted()).toBe(0);
    const second = JSON.parse(await toolset.execute("add_reaction", '{"emoji":"👍"}'));
    expect(second.queued).toBe(true);
    expect(reaction).not.toHaveBeenCalled();
    expect(JSON.parse(await toolset.execute("send_message", '{"text":"稍后到达"}')).skipped).toBe("duplicate");
    pending.resolve({ messageId: 201, repliedToMessageId: 50 });
    await toolset.settle();
    expect(ctx.onMessageSent).toHaveBeenCalledWith("稍后到达", 201, 50);
    expect(toolset.actionsCompleted()).toBe(2);
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({ messageThreadId: 7, signal: ctx.signal });
  } finally {
    pending.resolve(undefined);
    await toolset.settle();
  }
});

test("真实工具循环在发送挂起时继续请求模型，发送回执和 view 清单一起交回", async () => {
  const pending = Promise.withResolvers<TelegramSendResult | undefined>();
  sendMessage.mockImplementationOnce(() => pending.promise);
  const request = mock(async (): Promise<AiReplyTurn> => ({
    ok: true, text: null, functionCalls: [], webSearchCalls: 0, toolCallLimitHit: false,
  }));
  request.mockImplementationOnce(async (): Promise<AiReplyTurn> => ({
    ok: true,
    text: null,
    functionCalls: [
      { id: "send", name: "send_message", argumentsJson: '{"text":"稍后发出"}' },
      { id: "view", name: "view_sticker_pack", argumentsJson: '{"pack_index":1,"intent":"打招呼"}' },
    ],
    webSearchCalls: 0,
    toolCallLimitHit: false,
  }));
  const append = mock((_outputs: readonly AiToolOutput[]): boolean => true);
  session = { request, appendToolOutputs: append };
  const ctx = context();
  const toolset = await createReplyToolset(ctx);
  try {
    expect(await generateReply(ctx.chatId, {
      referenceMemory: "参考记忆", currentConversation: "有人打招呼", replyTask: "自然回应",
    }, toolset)).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    const outputs: readonly AiToolOutput[] = append.mock.calls[0]![0];
    expect(JSON.parse(outputs[0]!.responseJson).queued).toBe(true);
    expect(JSON.parse(outputs[1]!.responseJson).stickers).toContain("猫咪挥手");
    expect(ctx.onMessageSent).not.toHaveBeenCalled();
  } finally {
    pending.resolve({ messageId: 101 });
    await toolset.settle();
  }
});

test("单条发送链抛错后其它链仍执行，失败不会记成真实成功", async () => {
  sendMessage.mockImplementationOnce(async (): Promise<never> => { throw new Error("send failed"); });
  const ctx = context();
  const toolset = await createReplyToolset(ctx);
  await toolset.execute("send_message", '{"text":"失败消息"}');
  await toolset.execute("send_message", '{"text":"成功消息"}');
  await toolset.settle();
  expect(ctx.onMessageSent).toHaveBeenCalledTimes(1);
  expect(ctx.onMessageSent).toHaveBeenCalledWith("成功消息", 101, undefined);
  expect(toolset.actionsUsed()).toBe(2);
  expect(toolset.actionsCompleted()).toBe(1);
});

test("view 在模拟输入与发送挂起时返回真实清单，发送贴纸先预占限额", async () => {
  const paused = Promise.withResolvers<void>();
  sleep.mockImplementation(() => paused.promise);
  const ctx = context();
  const toolset = await createReplyToolset(ctx);
  try {
    await toolset.execute("send_message", '{"text":"先说一句"}');
    const viewed = JSON.parse(await toolset.execute("view_sticker_pack", '{"pack_index":1,"intent":"打招呼"}'));
    expect(viewed.stickers).toContain("1. 👋 猫咪挥手");
    expect(viewed.intent).toBe("打招呼");
    expect(viewed.queued).toBeUndefined();
    expect(JSON.parse(await toolset.execute("send_sticker", '{"pack_index":1,"sticker_index":1}')).queued).toBe(true);
    expect(JSON.parse(await toolset.execute("send_sticker", '{"pack_index":1,"sticker_index":1}')).error).toContain("Sticker limit reached");
    expect(sendSticker).not.toHaveBeenCalled();
    paused.resolve();
    await toolset.settle();
    expect(sendSticker).toHaveBeenCalledTimes(1);
    expect(ctx.onStickerSent).toHaveBeenCalledTimes(1);
  } finally {
    paused.resolve();
    await toolset.settle();
  }
});

test("媒体生成挂起时模型继续调用，长图注预算在接纳时预留且等图发送后补发", async () => {
  const image = Promise.withResolvers<Awaited<ReturnType<typeof generateImage>>>();
  generateImage.mockImplementationOnce(() => image.promise);
  const toolset = await createReplyToolset(context());
  try {
    const caption: string = "长".repeat(TELEGRAM_CAPTION_MAX_CHARS + 1);
    const receipt = JSON.parse(await toolset.execute("generate_image", JSON.stringify({ prompt: "画一只猫", caption })));
    expect(receipt.actions_used).toBe(2);
    expect(receipt.queued).toBe(true);
    expect(JSON.parse(await toolset.execute("send_message", JSON.stringify({ text: caption }))).skipped).toBe("duplicate");
    expect(JSON.parse(await toolset.execute("generate_song", '{"prompt":"a song"}')).queued).toBe(true);
    expect(generateSong).not.toHaveBeenCalled();
    expect(sendAudio).not.toHaveBeenCalled();
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(JSON.parse(await toolset.execute("generate_image", '{"prompt":"another"}')).error).toContain("Image limit reached");
    expect(JSON.parse(await toolset.execute("generate_song", '{"prompt":"another"}')).error).toContain("Song limit reached");
    image.resolve({ bytes: new Uint8Array([1]), mimeType: "image/png" });
    await toolset.settle();
    expect(sendAudio).toHaveBeenCalledTimes(1);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(toolset.actionsUsed()).toBe(3);
    expect(toolset.actionsCompleted()).toBe(3);
  } finally {
    image.resolve({ bytes: new Uint8Array([1]), mimeType: "image/png" });
    await toolset.settle();
  }
});

test("并行调用在发送挂起时也严格遵守单轮动作硬顶", async () => {
  const pending = Promise.withResolvers<TelegramSendResult | undefined>();
  sendMessage.mockImplementation(() => pending.promise);
  const toolset = await createReplyToolset(context());
  try {
    const calls: Promise<string>[] = [];
    for (let i: number = 0; i < 100; i++) calls.push(toolset.execute("send_message", JSON.stringify({ text: `第${i}条` })));
    const results = await Promise.allSettled(calls);
    expect(results.filter((result) => result.status === "fulfilled" && JSON.parse(result.value).queued === true)).toHaveLength(HARD_MAX_ACTIONS_PER_REPLY);
    expect(toolset.actionsUsed()).toBe(HARD_MAX_ACTIONS_PER_REPLY);
    expect(toolset.actionsCompleted()).toBe(0);
  } finally {
    pending.resolve({ messageId: 200 });
    await toolset.settle();
  }
  expect(sendMessage).toHaveBeenCalledTimes(HARD_MAX_ACTIONS_PER_REPLY);
});

test("错字补发先预占额度并判重，只在原消息真实发送完成后执行", async () => {
  const random = spyOn(Math, "random").mockReturnValue(0);
  const pending = Promise.withResolvers<TelegramSendResult | undefined>();
  sendMessage.mockImplementationOnce(() => pending.promise);
  const ctx = context();
  ctx.roundHasTypo = true;
  const toolset = await createReplyToolset(ctx);
  try {
    const accepted = JSON.parse(await toolset.execute("send_message", '{"text":"天气","typo_original_char":"气","typo_replacement_char":"汽"}'));
    expect(accepted.actions_used).toBe(2);
    expect(JSON.parse(await toolset.execute("send_message", '{"text":"气"}')).skipped).toBe("duplicate");
    await waitUntil((): boolean => sendMessage.mock.calls.length === 1);
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({ text: "天汽" });
    expect(ctx.onMessageSent).not.toHaveBeenCalled();
    pending.resolve({ messageId: 200 });
    await toolset.settle();
    expect(sendMessage.mock.calls[1]![0]).toMatchObject({ text: "气" });
    expect(toolset.actionsCompleted()).toBe(2);
  } finally {
    pending.resolve(undefined);
    await toolset.settle();
    random.mockRestore();
  }
});

test("已接纳链取消后不发送，settle 等待链及心跳全部停止", async () => {
  const paused = Promise.withResolvers<void>();
  sleep.mockImplementation(() => paused.promise);
  const controller = new AbortController();
  const toolset = await createReplyToolset(context(controller));
  await toolset.execute("send_message", '{"text":"取消消息"}');
  let settled: boolean = false;
  const draining: Promise<void> = toolset.settle().then((): void => { settled = true; });
  await waitUntil((): boolean => sleep.mock.calls.length === 1);
  expect(settled).toBe(false);
  controller.abort();
  paused.resolve();
  await draining;
  expect(sendMessage).not.toHaveBeenCalled();
  expect(toolset.actionsCompleted()).toBe(0);
  expect(heartbeatControls[1]!.stop).toHaveBeenCalledTimes(1);
});

test("429 由原出站队列重试，view 不等冷却，完成时仅回调一次", async () => {
  let attempts: number = 0;
  sendMessage.mockImplementation(async (): Promise<TelegramSendResult> => {
    await runTelegramCategorizedRequest({
      category: "message",
      execute: async (): Promise<unknown> => ++attempts === 1
        ? { ok: false, error_code: 429, parameters: { retry_after: 0.02 } }
        : { ok: true, result: true },
    });
    return { messageId: 333 };
  });
  const ctx = context();
  const toolset = await createReplyToolset(ctx);
  await toolset.execute("send_message", '{"text":"等待出站退避"}');
  await waitUntil((): boolean => telegramOutboundStats().messageRetryPending === 1);
  expect(ctx.onMessageSent).not.toHaveBeenCalled();
  expect(JSON.parse(await toolset.execute("view_sticker_pack", '{"pack_index":1,"intent":"挥手"}')).stickers).toContain("猫咪挥手");
  await toolset.settle();
  expect(attempts).toBe(2);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(ctx.onMessageSent).toHaveBeenCalledTimes(1);
});

test("取消已经进入 429 队列的发送链会摘掉重试项，且不会回填成功记录", async () => {
  const controller = new AbortController();
  const ctx = context(controller);
  let attempts: number = 0;
  sendMessage.mockImplementation(async (params: unknown): Promise<TelegramSendResult> => {
    await runTelegramCategorizedRequest({
      category: "message",
      signal: (params as { signal: AbortSignal }).signal,
      execute: async (): Promise<unknown> => {
        attempts++;
        return { ok: false, error_code: 429, parameters: { retry_after: 60 } };
      },
    });
    return { messageId: 444 };
  });
  const toolset = await createReplyToolset(ctx);
  try {
    expect(JSON.parse(await toolset.execute("send_message", '{"text":"等待取消"}')).queued).toBe(true);
    await waitUntil((): boolean => telegramOutboundStats().messageRetryPending === 1);
    controller.abort();
    await toolset.settle();
    expect(telegramOutboundStats().messageRetryPending).toBe(0);
    expect(attempts).toBe(1);
    expect(ctx.onMessageSent).not.toHaveBeenCalled();
    expect(toolset.actionsCompleted()).toBe(0);
    expect(toolset.actionsUsed()).toBe(1);
    expect(heartbeatControls[1]!.stop).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    await toolset.settle();
  }
});
