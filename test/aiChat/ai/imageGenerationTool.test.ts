import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReplyToolContext, RoundMessageState } from "../../../packages/types/aiChat/replies";
import type { TelegramSendResult } from "../../../packages/types/telegram";

const generatedBytes: Uint8Array = new Uint8Array([1, 2, 3]);
const generateChatImage = mock(async (..._args: unknown[]): Promise<{
  bytes: Uint8Array;
  mimeType: "image/png";
} | null> => ({ bytes: generatedBytes, mimeType: "image/png" }));
const normalizeImageAspectRatio = mock((requested: string | undefined) => {
  if (requested === undefined || requested.trim() === "") return "1:1" as const;
  if (requested === "7:5") return "4:3" as const;
  if (requested === "1600:900") return "16:9" as const;
  if (requested === "16:9") return "16:9" as const;
  return null;
});
const referenceVisionImage = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mime: "image/jpeg" as const };
const downloadTelegramVisionImage = mock(async (..._args: unknown[]): Promise<typeof referenceVisionImage | null> => referenceVisionImage);
const runMediaTask = mock(async <T>(task: () => Promise<T>): Promise<T | undefined> => await task());
const sendPhotoWithResult = mock(async (..._args: unknown[]): Promise<TelegramSendResult | undefined> => ({
  messageId: 77,
  repliedToMessageId: 42,
}));
// 超长图注降级时执行器会补发一条独立文本；这条走的是 sendMessageWithResult，
// 不 mock 就会打到真实 Bot API。
const sendMessageWithResult = mock(async (..._args: unknown[]): Promise<TelegramSendResult | undefined> => ({
  messageId: 78,
  repliedToMessageId: 42,
}));
// 超长图注降级会走一次拟人停顿；停顿本身是 send_message 已覆盖的行为，这里
// 只关心两条消息的落地顺序和结算，因此按 replyToolset 用例的惯例把 sleep 打掉。
const sleepMock = mock(async (..._args: unknown[]): Promise<void> => {});
const realImageGeneration = await import("../../../packages/aiChat/ai/imageGeneration");
const realTelegram = await import("../../../packages/infra/telegram");

mock.module("../../../packages/libs/sleep", () => ({ sleep: sleepMock }));

mock.module("../../../packages/aiChat/ai/imageGeneration", () => ({
  ...realImageGeneration,
  generateChatImage,
  normalizeImageAspectRatio,
}));
mock.module("../../../packages/infra/telegram", () => ({ ...realTelegram, sendPhotoWithResult, sendMessageWithResult }));
mock.module("../../../packages/aiChat/ai/telegramImage", () => ({ downloadTelegramVisionImage }));
mock.module("../../../packages/aiChat/ai/mediaTaskRunner", () => ({ runMediaTask }));

const { buildGenerateImageToolDefinition, createGenerateImageExecutor } = await import("../../../packages/aiChat/ai/tools/replyToolset/imageGeneration");
const { buildImageReferenceBlock } = await import("../../../packages/aiChat/ai/tools/replyToolset/imageReference");
const { IMAGE_REFERENCE_POINTER } = await import("../../../packages/consts/aiChat/prompts/tools");
const { createRoundMessageState } = await import("../../../packages/aiChat/ai/tools/replyToolset/messageState");
const { claimImageGeneration, resetImageGenerationCache } = await import("../../../packages/cache/workers/aiChat/imageGeneration");
const { HARD_MAX_ACTIONS_PER_REPLY } = await import("../../../packages/consts/aiChat/tools");

/**
 * 绝大多数用例不关心本轮已发消息状态，默认给一份全新的；动作预算默认按「整轮
 * 还没用过动作」给满，只有验证图注补发预算闸的用例才传别的值。
 */
