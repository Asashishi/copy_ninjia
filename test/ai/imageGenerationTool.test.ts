import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReplyToolContext } from "../../src/types/aiChat/replies";

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
const referenceVisionImage = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mime: "image/jpeg" as const };
const downloadTelegramVisionImage = mock(async (..._args: unknown[]): Promise<typeof referenceVisionImage | null> => referenceVisionImage);
const runMediaTask = mock(async <T>(task: () => Promise<T>): Promise<T | undefined> => await task());
const sendPhoto = mock(async (..._args: unknown[]): Promise<number | undefined> => 77);
const realImageGeneration = await import("../../src/ai/imageGeneration");
const realTelegram = await import("../../src/infra/telegram");

mock.module("../../src/ai/imageGeneration", () => ({
  ...realImageGeneration,
  generateChatImage,
  normalizeImageAspectRatio,
}));
mock.module("../../src/infra/telegram", () => ({ ...realTelegram, sendPhoto }));
mock.module("../../src/ai/telegramImage", () => ({ downloadTelegramVisionImage }));
mock.module("../../src/ai/mediaTaskRunner", () => ({ runMediaTask }));

const { buildGenerateImageToolDefinition, createGenerateImageExecutor } = await import("../../src/ai/tools/replyToolset/imageGeneration");
const { claimImageGeneration, resetImageGenerationCache } = await import("../../src/cache/aiChat/imageGeneration");

function buildContext(
  chatId: number = -1001,
  bypass: boolean = false,
  requested: boolean = true
): ReplyToolContext {
  return {
    chatId,
    replyToMessageId: 42,
    imageGenerationRequested: requested,
    bypassImageGenerationCooldown: bypass,
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
  sendPhoto.mockClear();
  sendPhoto.mockResolvedValue(77);
});

afterEach(() => {
  resetImageGenerationCache();
});

