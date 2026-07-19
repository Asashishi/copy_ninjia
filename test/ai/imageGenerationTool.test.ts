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
  if (requested === "16:9") return "16:9" as const;
  return null;
});
const sendPhoto = mock(async (..._args: unknown[]): Promise<number | undefined> => 77);
const realImageGeneration = await import("../../src/ai/imageGeneration");
const realTelegram = await import("../../src/infra/telegram");

mock.module("../../src/ai/imageGeneration", () => ({
  ...realImageGeneration,
  generateChatImage,
  normalizeImageAspectRatio,
}));
mock.module("../../src/infra/telegram", () => ({ ...realTelegram, sendPhoto }));

const { buildGenerateImageToolDefinition, createGenerateImageExecutor } = await import("../../src/ai/tools/replyToolset/imageGeneration");
const { claimImageGeneration, resetImageGenerationCache } = await import("../../src/cache/aiChat/imageGeneration");

function buildContext(chatId: number = -1001, bypass: boolean = false, requested: boolean = true): ReplyToolContext {
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

beforeEach(() => {
  resetImageGenerationCache();
  generateChatImage.mockClear();
  generateChatImage.mockResolvedValue({ bytes: generatedBytes, mimeType: "image/png" });
  normalizeImageAspectRatio.mockClear();
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
    expect(unauthorizedDescription).toContain("没有直接向你明确要求");

    claimImageGeneration({ chatId: -1001, bypassCooldown: false });
    const coolingDescription = buildGenerateImageToolDefinition(buildContext()).description;
    expect(coolingDescription).toContain("当前状态：暂不可生图");
    expect(coolingDescription).toContain("本轮不要调用");

    const superAdminDescription = buildGenerateImageToolDefinition(buildContext(-1001, true)).description;
    expect(superAdminDescription).toContain("当前状态：可以生图");
    expect(superAdminDescription).toContain("superAdmin");
  });

  test("没有当前触发消息的明确授权时执行侧拒绝，且不消耗冷却", async () => {
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

  test("Telegram 发送失败不登记图片记忆", async () => {
    sendPhoto.mockResolvedValueOnce(undefined);
    const ctx: ReplyToolContext = buildContext();

    const result = JSON.parse(await createGenerateImageExecutor(ctx)(JSON.stringify({ prompt: "无法发送的图" })));

    expect(result.error).toContain("Failed to send");
    expect(ctx.onImageSent).not.toHaveBeenCalled();
  });

  test("实际生图期间显示正在输入，并在发送图片前切回 idle、等待状态收敛", async () => {
    const events: string[] = [];
    const ctx: ReplyToolContext = buildContext();
    ctx.chatAction.set = mock((phase: "idle" | "typing" | "choose_sticker"): void => {
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
    expect(events).toEqual(["typing", "generated", "idle", "settled", "sent"]);
  });

  test("生图失败时同样收起正在输入并等待状态收敛", async () => {
    const events: string[] = [];
    const ctx: ReplyToolContext = buildContext();
    ctx.chatAction.set = mock((phase: "idle" | "typing" | "choose_sticker"): void => {
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
    expect(events).toEqual(["typing", "failed", "idle", "settled"]);
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
