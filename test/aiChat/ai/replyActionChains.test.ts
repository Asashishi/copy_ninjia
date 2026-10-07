import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { waitUntil as pollUntil } from "../../helpers/waitUntil";
import type { ReplyToolContext } from "../../../packages/types/aiChat/replies";
import type { StickerPackCandidate } from "../../../packages/types/stickers/tools";
import type { ChatActionControl, ChatActionPhase } from "../../../packages/types/aiChat/chatAction";
import type { TelegramSendResult } from "../../../packages/types/telegram";
import type { AiReplySession, AiReplyTurn, AiToolOutput } from "../../../packages/types/aiChat/provider";
import type { SpeechSynthesisAttempt } from "../../../packages/types/aiChat/voiceMessage";
import { sineWav } from "../../helpers/wav";

const sendMessage = mock(async (_params: unknown): Promise<TelegramSendResult | undefined> => ({ messageId: 101, repliedToMessageId: undefined }));
const sendSticker = mock(async (_params: unknown): Promise<number | undefined> => 102);
const sendPhoto = mock(async (_params: unknown): Promise<TelegramSendResult | undefined> => ({ messageId: 103, repliedToMessageId: undefined }));
const sendVoice = mock(async (_params: unknown): Promise<TelegramSendResult | undefined> => ({ messageId: 104, repliedToMessageId: undefined }));
const reaction = mock(async (_params: unknown): Promise<boolean> => true);
const sleep = mock(async (_ms: number, _signal?: AbortSignal): Promise<void> => {});
const generateImage = mock(async (_params: unknown) => ({ bytes: new Uint8Array([1]), mimeType: "image/png" as const }));
const synthesizeSpeech = mock(async (_params: unknown): Promise<SpeechSynthesisAttempt> => ({
  ok: true as const,
  speech: { bytes: sineWav(24_000, 0.2), mimeType: "audio/wav" },
}));
let session: AiReplySession;
/** 本轮心跳句柄替身：切挡与收敛按先后记进 events，发送替身也写同一份日志。 */
const events: string[] = [];
function chatActionControl(): ChatActionControl {
  return {
    set: mock((phase: ChatActionPhase): number => {
      events.push(phase);
      return 0;
    }),
    settle: mock(async (): Promise<void> => {}),
  };
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
  sendVoiceWithResult: sendVoice,
  setMessageReaction: reaction,
}));
mock.module("../../../packages/aiChat/ai/tools/stickers", () => ({
  ...realStickers,
  buildStickerPackMenu: async (): Promise<readonly StickerPackCandidate[]> => menu,
}));
mock.module("../../../packages/libs/sleep", () => ({ sleep }));
mock.module("../../../packages/aiChat/provider", () => ({
  ...realProvider,
  imageAiProvider: () => ({ name: "gemini", generateImage }),
  ttsAiProvider: () => ({ synthesizeSpeech }),
  textAiProvider: () => ({ createReplySession: (): AiReplySession => session }),
}));

const { createReplyToolset } = await import("../../../packages/aiChat/ai/tools/replyToolset/orchestrator");
const { generateReply } = await import("../../../packages/workers/aiChat/replyModel");
const { resetImageGenerationCache } = await import("../../../packages/cache/workers/aiChat/imageGeneration");
const { HARD_MAX_ACTIONS_PER_REPLY } = await import("../../../packages/consts/aiChat/tools");
const { VOICE_FOREGROUND_WAIT_MS } = await import("../../../packages/consts/aiChat/voiceMessage");
const { TELEGRAM_CAPTION_MAX_CHARS } = await import("../../../packages/consts/telegram");
const { runTelegramCategorizedRequest } = await import("../../../packages/infra/telegram/outboundGate");
const { encodeVoiceMessage } = await import("../../../packages/aiChat/ai/voiceEncoding");
const { OGG_OPUS_MIME_TYPE } = await import("../../../packages/consts/audio");
const { initTelegramOutbound, drainTelegramOutbound, telegramOutboundStats } = await import("../../../packages/infra/telegram/outboundLifecycle");