function buildExecutor(
  ctx: ReplyToolContext,
  state: RoundMessageState = createRoundMessageState(),
  actionsUsed: number = 0
): (argumentsJson: string) => Promise<string> {
  const prepare = createGenerateImageExecutor(ctx, state, (): number => actionsUsed);
  return async (argumentsJson: string): Promise<string> => {
    const execution = prepare(argumentsJson);
    return typeof execution === "string" ? execution : execution.run(ctx.chatAction);
  };
}

function buildContext(
  chatId: number = -1001,
  bypass: boolean = false,
  requested: boolean = true
): ReplyToolContext {
  return {
    chatId,
    replyToMessageId: 42,
    messageThreadId: undefined,
    mediaToolsRequested: requested,
    bypassMediaToolCooldown: bypass,
    chatAction: {
      current: () => "idle",
      set: mock((..._args: unknown[]): void => {}),
      settle: mock(async (): Promise<void> => {}),
    },
    stickerLock: { tryAcquire: () => true, release: () => {} },
    roundHasTypo: false,
    isActive: () => true,
    onMessageSent: mock((..._args: unknown[]): void => {}),
    onStickerSent: mock((..._args: unknown[]): void => {}),
    onImageSent: mock((..._args: unknown[]): void => {}),
    onSongSent: mock((..._args: unknown[]): void => {}),
  };
}

function buildReferenceContext(chatId: number = -1001, bypass: boolean = false): ReplyToolContext {
  return {
    ...buildContext(chatId, bypass),
    imageGenerationReference: {
      fileId: "reference-file",
      fileUniqueId: "reference-unique",
      width: 1600,
      height: 900,
    },
  };
}

beforeEach(() => {
  resetImageGenerationCache();
  generateChatImage.mockClear();
  generateChatImage.mockResolvedValue({ bytes: generatedBytes, mimeType: "image/png" });
  normalizeImageAspectRatio.mockClear();
  downloadTelegramVisionImage.mockClear();
  downloadTelegramVisionImage.mockResolvedValue(referenceVisionImage);
  runMediaTask.mockClear();
  runMediaTask.mockImplementation(async <T>(task: () => Promise<T>): Promise<T | undefined> => await task());
  sendPhotoWithResult.mockClear();
  sendPhotoWithResult.mockResolvedValue({ messageId: 77, repliedToMessageId: 42 });
  sendMessageWithResult.mockClear();
  sendMessageWithResult.mockResolvedValue({ messageId: 78, repliedToMessageId: 42 });
  sleepMock.mockClear();
});

afterEach(() => {
  resetImageGenerationCache();
});