describe("generate_image 工具执行器", () => {
  test("动态工具说明告知模型当前是否可以生图", () => {
    expect(buildGenerateImageToolDefinition(buildContext()).description).toContain("当前状态：可以生图");

    const unauthorizedDescription = buildGenerateImageToolDefinition(buildContext(-1001, false, false)).description;
    expect(unauthorizedDescription).toContain("当前状态：不可生图");
    expect(unauthorizedDescription).toContain("不是直接回复或 @ 你的触发");
    expect(buildGenerateImageToolDefinition(buildContext()).description).toContain("由你判断当前消息是否明确要求");

    claimImageGeneration({ chatId: -1001, bypassCooldown: false });
    const coolingDescription = buildGenerateImageToolDefinition(buildContext()).description;
    expect(coolingDescription).toContain("当前状态：暂不可生图");
    expect(coolingDescription).toContain("本轮不要调用");
    expect(coolingDescription).toContain("必须用 send_message 明确告诉群友当前暂时不能使用生图");

    const superAdminDescription = buildGenerateImageToolDefinition(buildContext(-1001, true)).description;
    expect(superAdminDescription).toContain("当前状态：可以生图");
    expect(superAdminDescription).toContain("superAdmin");

    const referenceDescription = buildGenerateImageToolDefinition(buildReferenceContext()).description;
    expect(referenceDescription).toContain("参考图片素材");
    expect(referenceDescription).toContain("1600×900");
    expect(referenceDescription).toContain("默认使用最接近原素材的 16:9");
    expect(referenceDescription).toContain("不要向群友索要 URL");
  });

  test("不是直接回复/@ 的触发由执行侧拒绝，且不消耗冷却", async () => {
    const deniedContext: ReplyToolContext = buildContext(-1001, false, false);
    const denied = createGenerateImageExecutor(deniedContext);

    const result = JSON.parse(await denied(JSON.stringify({ prompt: "自行发挥画一张图" })));

    expect(result.error).toContain("not authorized");
    expect(result.retryable).toBe(false);
    expect(generateChatImage).not.toHaveBeenCalled();
    expect(deniedContext.chatAction.set).not.toHaveBeenCalled();
    expect(JSON.parse(await createGenerateImageExecutor(buildContext(-1001))(JSON.stringify({ prompt: "明确请求" }))).success).toBe(true);
  });

  test("归一化比例、回复触发消息并登记滚动记忆", async () => {
    const ctx: ReplyToolContext = buildContext();
    const execute = createGenerateImageExecutor(ctx);

    const result = JSON.parse(await execute(JSON.stringify({ prompt: "  日落下的纸飞机  ", aspect_ratio: "7:5" })));

    expect(result).toEqual({ success: true, message_id: 77, aspect_ratio: "4:3", resolution: "1K" });
    expect(generateChatImage).toHaveBeenCalledWith("日落下的纸飞机", "4:3");
    expect(sendPhoto).toHaveBeenCalledWith({
      chatId: -1001,
      bytes: generatedBytes,
      mimeType: "image/png",
      replyToMessageId: 42,
    });
    expect(ctx.onImageSent).toHaveBeenCalledWith("（生成并发送了一张图片：日落下的纸飞机）", 77);
  });

  test("参考图按需从 Telegram 下载并以内联图片交给生图模型", async () => {
    const ctx: ReplyToolContext = buildReferenceContext();

    const result = JSON.parse(await createGenerateImageExecutor(ctx)(JSON.stringify({ prompt: "把原图改成油画" })));

    expect(downloadTelegramVisionImage).toHaveBeenCalledWith({
      fileId: "reference-file",
      logLabel: "image generation reference",
    });
    expect(runMediaTask).toHaveBeenCalledTimes(1);
    expect(generateChatImage).toHaveBeenCalledWith("把原图改成油画", "16:9", referenceVisionImage);
    expect(result.aspect_ratio).toBe("16:9");
    expect(result.reference_image_used).toBe(true);
    expect(ctx.onImageSent).toHaveBeenCalledWith("（参考素材生成并发送了一张图片：把原图改成油画）", 77);
  });

  test("参考图下显式比例仍优先，非官方比例照常归一化", async () => {
    const ctx: ReplyToolContext = buildReferenceContext();

    const result = JSON.parse(await createGenerateImageExecutor(ctx)(JSON.stringify({
      prompt: "把原图改成油画",
      aspect_ratio: "7:5",
    })));

    expect(result.aspect_ratio).toBe("4:3");
    expect(generateChatImage).toHaveBeenCalledWith("把原图改成油画", "4:3", referenceVisionImage);
  });

  test("参考图下载失败时不调用图片模型，也会收起正在发送图片状态", async () => {
    downloadTelegramVisionImage.mockResolvedValueOnce(null);
    const ctx: ReplyToolContext = buildReferenceContext(-1001, true);

    const result = JSON.parse(await createGenerateImageExecutor(ctx)(JSON.stringify({ prompt: "无法读取原图" })));

    expect(result.error).toContain("reference image");
    expect(generateChatImage).not.toHaveBeenCalled();
    expect(ctx.chatAction.set).toHaveBeenNthCalledWith(1, "upload_photo");
    expect(ctx.chatAction.set).toHaveBeenNthCalledWith(2, "idle");
    expect(ctx.chatAction.settle).toHaveBeenCalledTimes(1);
  });

  test("共享媒体预算已满时不启动参考图下载，并按素材不可用降级", async () => {
    runMediaTask.mockResolvedValueOnce(undefined);
    const ctx: ReplyToolContext = buildReferenceContext(-1001, true);

    const result = JSON.parse(await createGenerateImageExecutor(ctx)(JSON.stringify({ prompt: "队列已满" })));

    expect(result.error).toContain("reference image");
    expect(downloadTelegramVisionImage).not.toHaveBeenCalled();
    expect(generateChatImage).not.toHaveBeenCalled();
  });

  test("Telegram 发送失败不登记图片记忆", async () => {
    sendPhoto.mockResolvedValueOnce(undefined);
    const ctx: ReplyToolContext = buildContext();

    const result = JSON.parse(await createGenerateImageExecutor(ctx)(JSON.stringify({ prompt: "无法发送的图" })));

    expect(result.error).toContain("Failed to send");
    expect(ctx.onImageSent).not.toHaveBeenCalled();
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
    sendPhoto.mockImplementationOnce(async () => {
      events.push("sent");
      return 77;
    });

    const result = JSON.parse(await createGenerateImageExecutor(ctx)(JSON.stringify({ prompt: "显示状态" })));

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

    const result = JSON.parse(await createGenerateImageExecutor(ctx)(JSON.stringify({ prompt: "失败也收状态" })));

    expect(result.error).toContain("failed");
    expect(events).toEqual(["upload_photo", "failed", "idle", "settled"]);
    expect(sendPhoto).not.toHaveBeenCalled();
  });

  test("普通用户同群第二次被拒绝，不同群独立放行", async () => {
    const first = createGenerateImageExecutor(buildContext(-1001));
    const sameChat = createGenerateImageExecutor(buildContext(-1001));
    const otherChat = createGenerateImageExecutor(buildContext(-1002));

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

  test("失败尝试仍占冷却，superAdmin 则可连续调用", async () => {
    generateChatImage.mockResolvedValueOnce(null);
    const normal = createGenerateImageExecutor(buildContext(-1001));
    expect(JSON.parse(await normal(JSON.stringify({ prompt: "failed" }))).error).toContain("failed");
    expect(JSON.parse(await normal(JSON.stringify({ prompt: "retry" }))).error).toContain("cooling down");

    const superAdmin = createGenerateImageExecutor(buildContext(-1001, true));
    expect(JSON.parse(await superAdmin(JSON.stringify({ prompt: "admin one" }))).success).toBe(true);
    expect(JSON.parse(await superAdmin(JSON.stringify({ prompt: "admin two" }))).success).toBe(true);
  });

  test("superAdmin 连续失败两次后本轮止损，成功会清零失败计数", async () => {
    generateChatImage
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ bytes: generatedBytes, mimeType: "image/png" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const execute = createGenerateImageExecutor(buildContext(-1001, true));

    expect(JSON.parse(await execute(JSON.stringify({ prompt: "fail one" }))).error).toContain("failed");
    expect(JSON.parse(await execute(JSON.stringify({ prompt: "success resets" }))).success).toBe(true);
    expect(JSON.parse(await execute(JSON.stringify({ prompt: "fail two" }))).error).toContain("failed");
    expect(JSON.parse(await execute(JSON.stringify({ prompt: "fail three" }))).error).toContain("failed");
    const stopped = JSON.parse(await execute(JSON.stringify({ prompt: "must not call upstream" })));
    expect(stopped.error).toContain("remainder of this reply");
    expect(stopped.retryable).toBe(false);
    expect(generateChatImage).toHaveBeenCalledTimes(4);
  });
});