function context(controller: AbortController = new AbortController()): ReplyToolContext {
  return {
    chatId: -1001,
    replyToMessageId: 50,
    messageThreadId: 7,
    mediaToolsRequested: true,
    bypassMediaToolCooldown: true,
    direct: false,
    chatAction: chatActionControl(),
    roundHasTypo: false,
    signal: controller.signal,
    isActive: (): boolean => !controller.signal.aborted,
    onMessageSent: mock((): void => {}),
    onStickerSent: mock((): void => {}),
    onImageSent: mock((): void => {}),
    onVoiceSent: mock((): void => {}),
  };
}

/** 断言条件在预算内成立；不成立时立即失败，不静默等待。 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  expect(await pollUntil(predicate)).toBe(true);
}

beforeEach(() => {
  events.length = 0;
  resetImageGenerationCache();
  sendMessage.mockReset().mockResolvedValue({ messageId: 101, repliedToMessageId: undefined });
  sendSticker.mockReset().mockResolvedValue(102);
  sendPhoto.mockReset().mockResolvedValue({ messageId: 103, repliedToMessageId: undefined });
  sendVoice.mockReset().mockResolvedValue({ messageId: 104, repliedToMessageId: undefined });
  reaction.mockReset().mockResolvedValue(true);
  sleep.mockReset().mockResolvedValue();
  generateImage.mockReset().mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "image/png" });
  synthesizeSpeech.mockReset().mockImplementation(async (): Promise<SpeechSynthesisAttempt> => ({
    ok: true as const,
    speech: { bytes: sineWav(24_000, 0.2), mimeType: "audio/wav" },
  }));
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
    const receipt = JSON.parse(toolset.execute("send_message", JSON.stringify({ text: "稍后到达", reply_to_trigger: true })));
    expect(receipt).toEqual({ success: true, queued: true, actions_used: 1 });
    expect(receipt.message_id).toBeUndefined();
    await waitUntil((): boolean => sendMessage.mock.calls.length === 1);
    expect(ctx.onMessageSent).not.toHaveBeenCalled();
    expect(toolset.actionsCompleted()).toBe(0);
    const second = JSON.parse(toolset.execute("add_reaction", '{"emoji":"👍"}'));
    expect(second.queued).toBe(true);
    expect(reaction).not.toHaveBeenCalled();
    expect(JSON.parse(toolset.execute("send_message", '{"text":"稍后到达"}')).skipped).toBe("duplicate");
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
      referenceMemory: "参考记忆", currentConversation: "有人打招呼", currentConversationSettledOffsets: [], replyTask: "自然回应",
    }, toolset)).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    const outputs: readonly AiToolOutput[] = append.mock.calls[0]![0];
    expect(JSON.parse(outputs[0]!.responseJson).queued).toBe(true);
    expect(JSON.parse(outputs[1]!.responseJson).stickers).toContain("猫咪挥手");
    expect(ctx.onMessageSent).not.toHaveBeenCalled();
  } finally {
    pending.resolve({ messageId: 101, repliedToMessageId: undefined });
    await toolset.settle();
  }
});

test("单条发送链抛错后其它链仍执行，失败不会记成真实成功", async () => {
  sendMessage.mockImplementationOnce(async (): Promise<never> => { throw new Error("send failed"); });
  const ctx = context();
  const toolset = await createReplyToolset(ctx);
  toolset.execute("send_message", '{"text":"失败消息"}');
  toolset.execute("send_message", '{"text":"成功消息"}');
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
    toolset.execute("send_message", '{"text":"先说一句"}');
    const viewed = JSON.parse(toolset.execute("view_sticker_pack", '{"pack_index":1,"intent":"打招呼"}'));
    expect(viewed.stickers).toContain("1. 👋 猫咪挥手");
    expect(viewed.intent).toBe("打招呼");
    expect(viewed.queued).toBeUndefined();
    expect(JSON.parse(toolset.execute("send_sticker", '{"pack_index":1,"sticker_index":1}')).queued).toBe(true);
    expect(JSON.parse(toolset.execute("send_sticker", '{"pack_index":1,"sticker_index":1}')).error).toContain("Sticker limit reached");
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
    const receipt = JSON.parse(toolset.execute("generate_image", JSON.stringify({ prompt: "画一只猫", caption })));
    expect(receipt.actions_used).toBe(2);
    expect(receipt.queued).toBe(true);
    expect(JSON.parse(toolset.execute("send_message", JSON.stringify({ text: caption }))).skipped).toBe("duplicate");
    // 语音在工具调用内合成（回执带真实结果），不受前面挂起的生图阻塞；发送仍按调用顺序排在图后面。
    expect(JSON.parse(toolset.execute("send_voice", '{"text":"バカ"}')).queued).toBe(true);
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(sendVoice).not.toHaveBeenCalled();
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(JSON.parse(toolset.execute("generate_image", '{"prompt":"another"}')).error).toContain("Image limit reached");
    expect(JSON.parse(toolset.execute("send_voice", '{"text":"ざぁこ"}')).error).toContain("Voice limit reached");
    image.resolve({ bytes: new Uint8Array([1]), mimeType: "image/png" });
    await toolset.settle();
    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(toolset.actionsUsed()).toBe(3);
    expect(toolset.actionsCompleted()).toBe(3);
  } finally {
    image.resolve({ bytes: new Uint8Array([1]), mimeType: "image/png" });
    await toolset.settle();
  }
});

test("连续调用在发送挂起时也严格遵守单轮动作硬顶", async () => {
  const pending = Promise.withResolvers<TelegramSendResult | undefined>();
  sendMessage.mockImplementation(() => pending.promise);
  const toolset = await createReplyToolset(context());
  try {
    const results: string[] = [];
    for (let i: number = 0; i < 100; i++) results.push(toolset.execute("send_message", JSON.stringify({ text: `第${i}条` })));
    expect(results.filter((result: string): boolean => JSON.parse(result).queued === true)).toHaveLength(HARD_MAX_ACTIONS_PER_REPLY);
    expect(toolset.actionsUsed()).toBe(HARD_MAX_ACTIONS_PER_REPLY);
    expect(toolset.actionsCompleted()).toBe(0);
  } finally {
    pending.resolve({ messageId: 200, repliedToMessageId: undefined });
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
    const accepted = JSON.parse(toolset.execute("send_message", '{"text":"天气","typo_original_char":"气","typo_replacement_char":"汽"}'));
    expect(accepted.actions_used).toBe(2);
    expect(JSON.parse(toolset.execute("send_message", '{"text":"气"}')).skipped).toBe("duplicate");
    await waitUntil((): boolean => sendMessage.mock.calls.length === 1);
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({ text: "天汽" });
    expect(ctx.onMessageSent).not.toHaveBeenCalled();
    pending.resolve({ messageId: 200, repliedToMessageId: undefined });
    await toolset.settle();
    expect(sendMessage.mock.calls[1]![0]).toMatchObject({ text: "气" });
    expect(toolset.actionsCompleted()).toBe(2);
  } finally {
    pending.resolve(undefined);
    await toolset.settle();
    random.mockRestore();
  }
});

test("已接纳链取消后不发送，settle 等链收尾并把本轮状态收回 idle", async () => {
  const paused = Promise.withResolvers<void>();
  sleep.mockImplementation(() => paused.promise);
  const controller = new AbortController();
  const ctx = context(controller);
  const toolset = await createReplyToolset(ctx);
  toolset.execute("send_message", '{"text":"取消消息"}');
  let settled: boolean = false;
  const draining: Promise<void> = toolset.settle().then((): void => { settled = true; });
  await waitUntil((): boolean => sleep.mock.calls.length === 1);
  expect(settled).toBe(false);
  controller.abort();
  paused.resolve();
  await draining;
  expect(sendMessage).not.toHaveBeenCalled();
  expect(toolset.actionsCompleted()).toBe(0);
  expect(ctx.chatAction.set).toHaveBeenLastCalledWith("idle");
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
    return { messageId: 333, repliedToMessageId: undefined };
  });
  const ctx = context();
  const toolset = await createReplyToolset(ctx);
  toolset.execute("send_message", '{"text":"等待出站退避"}');
  await waitUntil((): boolean => telegramOutboundStats().messageRetryPending === 1);
  expect(ctx.onMessageSent).not.toHaveBeenCalled();
  expect(JSON.parse(toolset.execute("view_sticker_pack", '{"pack_index":1,"intent":"挥手"}')).stickers).toContain("猫咪挥手");
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
    return { messageId: 444, repliedToMessageId: undefined };
  });
  const toolset = await createReplyToolset(ctx);
  try {
    expect(JSON.parse(toolset.execute("send_message", '{"text":"等待取消"}')).queued).toBe(true);
    await waitUntil((): boolean => telegramOutboundStats().messageRetryPending === 1);
    controller.abort();
    await toolset.settle();
    expect(telegramOutboundStats().messageRetryPending).toBe(0);
    expect(attempts).toBe(1);
    expect(ctx.onMessageSent).not.toHaveBeenCalled();
    expect(toolset.actionsCompleted()).toBe(0);
    expect(toolset.actionsUsed()).toBe(1);
    expect(ctx.chatAction.set).toHaveBeenLastCalledWith("idle");
  } finally {
    controller.abort();
    await toolset.settle();
  }
});

test("聊天状态按工具调用顺序串行：前一条消息模拟输入期间，查看贴纸不亮状态，后续贴纸与语音不抢状态", async () => {
  const typing = Promise.withResolvers<void>();
  sleep.mockImplementationOnce(() => typing.promise);
  sendMessage.mockImplementation(async (): Promise<TelegramSendResult> => {
    events.push("message sent");
    return { messageId: 101, repliedToMessageId: undefined };
  });
  sendSticker.mockImplementation(async (): Promise<number> => {
    events.push("sticker sent");
    return 102;
  });
  sendVoice.mockImplementation(async (): Promise<TelegramSendResult> => {
    events.push("voice sent");
    return { messageId: 104, repliedToMessageId: undefined };
  });
  // OGG/Opus 只做容器校验、不经异步编码，合成结果在一个宏任务内落定。
  const ogg = await encodeVoiceMessage({ bytes: sineWav(24_000, 0.2), mimeType: "audio/wav" });
  if (!ogg.ok) throw new Error("expected an encodable fixture");
  synthesizeSpeech.mockImplementationOnce(async (): Promise<SpeechSynthesisAttempt> => ({
    ok: true,
    speech: { bytes: ogg.voice.bytes, mimeType: OGG_OPUS_MIME_TYPE },
  }));
  const toolset = await createReplyToolset(context());
  try {
    toolset.execute("send_message", '{"text":"先说一句"}');
    toolset.execute("view_sticker_pack", '{"pack_index":1,"intent":"打招呼"}');
    toolset.execute("send_sticker", '{"pack_index":1,"sticker_index":1}');
    expect(JSON.parse(toolset.execute("send_voice", '{"text":"バカ"}')).success).toBe(true);
    await Bun.sleep(0);
    // 语音已在后台合成完，但链上还停在第一条消息的输入里：状态只有 typing。
    expect(events).toEqual(["typing"]);
    typing.resolve();
    await toolset.settle();
    const phases: string[] = events.filter((event: string): boolean => event !== "idle");
    expect(phases).toEqual(["typing", "message sent", "choose_sticker", "sticker sent", "record_voice", "voice sent"]);
    // 语音在轮到之前已合成好，轮到时按完整音频时长补「正在录音」。
    expect(sleep.mock.calls.at(-1)?.[0]).toBe((sendVoice.mock.calls[0]![0] as { duration: number }).duration * 1_000);
    expect(events.at(-1)).toBe("idle");
    expect(toolset.actionsCompleted()).toBe(3);
  } finally {
    typing.resolve();
    await toolset.settle();
  }
});

test("语音回执当场交回；前台窗口到点时链收回录音继续后续动作，合成成功后排到链尾按音频时长补录音再发送", async () => {
  // 只截下前台窗口那一个计时器，由用例手动触发；其余计时器照常。
  const realSetTimeout: typeof setTimeout = globalThis.setTimeout;
  let closeWindow: (() => void) | null = null;
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number): ReturnType<typeof setTimeout> => {
    if (delay !== VOICE_FOREGROUND_WAIT_MS) return realSetTimeout(callback, delay);
    closeWindow = callback;
    return realSetTimeout((): void => {}, delay);
  }) as typeof setTimeout);
  const synthesis = Promise.withResolvers<SpeechSynthesisAttempt>();
  synthesizeSpeech.mockImplementationOnce(() => synthesis.promise);
  sendMessage.mockImplementation(async (): Promise<TelegramSendResult> => {
    events.push("message sent");
    return { messageId: 101, repliedToMessageId: undefined };
  });
  sendVoice.mockImplementation(async (): Promise<TelegramSendResult> => {
    events.push("voice sent");
    return { messageId: 104, repliedToMessageId: undefined };
  });
  const toolset = await createReplyToolset(context());
  try {
    const receipt = JSON.parse(toolset.execute("send_voice", '{"text":"バカ"}'));
    expect(receipt).toMatchObject({ success: true, queued: true, actions_used: 1 });
    expect(receipt.synthesis).toBeUndefined();
    expect(toolset.actionsUsed()).toBe(1);
    await waitUntil((): boolean => events.includes("record_voice") && closeWindow !== null);
    closeWindow!();

    toolset.execute("send_message", '{"text":"继续说"}');
    await waitUntil((): boolean => events.includes("message sent"));
    expect(sendVoice).not.toHaveBeenCalled();
    expect(events.filter((event: string): boolean => event !== "idle")).toEqual(["record_voice", "typing", "message sent"]);
    expect(events[1]).toBe("idle");

    let settled: boolean = false;
    const draining: Promise<void> = toolset.settle().then((): void => {
      settled = true;
    });
    await waitUntil((): boolean => toolset.actionsCompleted() === 1);
    expect(settled).toBe(false);
    synthesis.resolve({ ok: true, speech: { bytes: sineWav(24_000, 0.2), mimeType: "audio/wav" } });
    await draining;

    const tail: string[] = events.slice(events.indexOf("message sent") + 1);
    expect(tail.filter((event: string): boolean => event !== "idle")).toEqual(["record_voice", "voice sent"]);
    expect(events.at(-1)).toBe("idle");
    const recording: unknown[] | undefined = sleep.mock.calls.at(-1);
    expect(recording?.[0]).toBe((sendVoice.mock.calls[0]![0] as { duration: number }).duration * 1_000);
    expect(toolset.actionsUsed()).toBe(2);
    expect(toolset.actionsCompleted()).toBe(2);
  } finally {
    timeoutSpy.mockRestore();
    synthesis.resolve({ ok: false, reason: "synthesis failed" });
    await toolset.settle();
  }
});

test("后台动作自身 reject 时记英文错误日志，settle 照常结算且不排入投递", async () => {
  const { createReplyActionChains } = await import("../../../packages/aiChat/ai/tools/replyToolset/actionChains");
  const { logger } = await import("../../../packages/infra/logger");
  const loggerError = spyOn(logger, "error").mockImplementation((): void => {});
  try {
    const ctx = context();
    const chains = createReplyActionChains(ctx);
    const failure: Error = new Error("background boom");
    chains.defer("send_voice", Promise.reject(failure));
    await chains.settle();
    expect(loggerError).toHaveBeenCalledWith("AI reply background action failed (chat -1001, tool send_voice):", failure);
    expect(chains.completed()).toBe(0);
    expect(events).toEqual([]);
  } finally {
    loggerError.mockRestore();
  }
});

test("直接轮：还没接纳过动作的请求亮「正在输入」；send_message 回接纳回执，接纳后立即由串行链发出、不停顿；之后的收尾请求不亮状态", async () => {
  const pending = Promise.withResolvers<TelegramSendResult | undefined>();
  sendMessage.mockImplementationOnce(async (): Promise<TelegramSendResult | undefined> => {
    events.push("message sent");
    return pending.promise;
  });
  const ctx: ReplyToolContext = { ...context(), direct: true };
  const toolset = await createReplyToolset(ctx);
  try {
    expect(events).toEqual([]);
    toolset.beforeModelRequest();
    expect(events).toEqual(["typing"]);
    const result = JSON.parse(toolset.execute("send_message", JSON.stringify({ text: "直接发", reply_to_trigger: true })));
    expect(result).toEqual({ success: true, queued: true, actions_used: 1 });
    // 第一条沿用请求期间亮着的「正在输入」直接发出，不做拟人停顿；回执不等它落地。
    await waitUntil((): boolean => sendMessage.mock.calls.length === 1);
    expect(sleep).not.toHaveBeenCalled();
    expect(events).toEqual(["typing", "typing", "idle", "message sent"]);
    expect(ctx.onMessageSent).not.toHaveBeenCalled();
    // 已经接纳过动作，下一次请求多半是收尾：不亮状态。
    toolset.beforeModelRequest();
    toolset.afterModel();
    expect(events).toEqual(["typing", "typing", "idle", "message sent"]);
    pending.resolve({ messageId: 201, repliedToMessageId: 50 });
    await toolset.settle();
    expect(events).toEqual(["typing", "typing", "idle", "message sent", "idle"]);
    expect(ctx.onMessageSent).toHaveBeenCalledWith("直接发", 201, 50);
    expect(toolset.actionsUsed()).toBe(1);
    expect(toolset.actionsCompleted()).toBe(1);
  } finally {
    pending.resolve({ messageId: 201, repliedToMessageId: undefined });
    await toolset.settle();
  }
});

test("直接轮：真实工具循环在第一条发送挂起时继续请求模型，下一次请求交回的文字排在它之后发出", async () => {
  const pending = Promise.withResolvers<TelegramSendResult | undefined>();
  sendMessage.mockImplementationOnce(() => pending.promise);
  const request = mock(async (): Promise<AiReplyTurn> => ({
    ok: true, text: null, functionCalls: [], webSearchCalls: 0, toolCallLimitHit: false,
  }));
  for (const text of ["第一句", "第二句"]) {
    request.mockImplementationOnce(async (): Promise<AiReplyTurn> => ({
      ok: true,
      text: null,
      functionCalls: [{ id: text, name: "send_message", argumentsJson: JSON.stringify({ text }) }],
      webSearchCalls: 0,
      toolCallLimitHit: false,
    }));
  }
  const append = mock((_outputs: readonly AiToolOutput[]): boolean => true);
  session = { request, appendToolOutputs: append };
  const ctx: ReplyToolContext = { ...context(), direct: true };
  const toolset = await createReplyToolset(ctx);
  try {
    expect(await generateReply(ctx.chatId, {
      referenceMemory: "参考记忆", currentConversation: "有人打招呼", currentConversationSettledOffsets: [], replyTask: "自然回应",
    }, toolset)).toBeNull();
    // 模型已经被请求了三次，第一句的发送仍挂着：拟人停顿与发送都不挡模型往返，第二句排在它之后。
    expect(request).toHaveBeenCalledTimes(3);
    await waitUntil((): boolean => sendMessage.mock.calls.length === 1);
    expect(ctx.onMessageSent).not.toHaveBeenCalled();
    expect(append.mock.calls.map((call: [readonly AiToolOutput[]]): unknown => JSON.parse(call[0][0]!.responseJson)))
      .toEqual([{ success: true, queued: true, actions_used: 1 }, { success: true, queued: true, actions_used: 1 }]);
    pending.resolve({ messageId: 201, repliedToMessageId: undefined });
    await toolset.settle();
    expect(sendMessage.mock.calls.map((call: [unknown]): string => (call[0] as { text: string }).text)).toEqual(["第一句", "第二句"]);
    // 第一句直接发出，第二句照常模拟「正在输入」。
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(toolset.actionsCompleted()).toBe(2);
  } finally {
    pending.resolve({ messageId: 201, repliedToMessageId: undefined });
    await toolset.settle();
  }
});

test("直接轮：看过贴纸包后的那次模型请求亮「正在选择贴纸」，发贴纸时仍做选择停顿再发出", async () => {
  sendSticker.mockImplementation(async (): Promise<number> => {
    events.push("sticker sent");
    return 102;
  });
  const toolset = await createReplyToolset({ ...context(), direct: true });
  toolset.beforeModelRequest();
  toolset.execute("view_sticker_pack", '{"pack_index":1,"intent":"打招呼"}');
  // 模型带着贴纸清单被再请求一次：这次是在挑贴纸。
  toolset.beforeModelRequest();
  expect(JSON.parse(toolset.execute("send_sticker", '{"pack_index":1,"sticker_index":1}')))
    .toEqual({ success: true, queued: true, actions_used: 1 });
  toolset.beforeModelRequest();
  await toolset.settle();
  expect(events).toEqual(["typing", "choose_sticker", "choose_sticker", "idle", "sticker sent", "idle"]);
  // 挑贴纸的请求很短，贴纸即便是这一批的第一个动作也要停顿，选择状态才看得见。
  expect(sleep).toHaveBeenCalledTimes(1);
  expect(toolset.actionsCompleted()).toBe(1);
});

test("直接轮：串行链还在发上一条时，挑贴纸请求的「正在选择贴纸」等链排空再亮", async () => {
  const pending = Promise.withResolvers<TelegramSendResult | undefined>();
  sendMessage.mockImplementationOnce(async (): Promise<TelegramSendResult | undefined> => {
    events.push("message sent");
    return pending.promise;
  });
  const toolset = await createReplyToolset({ ...context(), direct: true });
  try {
    toolset.beforeModelRequest();
    toolset.execute("send_message", '{"text":"先说一句"}');
    toolset.execute("view_sticker_pack", '{"pack_index":1,"intent":"打招呼"}');
    await waitUntil((): boolean => events.includes("message sent"));
    toolset.beforeModelRequest();
    expect(events).toEqual(["typing", "typing", "idle", "message sent"]);
    pending.resolve({ messageId: 201, repliedToMessageId: undefined });
    await waitUntil((): boolean => events.at(-1) === "choose_sticker");
    expect(events).toEqual(["typing", "typing", "idle", "message sent", "idle", "choose_sticker"]);
    toolset.afterModel();
    expect(events.at(-1)).toBe("idle");
  } finally {
    pending.resolve({ messageId: 201, repliedToMessageId: undefined });
    await toolset.settle();
  }
});

test("直接轮：语音当场回接纳回执，等合成期间链上亮「正在录音」；按语音时长模拟录音与发送由串行链执行", async () => {
  const synthesis = Promise.withResolvers<SpeechSynthesisAttempt>();
  synthesizeSpeech.mockImplementationOnce(() => synthesis.promise);
  sendVoice.mockImplementation(async (): Promise<TelegramSendResult> => {
    events.push("voice sent");
    return { messageId: 104, repliedToMessageId: undefined };
  });
  const toolset = await createReplyToolset({ ...context(), direct: true });
  try {
    toolset.beforeModelRequest();
    const result = JSON.parse(toolset.execute("send_voice", '{"text":"バカ"}'));
    expect(result).toMatchObject({ success: true, queued: true, actions_used: 1 });
    expect(typeof result.voice_remaining_today).toBe("number");
    await waitUntil((): boolean => events.includes("record_voice"));
    expect(sendVoice).not.toHaveBeenCalled();
    synthesis.resolve({ ok: true, speech: { bytes: sineWav(24_000, 0.2), mimeType: "audio/wav" } });
    await toolset.settle();
    expect(events).toEqual(["typing", "record_voice", "record_voice", "idle", "voice sent", "idle"]);
    expect(sleep.mock.calls.at(-1)?.[0]).toBe((sendVoice.mock.calls[0]![0] as { duration: number }).duration * 1_000);
    expect(toolset.actionsUsed()).toBe(1);
    expect(toolset.actionsCompleted()).toBe(1);
  } finally {
    synthesis.resolve({ ok: false, reason: "synthesis failed" });
    await toolset.settle();
  }
});

test("模型阶段结束：直接轮只收回没被动作接走的请求挡位，有序并行轮不切挡", async () => {
  const direct = await createReplyToolset({ ...context(), direct: true });
  direct.beforeModelRequest();
  direct.afterModel();
  expect(events).toEqual(["typing", "idle"]);

  events.length = 0;
  sendMessage.mockImplementation(async (): Promise<TelegramSendResult> => ({ messageId: 201, repliedToMessageId: undefined }));
  const directWithAction = await createReplyToolset({ ...context(), direct: true });
  directWithAction.beforeModelRequest();
  directWithAction.execute("send_message", '{"text":"发出去了"}');
  directWithAction.beforeModelRequest();
  directWithAction.afterModel();
  await directWithAction.settle();
  expect(events).toEqual(["typing", "typing", "idle", "idle"]);

  events.length = 0;
  const ordered = await createReplyToolset(context());
  ordered.beforeModelRequest();
  ordered.afterModel();
  expect(events).toEqual([]);
  await direct.settle();
  await ordered.settle();
});

test("直接轮：发送抛错时模型已拿到接纳回执，链上的失败不计完成动作", async () => {
  sendMessage.mockImplementationOnce(async (): Promise<never> => { throw new Error("send failed"); });
  const toolset = await createReplyToolset({ ...context(), direct: true });
  const result = JSON.parse(toolset.execute("send_message", '{"text":"会失败"}'));
  expect(result).toEqual({ success: true, queued: true, actions_used: 1 });
  await toolset.settle();
  expect(toolset.actionsUsed()).toBe(1);
  expect(toolset.actionsCompleted()).toBe(0);
});

test("直接轮：一次响应交回的多个动作逐个发出，第一个直接发，之后的切挡并做拟人停顿；不亮状态的请求交回的文字也停顿", async () => {
  sendMessage.mockImplementation(async (params: unknown): Promise<TelegramSendResult> => {
    events.push(`sent ${(params as { text: string }).text}`);
    return { messageId: 201, repliedToMessageId: undefined };
  });
  sleep.mockImplementation(async (ms: number): Promise<void> => {
    events.push(`pause ${ms > 0 ? "yes" : "no"}`);
  });
  const toolset = await createReplyToolset({ ...context(), direct: true });
  toolset.beforeModelRequest();
  toolset.execute("send_message", '{"text":"第一句"}');
  toolset.execute("send_message", '{"text":"第二句"}');
  await toolset.settle();
  expect(events).toEqual([
    "typing",
    "typing", "idle", "sent 第一句", "idle",
    "typing", "pause yes", "idle", "sent 第二句", "idle",
  ]);
  events.length = 0;
  toolset.beforeModelRequest();
  toolset.execute("send_message", '{"text":"第三句"}');
  await toolset.settle();
  expect(events).toEqual(["typing", "pause yes", "idle", "sent 第三句", "idle"]);
});

test("直接轮：「正在输入」请求交回的第一个动作是生图时，独立图注照常模拟「正在输入」再发出", async () => {
  sendPhoto.mockImplementation(async (): Promise<TelegramSendResult> => {
    events.push("photo sent");
    return { messageId: 103, repliedToMessageId: undefined };
  });
  sendMessage.mockImplementation(async (): Promise<TelegramSendResult> => {
    events.push("caption sent");
    return { messageId: 201, repliedToMessageId: undefined };
  });
  sleep.mockImplementation(async (ms: number): Promise<void> => {
    events.push(`pause ${ms > 0 ? "yes" : "no"}`);
  });
  const toolset = await createReplyToolset({ ...context(), direct: true });
  toolset.beforeModelRequest();
  const caption: string = "长".repeat(TELEGRAM_CAPTION_MAX_CHARS + 1);
  const result = JSON.parse(toolset.execute("generate_image", JSON.stringify({ prompt: "画一只猫", caption })));
  expect(result).toMatchObject({ success: true, queued: true, actions_used: 2, caption_delivery: "separate_message" });
  await toolset.settle();
  expect(events.slice(events.indexOf("photo sent"))).toEqual([
    "photo sent", "idle", "typing", "pause yes", "idle", "caption sent", "idle",
  ]);
});

test("有序并行轮请求模型前不切挡：状态只由串行链切换", async () => {
  const toolset = await createReplyToolset(context());
  toolset.beforeModelRequest();
  expect(events).toEqual([]);
  await toolset.settle();
});