describe("generate_image 工具执行器", () => {
  test("工具声明逐字恒定：冷却与参考素材都不进 schema", () => {
    const baseline = JSON.stringify(buildGenerateImageToolDefinition());
    expect(buildGenerateImageToolDefinition().description).toContain("每轮最多成功发送 1 张");
    expect(buildGenerateImageToolDefinition().description).toContain(IMAGE_REFERENCE_POINTER);

    // 冷却推进、superAdmin 旁路、带不带参考图，都不得改变声明的任何一个字节：
    // 这段前缀每轮重发，只要它变了供应商侧的缓存就整段落空。
    claimImageGeneration({ chatId: -1001, bypassCooldown: false });
    expect(JSON.stringify(buildGenerateImageToolDefinition())).toBe(baseline);
    resetImageGenerationCache();
    expect(JSON.stringify(buildGenerateImageToolDefinition())).toBe(baseline);
  });

  test("参考素材文案原样落在运行时状态区块里，冷却一个字都不写", () => {
    const absent = buildImageReferenceBlock({ ctx: buildContext(), imageEnabled: true });
    expect(absent).toContain("当前触发没有附带参考图片");
    expect(absent).toContain("未指定比例时默认使用 1:1");
    expect(absent).not.toContain("冷却");

    // 冷却推进与 superAdmin 旁路都不得在这一段里留下任何痕迹：本轮能不能生图只在
    // 工具真的被调用时由执行侧判定。
    claimImageGeneration({ chatId: -1001, bypassCooldown: false });
    expect(buildImageReferenceBlock({ ctx: buildContext(), imageEnabled: true })).toBe(absent);
    expect(buildImageReferenceBlock({ ctx: buildContext(-1001, true), imageEnabled: true })).toBe(absent);

    const reference = buildImageReferenceBlock({ ctx: buildReferenceContext(), imageEnabled: true });
    expect(reference).toContain("参考图片素材");
    expect(reference).toContain("1600×900");
    expect(reference).toContain("默认使用最接近原素材的 16:9");
    expect(reference).toContain("不要向群友索要 URL");
  });

  test("本轮没挂生图工具时参考素材段整段不出现", () => {
    expect(buildImageReferenceBlock({
      ctx: buildContext(-1001, false, false),
      imageEnabled: false,
    })).toBe("");
  });

  test("冷却中在解析参数之前就返回提示，不请求模型", async () => {
    claimImageGeneration({ chatId: -1001, bypassCooldown: false });

    // 参数故意写坏：冷却闸排在参数解析之前，模型拿到的必须是「还要等多久」而不是一句
    // 参数错误——提示词里没有任何冷却状态，这条工具结果是它唯一的告知渠道。
    const result = JSON.parse(await buildExecutor(buildContext())(JSON.stringify({ prompt: "" })));

    expect(result.error).toBe("Image generation is cooling down in this chat");
    expect(result.retry_after_seconds).toBeGreaterThan(0);
    expect(result.retryable).toBe(false);
    expect(result.required_action).toContain("send_message");
    expect(generateChatImage).not.toHaveBeenCalled();
  });

  test("不是直接回复/@ 的触发由执行侧拒绝，且不消耗冷却", async () => {
    const deniedContext: ReplyToolContext = buildContext(-1001, false, false);
    const denied = buildExecutor(deniedContext);

    const result = JSON.parse(await denied(JSON.stringify({ prompt: "自行发挥画一张图" })));

    expect(result.error).toContain("not authorized");
    expect(result.retryable).toBe(false);
    expect(generateChatImage).not.toHaveBeenCalled();
    expect(deniedContext.chatAction.set).not.toHaveBeenCalled();
    expect(JSON.parse(await buildExecutor(buildContext(-1001))(JSON.stringify({ prompt: "明确请求" }))).success).toBe(true);
  });

  test("归一化比例、回复触发消息并登记滚动记忆", async () => {
    const ctx: ReplyToolContext = buildContext();
    const execute = buildExecutor(ctx);

    const result = JSON.parse(await execute(JSON.stringify({ prompt: "  日落下的纸飞机  ", aspect_ratio: "7:5" })));

    // 不再上报 resolution：那个 "1K" 是 Gemini 生图模型的专属档位；oai 兼容侧
    // 可能走 OpenAI size，也可能走 xAI aspect_ratio / resolution。
    expect(result).toEqual({ success: true, message_id: 77, aspect_ratio: "4:3", actions_used: 1 });
    expect(generateChatImage).toHaveBeenCalledWith({
      prompt: "日落下的纸飞机",
      aspectRatio: "4:3",
      referenceImage: undefined,
      signal: undefined,
    });
    expect(sendPhotoWithResult).toHaveBeenCalledWith({
      chatId: -1001,
      bytes: generatedBytes,
      mimeType: "image/png",
      replyToMessageId: 42,
      messageThreadId: undefined,
    });
    // 图片请求固定指向触发消息，服务端实际挂上后自录回调才带回复目标。
    expect(ctx.onImageSent).toHaveBeenCalledWith("（生成并发送了一张图片：日落下的纸飞机）", 77, 42);
  });

  test("参考图按需从 Telegram 下载并以内联图片交给生图模型", async () => {
    const ctx: ReplyToolContext = buildReferenceContext();

    const result = JSON.parse(await buildExecutor(ctx)(JSON.stringify({ prompt: "把原图改成油画" })));

    expect(downloadTelegramVisionImage).toHaveBeenCalledWith({
      fileId: "reference-file",
      logLabel: "image generation reference",
    });
    expect(runMediaTask).toHaveBeenCalledTimes(1);
    expect(generateChatImage).toHaveBeenCalledWith({
      prompt: "把原图改成油画",
      aspectRatio: "16:9",
      referenceImage: referenceVisionImage,
      signal: undefined,
    });
    expect(result.aspect_ratio).toBe("16:9");
    expect(result.reference_image_used).toBe(true);
    expect(ctx.onImageSent).toHaveBeenCalledWith("（参考素材生成并发送了一张图片：把原图改成油画）", 77, 42);
  });

  test("参考图下显式比例仍优先，非官方比例照常归一化", async () => {
    const ctx: ReplyToolContext = buildReferenceContext();

    const result = JSON.parse(await buildExecutor(ctx)(JSON.stringify({
      prompt: "把原图改成油画",
      aspect_ratio: "7:5",
    })));

    expect(result.aspect_ratio).toBe("4:3");
    expect(generateChatImage).toHaveBeenCalledWith({
      prompt: "把原图改成油画",
      aspectRatio: "4:3",
      referenceImage: referenceVisionImage,
      signal: undefined,
    });
  });

  test("参考图下载失败时不调用图片模型，也会收起正在发送图片状态", async () => {
    downloadTelegramVisionImage.mockResolvedValueOnce(null);
    const ctx: ReplyToolContext = buildReferenceContext(-1001, true);

    const result = JSON.parse(await buildExecutor(ctx)(JSON.stringify({ prompt: "无法读取原图" })));

    expect(result.error).toContain("reference image");
    expect(generateChatImage).not.toHaveBeenCalled();
    expect(ctx.chatAction.set).toHaveBeenNthCalledWith(1, "upload_photo");
    expect(ctx.chatAction.set).toHaveBeenNthCalledWith(2, "idle");
    expect(ctx.chatAction.settle).toHaveBeenCalledTimes(1);
  });

  test("共享媒体预算已满时不启动参考图下载，并按素材不可用降级", async () => {
    runMediaTask.mockResolvedValueOnce(undefined);
    const ctx: ReplyToolContext = buildReferenceContext(-1001, true);

    const result = JSON.parse(await buildExecutor(ctx)(JSON.stringify({ prompt: "队列已满" })));

    expect(result.error).toContain("reference image");
    expect(downloadTelegramVisionImage).not.toHaveBeenCalled();
    expect(generateChatImage).not.toHaveBeenCalled();
  });

  test("参考图前置阶段失败时回滚群冷却，本轮仍保留接纳限额", async () => {
    runMediaTask.mockResolvedValueOnce(undefined);
    const execute = buildExecutor(buildReferenceContext());

    const failed = JSON.parse(await execute(JSON.stringify({ prompt: "队列暂时已满" })));
    const retried = JSON.parse(await execute(JSON.stringify({ prompt: "立即重试" })));

    expect(failed.error).toContain("reference image");
    expect(retried.error).toContain("Image limit reached");
    expect(generateChatImage).not.toHaveBeenCalled();
  });

  test("Telegram 发送失败不登记图片记忆", async () => {
    sendPhotoWithResult.mockResolvedValueOnce(undefined);
    const ctx: ReplyToolContext = buildContext();

    const result = JSON.parse(await buildExecutor(ctx)(JSON.stringify({ prompt: "无法发送的图" })));

    expect(result.error).toContain("Failed to send");
    expect(ctx.onImageSent).not.toHaveBeenCalled();
    const retry = JSON.parse(await buildExecutor(buildContext())(JSON.stringify({ prompt: "不能立即再生成" })));
    expect(retry.error).toContain("cooling down");
  });

  test("Telegram 退化为无回复发送时不伪造图片回复关系", async () => {
    sendPhotoWithResult.mockResolvedValueOnce({ messageId: 77 });
    const ctx: ReplyToolContext = buildContext();

    const result = JSON.parse(await buildExecutor(ctx)(JSON.stringify({ prompt: "回复目标已删除" })));

    expect(result.success).toBe(true);
    expect(ctx.onImageSent).toHaveBeenCalledWith("（生成并发送了一张图片：回复目标已删除）", 77, undefined);
  });

  test("图注随图作为同一条消息发出，并合并进同一条自录", async () => {
    const ctx: ReplyToolContext = buildContext();
    const state: RoundMessageState = createRoundMessageState();

    const result = JSON.parse(await buildExecutor(ctx, state)(JSON.stringify({
      prompt: "日落下的纸飞机",
      caption: "  照着你说的画了一张  ",
    })));

    expect(result.success).toBe(true);
    expect(result.caption_delivery).toBe("inline");
    expect(result.actions_used).toBe(1);
    expect(sendPhotoWithResult).toHaveBeenCalledWith({
      chatId: -1001,
      bytes: generatedBytes,
      mimeType: "image/png",
      replyToMessageId: 42,
      messageThreadId: undefined,
      caption: "照着你说的画了一张",
    });
    // 一条消息只留一条自录：图记号和图注拼在同一个 message_id 上。
    expect(ctx.onImageSent).toHaveBeenCalledWith("（生成并发送了一张图片：日落下的纸飞机）照着你说的画了一张", 77, 42);
    expect(ctx.onMessageSent).not.toHaveBeenCalled();
    expect(sendMessageWithResult).not.toHaveBeenCalled();
    // 图注计入本轮已说过的话，模型随后复述会被 send_message 的去重拦下。
    expect(state.acceptedCanonicalTexts.has("照着你说的画了一张")).toBe(true);
  });

  test("超过 caption 上限时降级成图片加独立文本两条消息，并结算两个动作", async () => {
    const ctx: ReplyToolContext = buildContext();
    const state: RoundMessageState = createRoundMessageState();
    const longCaption: string = "长".repeat(1025);

    const result = JSON.parse(await buildExecutor(ctx, state)(JSON.stringify({
      prompt: "超长图注",
      caption: longCaption,
    })));

    expect(result.success).toBe(true);
    expect(result.caption_delivery).toBe("separate_message");
    expect(result.actions_used).toBe(2);
    // 图先按无图注发出，绝不把超长正文塞给 Bot API。
    expect(sendPhotoWithResult).toHaveBeenCalledWith({
      chatId: -1001,
      bytes: generatedBytes,
      mimeType: "image/png",
      replyToMessageId: 42,
      messageThreadId: undefined,
    });
    expect(sendMessageWithResult).toHaveBeenCalledWith({
      chatId: -1001,
      text: longCaption,
      replyToMessageId: 42,
      messageThreadId: undefined,
      signal: undefined,
    });
    expect(ctx.onImageSent).toHaveBeenCalledWith("（生成并发送了一张图片：超长图注）", 77, 42);
    expect(ctx.onMessageSent).toHaveBeenCalledWith(longCaption, 78, 42);
    expect(state.acceptedCanonicalTexts.has(longCaption)).toBe(true);
  });

  test("整轮只剩一个动作预算时不补发超长图注，图照发，硬顶不被顶破", async () => {
    // 编排器的门禁只判断「还有没有额度开始这次调用」；这条补发若照发，一次
    // 调用就会返回 actions_used: 2 把整轮顶过 HARD_MAX_ACTIONS_PER_REPLY，而
    // 那个数正是工具错误文案对模型承诺的硬顶。丢图注不丢图：图才是主体。
    const ctx: ReplyToolContext = buildContext();
    const state: RoundMessageState = createRoundMessageState();
    const longCaption: string = "长".repeat(1025);

    const result = JSON.parse(await buildExecutor(ctx, state, HARD_MAX_ACTIONS_PER_REPLY - 1)(JSON.stringify({
      prompt: "超长图注",
      caption: longCaption,
    })));

    expect(result.success).toBe(true);
    expect(result.actions_used).toBe(1);
    expect(result.caption_delivery).toBe("no_action_budget");
    expect(sendPhotoWithResult).toHaveBeenCalledTimes(1);
    expect(sendMessageWithResult).not.toHaveBeenCalled();
  });

  test("发图失败时的错误不可重试：冷却已被这次真实模型请求占掉", async () => {
    // 认领不释放（modelRequestStarted 已为真）却返回可重试错误，模型同轮重试
    // 必然撞上自家冷却闸，那条分支的 required_action 会逼机器人向群里播报
    // 「暂时不能使用生图」——群里根本没收到过任何图，那句话是假的。
    sendPhotoWithResult.mockImplementationOnce(async (): Promise<undefined> => undefined);

    const result = JSON.parse(await buildExecutor(buildContext())(JSON.stringify({ prompt: "发不出去的图" })));

    expect(result.error).toContain("Failed to send generated image");
    expect(result.retryable).toBe(false);
  });

  test("正好落在 caption 上限上的图注仍挂在图上", async () => {
    const ctx: ReplyToolContext = buildContext();
    const exactCaption: string = "长".repeat(1024);

    const result = JSON.parse(await buildExecutor(ctx)(JSON.stringify({
      prompt: "边界图注",
      caption: exactCaption,
    })));

    expect(result.caption_delivery).toBe("inline");
    expect(result.actions_used).toBe(1);
    expect(sendPhotoWithResult.mock.calls[0]?.[0]).toMatchObject({ caption: exactCaption });
    expect(sendMessageWithResult).not.toHaveBeenCalled();
  });

  test("降级补发的文本发送失败时图片仍按成功结算，只计一个动作", async () => {
    sendMessageWithResult.mockResolvedValueOnce(undefined);
    const ctx: ReplyToolContext = buildContext();

    const result = JSON.parse(await buildExecutor(ctx)(JSON.stringify({
      prompt: "补发失败",
      caption: "长".repeat(1025),
    })));

    expect(result.success).toBe(true);
    expect(result.caption_delivery).toBe("failed");
    expect(result.actions_used).toBe(1);
    expect(ctx.onMessageSent).not.toHaveBeenCalled();
  });

  test("图注伪造动作记号在生图之前就被拒，不消耗冷却", async () => {
    const ctx: ReplyToolContext = buildContext();

    const result = JSON.parse(await buildExecutor(ctx)(JSON.stringify({
      prompt: "不该被生成",
      caption: "（生成并发送了一张图片：日落）",
    })));

    expect(result.error).toContain("must not narrate an action");
    expect(result.error).toContain("生成并发送了一张图片");
    expect(result.retryable).toBe(false);
    expect(generateChatImage).not.toHaveBeenCalled();
    // 冷却没被消耗：改掉图注可以立即重试。
    expect(JSON.parse(await buildExecutor(buildContext())(JSON.stringify({ prompt: "改好了" }))).success).toBe(true);
  });

  test("括号外提到动作记号的图注照常放行", async () => {
    const ctx: ReplyToolContext = buildContext();

    const result = JSON.parse(await buildExecutor(ctx)(JSON.stringify({
      prompt: "正常生成",
      caption: "你不是让我生成并发送了一张图片吗，喏",
    })));

    expect(result.caption_delivery).toBe("inline");
    expect(sendPhotoWithResult.mock.calls[0]?.[0]).toMatchObject({
      caption: "你不是让我生成并发送了一张图片吗，喏",
    });
  });

  test("图注与本轮已发消息相同时静默跳过，且不消耗冷却", async () => {
    const state: RoundMessageState = createRoundMessageState();
    state.acceptedCanonicalTexts.add("画好了");

    const result = JSON.parse(await buildExecutor(buildContext(), state)(JSON.stringify({
      prompt: "重复图注",
      caption: "画好了",
    })));

    expect(result).toEqual({ success: true, skipped: "duplicate", actions_used: 0 });
    expect(sendPhotoWithResult).not.toHaveBeenCalled();
    expect(generateChatImage).not.toHaveBeenCalled();
    expect(JSON.parse(await buildExecutor(buildContext())(JSON.stringify({ prompt: "换一句" }))).success).toBe(true);
  });

  test("图注里的可点击命令在生图与占冷却之前被拒绝", async () => {
    const result = JSON.parse(await buildExecutor(buildContext())(JSON.stringify({
      prompt: "不该被生成",
      caption: "请点击 /batch_kick",
    })));

    expect(result.error).toContain("slash command");
    expect(generateChatImage).not.toHaveBeenCalled();
    expect(JSON.parse(await buildExecutor(buildContext())(JSON.stringify({ prompt: "改好了" }))).success).toBe(true);
  });

  test("纯 emoji 图注照常放行，与 send_message 的纯 emoji 禁令无关", async () => {
    const result = JSON.parse(await buildExecutor(buildContext())(JSON.stringify({
      prompt: "配一个表情",
      caption: "😂",
    })));

    expect(result.caption_delivery).toBe("inline");
    expect(sendPhotoWithResult.mock.calls[0]?.[0]).toMatchObject({ caption: "😂" });
  });

  test("caption 类型不对按参数错误拒绝，null 与清洗后为空都按只发图处理", async () => {
    const wrongType = JSON.parse(await buildExecutor(buildContext())(JSON.stringify({
      prompt: "类型不对",
      caption: 123,
    })));
    expect(wrongType.error).toContain("caption must be a string");
    expect(generateChatImage).not.toHaveBeenCalled();

    // 模型把可选参数填成 null 很常见，不能因此整条调用报参数错误。各用一个群，
    // 避免前一次成功生图占掉后一次的群冷却。
    const explicitNull = JSON.parse(await buildExecutor(buildContext(-1002))(JSON.stringify({
      prompt: "显式 null",
      caption: null,
    })));
    expect(explicitNull.success).toBe(true);
    expect(explicitNull.caption_delivery).toBeUndefined();
    expect(sendPhotoWithResult.mock.calls[0]?.[0]).not.toHaveProperty("caption");

    const ctx: ReplyToolContext = buildContext(-1003);
    const blank = JSON.parse(await buildExecutor(ctx)(JSON.stringify({
      prompt: "空图注",
      caption: "   ",
    })));
    expect(blank.success).toBe(true);
    expect(blank.caption_delivery).toBeUndefined();
    expect(sendPhotoWithResult.mock.calls[1]?.[0]).not.toHaveProperty("caption");
    expect(ctx.onImageSent).toHaveBeenCalledWith("（生成并发送了一张图片：空图注）", 77, 42);
  });

  test("工具说明告诉模型图注与图同属一条消息、超长会被拆开", () => {
    const definition = buildGenerateImageToolDefinition();
    const schema = definition.parametersJsonSchema as {
      properties: { caption: { description: string; maxLength: number } };
      required: string[];
    };

    expect(definition.description).toContain("配图想说的话写进 caption");
    expect(definition.description).toContain("同一条消息");
    expect(schema.required).not.toContain("caption");
    expect(schema.properties.caption.description).toContain("1024 字以内");
    expect(schema.properties.caption.description).toContain("拆成");
    expect(schema.properties.caption.maxLength).toBe(4096);
  });

  test("实际生图期间显示正在发送图片，并在发送图片前切回 idle、等待状态收敛", async () => {
    const events: string[] = [];
    const ctx: ReplyToolContext = buildContext();
    ctx.chatAction.set = mock((phase: "idle" | "typing" | "upload_photo" | "choose_sticker"): void => {
      events.push(phase);
    });
    ctx.chatAction.settle = mock(async (): Promise<void> => {
      events.push("settled");
    });
    generateChatImage.mockImplementationOnce(async () => {
      events.push("generated");
      return { bytes: generatedBytes, mimeType: "image/png" };
    });
    sendPhotoWithResult.mockImplementationOnce(async () => {
      events.push("sent");
      return { messageId: 77, repliedToMessageId: 42 };
    });

    const result = JSON.parse(await buildExecutor(ctx)(JSON.stringify({ prompt: "显示状态" })));

    expect(result.success).toBe(true);
    expect(events).toEqual(["upload_photo", "generated", "idle", "settled", "sent"]);
  });

  test("生图失败时同样收起正在发送图片并等待状态收敛", async () => {
    const events: string[] = [];
    const ctx: ReplyToolContext = buildContext();
    ctx.chatAction.set = mock((phase: "idle" | "typing" | "upload_photo" | "choose_sticker"): void => {
      events.push(phase);
    });
    ctx.chatAction.settle = mock(async (): Promise<void> => {
      events.push("settled");
    });
    generateChatImage.mockImplementationOnce(async () => {
      events.push("failed");
      return null;
    });

    const result = JSON.parse(await buildExecutor(ctx)(JSON.stringify({ prompt: "失败也收状态" })));

    expect(result.error).toContain("failed");
    expect(events).toEqual(["upload_photo", "failed", "idle", "settled"]);
    expect(sendPhotoWithResult).not.toHaveBeenCalled();
  });

  test("普通用户同群第二次被拒绝，不同群独立放行", async () => {
    const first = buildExecutor(buildContext(-1001));
    const sameChat = buildExecutor(buildContext(-1001));
    const otherChat = buildExecutor(buildContext(-1002));

    expect(JSON.parse(await first(JSON.stringify({ prompt: "first" }))).success).toBe(true);
    const limited = JSON.parse(await sameChat(JSON.stringify({ prompt: "second" })));
    expect(limited.error).toContain("cooling down");
    expect(limited.retry_after_seconds).toBeGreaterThan(0);
    expect(limited.retryable).toBe(false);
    expect(limited.required_action).toContain("必须使用 send_message 明确告诉群友当前暂时不能使用生图");
    expect(limited.required_action).toContain("本轮不要再次调用 generate_image");
    expect(JSON.parse(await otherChat(JSON.stringify({ prompt: "third" }))).success).toBe(true);
    expect(generateChatImage).toHaveBeenCalledTimes(2);
  });

  test("失败尝试仍占冷却，superAdmin 绕过冷却但每轮仍只能成功发送一张", async () => {
    generateChatImage.mockResolvedValueOnce(null);
    const normal = buildExecutor(buildContext(-1001));
    expect(JSON.parse(await normal(JSON.stringify({ prompt: "failed" }))).error).toContain("failed");
    expect(JSON.parse(await normal(JSON.stringify({ prompt: "retry" }))).error).toContain("Image limit reached");

    const superAdmin = buildExecutor(buildContext(-1001, true));
    expect(JSON.parse(await superAdmin(JSON.stringify({ prompt: "admin one" }))).success).toBe(true);
    const limited = JSON.parse(await superAdmin(JSON.stringify({ prompt: "admin two" })));
    expect(limited.error).toContain("at most 1 generated image");
    expect(limited.retryable).toBe(false);
    expect(generateChatImage).toHaveBeenCalledTimes(2);
  });

  test("superAdmin 接纳一次后本轮不再生成，失败也不重投", async () => {
    generateChatImage
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const execute = buildExecutor(buildContext(-1001, true));

    expect(JSON.parse(await execute(JSON.stringify({ prompt: "fail one" }))).error).toContain("failed");
    expect(JSON.parse(await execute(JSON.stringify({ prompt: "fail two" }))).error).toContain("Image limit reached");
    const stopped = JSON.parse(await execute(JSON.stringify({ prompt: "must not call upstream" })));
    expect(stopped.error).toContain("Image limit reached");
    expect(stopped.retryable).toBe(false);
    expect(generateChatImage).toHaveBeenCalledTimes(1);
  });
});
